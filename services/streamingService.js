const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

console.log('[StreamingService] Module loaded successfully');
const ffmpegConfig = require('../utils/ffmpegConfig');
const schedulerService = require('./schedulerService');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Configure fluent-ffmpeg with detected paths
ffmpeg.setFfmpegPath(ffmpegConfig.getFFmpegPath());
ffmpeg.setFfprobePath(ffmpegConfig.getFFprobePath());

// FFmpeg configured

const Stream = require('../models/Stream');
const Video = require('../models/Video');
const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const streamStartTimes = new Map();
const streamTotalRuntime = new Map();
const streamErrorMessages = new Map();
const streamLastTimestampSeconds = new Map();
const streamProgressLogTime = new Map();
const MAX_RETRY_ATTEMPTS = 3;
const manuallyStoppingStreams = new Set();
const MAX_LOG_LINES = 100;
const startingStreams = new Set();

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', { 
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  logs.push({
    timestamp,
    message
  });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}

async function getVideoDurationSeconds(videoPath) {
  return await new Promise((resolve) => {
    try {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error(`[StreamingService] Error getting video duration for ${videoPath}:`, err.message);
          resolve(null);
          return;
        }
        
        const duration = metadata.format.duration;
        if (duration && Number.isFinite(duration)) {
          const secs = Math.max(0, Math.floor(duration));
          resolve(secs);
        } else {
          resolve(null);
        }
      });
    } catch (error) {
      console.error(`[StreamingService] Error in getVideoDurationSeconds:`, error.message);
      resolve(null);
    }
  });
}

async function buildFFmpegCommand(stream, seekSeconds) {
  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error(`Video record not found in database for video_id: ${stream.video_id}`);
  }
  const relativeVideoPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relativeVideoPath);
  if (!fs.existsSync(videoPath)) {
    console.error(`[StreamingService] CRITICAL: Video file not found on disk.`);
    console.error(`[StreamingService] Checked path: ${videoPath}`);
    throw new Error('Video file not found on disk. Please check paths and file existence.');
  }
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  
  // Debug logging
  console.log(`[StreamingService] Creating FFmpeg command for video: ${videoPath}`);
  console.log(`[StreamingService] RTMP URL: ${rtmpUrl}`);
  console.log(`[StreamingService] Stream Key: ${stream.stream_key}`);
  console.log(`[StreamingService] Platform: ${stream.platform}`);
  console.log(`[StreamingService] Loop video: ${stream.loop_video}`);
  console.log(`[StreamingService] Advanced settings: ${stream.use_advanced_settings}`);

  // Determine effective seek position
  let effectiveSeek = null;
  if (typeof seekSeconds === 'number' && seekSeconds > 0) {
    effectiveSeek = seekSeconds;
    if (stream.loop_video) {
      const durationSeconds = await getVideoDurationSeconds(videoPath);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        effectiveSeek = effectiveSeek % durationSeconds;
      }
    }
  }

  // Create fluent-ffmpeg command
  let command = ffmpeg(videoPath)
    .inputOptions([
      '-hwaccel', 'none',
      '-loglevel', 'info',
      '-re',
      '-fflags', '+genpts+igndts'
    ]);

  // Add seek position if needed
    if (effectiveSeek !== null) {
    command = command.seekInput(effectiveSeek);
  }

  // Add loop option
  if (stream.loop_video) {
    command = command.inputOptions(['-stream_loop', '-1']);
  } else {
    command = command.inputOptions(['-stream_loop', '0']);
  }

  // Configure output based on settings
  if (!stream.use_advanced_settings) {
    // Simple copy mode
    command = command
      .videoCodec('copy')
      .audioCodec('copy')
      .format('flv')
      .output(rtmpUrl);
  } else {
    // Advanced settings mode
  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;
    
    command = command
      .videoCodec('libx264')
      .addOptions([
    '-preset', 'veryfast',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate * 1.5}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-s', resolution,
        '-r', fps.toString()
      ])
      .audioCodec('aac')
      .audioBitrate('128k')
      .audioFrequency(44100)
      .format('flv')
      .output(rtmpUrl);
  }

  console.log(`[StreamingService] FFmpeg command built successfully`);
  console.log(`[StreamingService] Final RTMP URL: ${rtmpUrl}`);
  
  return command;
}

// Helper functions for stream error and end handling
async function handleStreamError(streamId, errorMessage) {
  addStreamLog(streamId, `Stream error: ${errorMessage}`);
  
  try {
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'error', stream.user_id);
      
      try {
        const telegram = require('./telegramService');
        telegram.notifyStreamError(stream.user_id, streamId, errorMessage).catch(() => {});
      } catch (e) {
        addStreamLog(streamId, `Error sending Telegram notification: ${e.message}`);
      }
    }
  } catch (e) {
    addStreamLog(streamId, `Error updating stream status: ${e.message}`);
  }
  
  // Clean up
  activeStreams.delete(streamId);
  streamStartTimes.delete(streamId);
  startingStreams.delete(streamId);
}

async function handleStreamEnd(streamId) {
  console.log(`[StreamingService] handleStreamEnd called for: ${streamId}`);
  addStreamLog(streamId, 'Stream ended');
  
  // Calculate runtime
  const startTime = streamStartTimes.get(streamId);
  const now = Date.now();
  let runtimeMinutes = 0;
  
  if (startTime) {
    const sessionRuntime = now - startTime;
    const totalRuntime = streamTotalRuntime.get(streamId) || 0;
    const newTotalRuntime = totalRuntime + sessionRuntime;
    streamTotalRuntime.set(streamId, newTotalRuntime);
    runtimeMinutes = Math.floor(newTotalRuntime / 60000);
    addStreamLog(streamId, `Session runtime: ${Math.floor(sessionRuntime/60000)}min, Total: ${runtimeMinutes}min`);
  }
  
  // Update stream status
  try {
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      // Update stop_time
      await Stream.updateStopTime(streamId, new Date().toISOString());
      
      try {
        const telegram = require('./telegramService');
        telegram.notifyStreamStop(stream.user_id, streamId, { runtimeMinutes }).catch(() => {});
      } catch (e) {
        addStreamLog(streamId, `Error sending Telegram stop notification: ${e.message}`);
      }
    }
  } catch (e) {
    addStreamLog(streamId, `Error updating stream status: ${e.message}`);
  }
  
  // Save to history if stream was running
  console.log(`[StreamingService] handleStreamEnd - Stream status before history check: ${stream ? stream.status : 'stream not found'}`);
  if (stream && stream.status === 'live') {
    try {
      console.log(`[StreamingService] handleStreamEnd - Saving stream to history: ${streamId}`);
      await saveStreamHistory(streamId);
      console.log(`[StreamingService] handleStreamEnd - Successfully saved stream to history: ${streamId}`);
    } catch (e) {
      console.error(`[StreamingService] handleStreamEnd - Error saving to history: ${e.message}`);
      addStreamLog(streamId, `Error saving to history: ${e.message}`);
    }
  } else {
    console.log(`[StreamingService] handleStreamEnd - Stream not saved to history - status: ${stream ? stream.status : 'not found'}`);
  }
  
  // Clean up
  activeStreams.delete(streamId);
  // Don't delete streamStartTimes to preserve runtime tracking
  startingStreams.delete(streamId);
}

async function startStream(streamId) {
  try {
    // Fast-fail if a start for this stream is already in progress
    if (startingStreams.has(streamId)) {
      addStreamLog(streamId, 'Start already in progress, ignored duplicate start request');
      return { success: true, message: 'Start already in progress' };
    }
    startingStreams.add(streamId);
    
    // Check if stream is already active and kill any existing process
    if (activeStreams.has(streamId)) {
      const existingProcess = activeStreams.get(streamId);
      addStreamLog(streamId, 'Killing existing FFmpeg process before starting new one');
      try {
        existingProcess.kill('SIGTERM');
      } catch (e) {
        addStreamLog(streamId, `Error killing existing process: ${e.message}`);
      }
      activeStreams.delete(streamId);
    }

    // Reset retry count for new start attempt
    streamRetryCount.set(streamId, 0);
    
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    // Track start time and calculate remaining duration
    const now = new Date();
    const totalRuntime = streamTotalRuntime.get(streamId) || 0;
    
    let remainingDuration = null;
    if (typeof stream.duration === 'number') {
      if (stream.duration <= 0) {
        addStreamLog(streamId, `No remaining minutes, not starting`);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        return { success: false, error: 'No remaining minutes' };
      }
      remainingDuration = stream.duration * 60 * 1000;
      addStreamLog(streamId, `Starting stream with ${stream.duration} minutes remaining`);
    }

    // Calculate seek offset using last precise timestamp if available, otherwise accumulated runtime
    const lastPts = streamLastTimestampSeconds.get(streamId);
    const seekSeconds = Number.isFinite(lastPts) && lastPts > 0
      ? Math.floor(lastPts)
      : (totalRuntime > 0 ? Math.floor(totalRuntime / 1000) : null);
    
    // Build FFmpeg command using fluent-ffmpeg
    let ffmpegCommand;
    try {
      ffmpegCommand = await buildFFmpegCommand(stream, seekSeconds);
      if (!ffmpegCommand) {
        throw new Error('Failed to build FFmpeg command');
      }
    } catch (error) {
      addStreamLog(streamId, `Error building FFmpeg command: ${error.message}`);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to build FFmpeg command: ${error.message}` };
    }

    addStreamLog(streamId, `Starting stream with fluent-ffmpeg`);

    // Create fluent-ffmpeg command with error handling
    let ffmpegProcess;
    try {
      ffmpegProcess = ffmpegCommand
        .on('start', (commandLine) => {
          console.log(`[StreamingService] FFmpeg command line: ${commandLine}`);
          addStreamLog(streamId, `FFmpeg process started`);
          addStreamLog(streamId, `Command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          // Track progress for monitoring (no console.log to prevent infinite loop)
          if (progress.timemark) {
            const timeMatch = progress.timemark.match(/(\d+):(\d+):(\d+\.?\d*)/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1]);
              const minutes = parseInt(timeMatch[2]);
              const seconds = parseFloat(timeMatch[3]);
              const totalSeconds = hours * 3600 + minutes * 60 + seconds;
              streamLastTimestampSeconds.set(streamId, totalSeconds);
            }
          }
          // Only log progress every 30 seconds to prevent spam
          const now = Date.now();
          const lastProgressLog = streamProgressLogTime.get(streamId) || 0;
          if (now - lastProgressLog > 30000) { // 30 seconds
            streamProgressLogTime.set(streamId, now);
            addStreamLog(streamId, `Progress: ${progress.timemark} (${progress.currentFps}fps, ${progress.currentKbps}kbps)`);
          }
        })
        .on('error', (err) => {
          // Don't treat SIGTERM as error - it's normal termination
          if (err.message && err.message.includes('SIGTERM')) {
            console.log(`[StreamingService] FFmpeg process terminated normally for stream ${streamId}`);
            addStreamLog(streamId, `FFmpeg process terminated normally`);
            handleStreamEnd(streamId);
            return;
          }
          
          console.error(`[StreamingService] FFmpeg error for stream ${streamId}:`, err);
          addStreamLog(streamId, `FFmpeg error: ${err.message}`);
          addStreamLog(streamId, `Error details: ${JSON.stringify(err)}`);
          handleStreamError(streamId, err.message);
        })
        .on('end', () => {
          console.log(`[StreamingService] FFmpeg process ended for stream ${streamId}`);
          addStreamLog(streamId, `FFmpeg process ended`);
          handleStreamEnd(streamId);
        })
        .on('stderr', (stderrLine) => {
          // Only log important stderr messages, not every line
          if (stderrLine.includes('error') || stderrLine.includes('Error') || stderrLine.includes('ERROR')) {
            console.log(`[StreamingService] FFmpeg stderr for stream ${streamId}: ${stderrLine}`);
            addStreamLog(streamId, `FFmpeg stderr: ${stderrLine}`);
          }
        });
    } catch (error) {
      addStreamLog(streamId, `Error creating FFmpeg process: ${error.message}`);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to create FFmpeg process: ${error.message}` };
    }

    // Track start time for this session and register as active
    streamStartTimes.set(streamId, now.getTime());
    activeStreams.set(streamId, ffmpegProcess);

    // Start the process with error handling
    try {
      console.log(`[StreamingService] Starting FFmpeg process for stream ${streamId}`);
      ffmpegProcess.run();
      
      // Add timeout to check if process is actually running
      setTimeout(() => {
        if (activeStreams.has(streamId)) {
          console.log(`[StreamingService] FFmpeg process is running for stream ${streamId}`);
          addStreamLog(streamId, `FFmpeg process confirmed running`);
        } else {
          console.error(`[StreamingService] FFmpeg process not found in active streams for ${streamId}`);
          addStreamLog(streamId, `FFmpeg process not found in active streams`);
        }
      }, 5000);
      
    } catch (error) {
      addStreamLog(streamId, `Error starting FFmpeg process: ${error.message}`);
      activeStreams.delete(streamId);
      streamStartTimes.delete(streamId);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to start FFmpeg process: ${error.message}` };
    }

    await Stream.updateStatus(streamId, 'live', stream.user_id);
    
    // Update exp_stop_time for manual streams (start_time + duration)
    // Only update for streams that have duration
    if (stream.duration && stream.duration > 0 && !stream.schedule_time) {
      const expStopTime = new Date(now.getTime() + (stream.duration * 60 * 1000)).toISOString();
      await Stream.updateExpStopTime(streamId, expStopTime);
      addStreamLog(streamId, `Updated exp_stop_time to: ${expStopTime}`);
    }
    
    try {
      const telegram = require('./telegramService');
      // Get updated stream data with channel info
      const streamWithChannel = await Stream.getStreamWithVideo(streamId);
      telegram.notifyStreamStart(stream.user_id, streamWithChannel || stream).catch(()=>{});
    } catch (e) {
      addStreamLog(streamId, `Error sending Telegram notification: ${e.message}`);
    }
    
    // Keep schedule_time for proper stop scheduling
    // Removed clearing schedule_time to allow proper stop scheduling
    
    addStreamLog(streamId, 'Stream started successfully');
    
    return { success: true, message: 'Stream started successfully' };
    
  } catch (error) {
    addStreamLog(streamId, `Start error: ${error.message}`);
    
    // Clean up maps
    activeStreams.delete(streamId);
    streamStartTimes.delete(streamId);
    startingStreams.delete(streamId);
    
    return { success: false, error: error.message };
  } finally {
    // Always remove from starting streams
    startingStreams.delete(streamId);
  }
}

async function stopStream(streamId) {
  console.log(`[StreamingService] stopStream called for: ${streamId}`);
  try {
    // Check if stream is active OR if it exists in database with live status
    const Stream = require('../models/Stream');
    const stream = await Stream.findById(streamId);
    const isActive = activeStreams.has(streamId);
    const isLiveInDB = stream && stream.status === 'live';
    
    console.log(`[StreamingService] Stream active in memory: ${isActive}, live in DB: ${isLiveInDB}`);
    
    if (!isActive && !isLiveInDB) {
      console.log(`[StreamingService] Stream ${streamId} is not active and not live in DB, returning early`);
      return { success: true, message: 'Stream is not active' };
    }

    const ffmpegProcess = activeStreams.get(streamId);
    if (!ffmpegProcess) {
      activeStreams.delete(streamId);
      return { success: true, message: 'No process to stop' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);
    
    // Stop fluent-ffmpeg process
    try {
      ffmpegProcess.kill('SIGTERM');
      addStreamLog(streamId, 'Sent stop signal to FFmpeg process');
    } catch (killError) {
      addStreamLog(streamId, `Error stopping FFmpeg: ${killError.message}`);
    }

    // Wait a moment for graceful termination
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Clean up stream data
    activeStreams.delete(streamId);
    // Don't delete streamStartTimes to preserve runtime tracking
    streamTotalRuntime.delete(streamId);
    streamRetryCount.delete(streamId);
    streamLogs.delete(streamId);
    streamErrorMessages.delete(streamId);
    
    // Update database status
    console.log(`[StreamingService] Updating database status for stream: ${streamId}`);
    if (stream) {
      console.log(`[StreamingService] Stream found in database: ${stream.title}, status: ${stream.status}`);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      // Update stop_time
      await Stream.updateStopTime(streamId, new Date().toISOString());
      addStreamLog(streamId, 'Stream status updated to offline in database');
      
      // Save to history if stream was running
      console.log(`[StreamingService] Stream status before history check: ${stream.status}`);
      if (stream.status === 'live') {
        try {
          console.log(`[StreamingService] Saving stream to history: ${streamId}`);
          await saveStreamHistory(streamId);
          addStreamLog(streamId, 'Stream saved to history');
          console.log(`[StreamingService] Successfully saved stream to history: ${streamId}`);
        } catch (e) {
          console.error(`[StreamingService] Error saving to history: ${e.message}`);
          addStreamLog(streamId, `Error saving to history: ${e.message}`);
        }
      } else {
        console.log(`[StreamingService] Stream not saved to history - status is '${stream.status}', not 'live'`);
      }
    } else {
      console.log(`[StreamingService] Stream not found in database: ${streamId}`);
    }
    
    manuallyStoppingStreams.delete(streamId);
    addStreamLog(streamId, 'Stream stopped successfully');
    
    return { success: true, message: 'Stream stopped successfully' };
    
  } catch (error) {
    addStreamLog(streamId, `Stop error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function isStreamActive(streamId) {
  return activeStreams.has(streamId);
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

async function syncStreamStatuses() {
  // Implementation for syncing stream statuses
  // console.log('[StreamingService] Syncing stream statuses...');
}

async function saveStreamHistory(streamId) {
  try {
    console.log(`[StreamingService] saveStreamHistory called for: ${streamId}`);
    const Stream = require('../models/Stream');
    const stream = await Stream.getStreamWithVideo(streamId);
    
    console.log(`[StreamingService] Stream data retrieved:`, stream ? 'Found' : 'Not found');
    if (!stream) {
      console.error(`[StreamingService] Stream not found for history: ${streamId}`);
      return;
    }

    const db = require('../db/database').db;
    const historyId = require('crypto').randomUUID();
    
    // Calculate actual duration in minutes
    let actualDuration = 0;
    if (stream.start_time && stream.end_time) {
      const startTime = new Date(stream.start_time);
      const endTime = new Date(stream.end_time);
      actualDuration = Math.floor((endTime - startTime) / 60000); // Convert to minutes
    }

    console.log(`[StreamingService] Inserting stream history with ID: ${historyId}`);
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration,
          use_advanced_settings, user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyId,
          stream.id,
          stream.title,
          stream.platform,
          stream.platform_icon,
          stream.video_id,
          stream.video_title,
          stream.resolution,
          stream.bitrate,
          stream.fps,
          stream.start_time,
          stream.end_time,
          actualDuration,
          stream.use_advanced_settings,
          stream.user_id,
          new Date().toISOString()
        ],
        function (err) {
          if (err) {
            console.error('Error saving stream history:', err.message);
            reject(err);
          } else {
            console.log(`[StreamingService] Stream history saved: ${stream.title} (${actualDuration}min)`);
            resolve(this);
          }
        }
      );
    });
  } catch (error) {
    console.error(`[StreamingService] Error saving stream history for ${streamId}:`, error);
  }
}

function getStreamRuntimeInfo(streamId) {
  const startTime = streamStartTimes.get(streamId);
  const totalRuntime = streamTotalRuntime.get(streamId) || 0;
  const now = Date.now();
  
  let sessionRuntime = 0;
  if (startTime) {
    sessionRuntime = now - startTime;
  }
  
  return {
    sessionRuntime,
    totalRuntime,
    sessionRuntimeMinutes: Math.floor(sessionRuntime / 60000),
    totalRuntimeMinutes: Math.floor(totalRuntime / 60000)
  };
}

function resetStreamRuntime(streamId) {
  streamTotalRuntime.delete(streamId);
        streamStartTimes.delete(streamId);
  streamLastTimestampSeconds.delete(streamId);
  // console.log(`[StreamingService] Reset runtime tracking for stream ${streamId}`);
}

async function shouldResetRuntime(streamId) {
  const lastStartTime = streamStartTimes.get(streamId);
  if (!lastStartTime) return true;
  
  const timeSinceLastStart = Date.now() - lastStartTime;
  const oneHour = 60 * 60 * 1000;
  
  return timeSinceLastStart > oneHour;
}

async function cleanupZombieProcesses() {
  // Implementation for cleanup
  // console.log('[StreamingService] Zombie process cleanup completed. Active streams:', activeStreams.size);
}

// Run zombie cleanup every 2 minutes
setInterval(cleanupZombieProcesses, 2 * 60 * 1000);

module.exports = {
  startStream,
  stopStream,
  isStreamActive,
  getActiveStreams,
  getStreamLogs,
  addStreamLog,
  syncStreamStatuses,
  saveStreamHistory,
  getStreamRuntimeInfo,
  resetStreamRuntime,
  shouldResetRuntime,
  cleanupZombieProcesses,
  buildFFmpegCommand
};
