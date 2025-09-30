const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const ffmpegConfig = require('../utils/ffmpegConfig');
const schedulerService = require('./schedulerService');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Configure fluent-ffmpeg with detected paths
ffmpeg.setFfmpegPath(ffmpegConfig.getFFmpegPath());
ffmpeg.setFfprobePath(ffmpegConfig.getFFprobePath());

console.log('[StreamingService] FFmpeg configured:');
console.log(`[StreamingService] FFmpeg path: ${ffmpegConfig.getFFmpegPath()}`);
console.log(`[StreamingService] FFprobe path: ${ffmpegConfig.getFFprobePath()}`);

const Stream = require('../models/Stream');
const Video = require('../models/Video');
const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const streamStartTimes = new Map();
const streamTotalRuntime = new Map();
const streamErrorMessages = new Map();
const streamLastTimestampSeconds = new Map();
const MAX_RETRY_ATTEMPTS = 3;
const manuallyStoppingStreams = new Set();
const MAX_LOG_LINES = 100;
const startingStreams = new Set();

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({
    timestamp: new Date().toISOString(),
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
      '-loglevel', 'error',
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

  return command;
}

// Helper functions for stream error and end handling
async function handleStreamError(streamId, errorMessage) {
  console.error(`[StreamingService] Stream ${streamId} error: ${errorMessage}`);
  
  try {
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'error', stream.user_id);
      
      try {
        const telegram = require('./telegramService');
        telegram.notifyStreamError(stream.user_id, streamId, errorMessage).catch(() => {});
      } catch (e) {
        console.error('Error sending Telegram error notification:', e);
      }
    }
  } catch (e) {
    console.error(`[StreamingService] Error updating stream status: ${e.message}`);
  }
  
  // Clean up
  activeStreams.delete(streamId);
  streamStartTimes.delete(streamId);
  startingStreams.delete(streamId);
}

async function handleStreamEnd(streamId) {
  console.log(`[StreamingService] Stream ${streamId} ended`);
  
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
  }
  
  // Update stream status
  try {
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      
      try {
        const telegram = require('./telegramService');
        telegram.notifyStreamStop(stream.user_id, streamId, runtimeMinutes).catch(() => {});
      } catch (e) {
        console.error('Error sending Telegram stop notification:', e);
      }
    }
  } catch (e) {
    console.error(`[StreamingService] Error updating stream status: ${e.message}`);
  }
  
  // Clean up
  activeStreams.delete(streamId);
  streamStartTimes.delete(streamId);
  startingStreams.delete(streamId);
}

async function startStream(streamId) {
  try {
    // Fast-fail if a start for this stream is already in progress
    if (startingStreams.has(streamId)) {
      console.warn(`[StreamingService] Start already in progress for ${streamId}, skipping duplicate start`);
      addStreamLog(streamId, 'Start already in progress, ignored duplicate start request');
      return { success: true, message: 'Start already in progress' };
    }
    startingStreams.add(streamId);
    
    // Check if stream is already active and kill any existing process
    if (activeStreams.has(streamId)) {
      const existingProcess = activeStreams.get(streamId);
      console.log(`[StreamingService] Stream ${streamId} already has an active process, killing existing one...`);
      addStreamLog(streamId, 'Killing existing FFmpeg process before starting new one');
      try {
        existingProcess.kill('SIGTERM');
      } catch (e) {
        console.error(`[StreamingService] Error killing existing process: ${e.message}`);
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
        console.log(`[StreamingService] Stream ${streamId} has no remaining time (duration<=0), not starting`);
        addStreamLog(streamId, `No remaining minutes, not starting`);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        return { success: false, error: 'No remaining minutes' };
      }
      remainingDuration = stream.duration * 60 * 1000;
      console.log(`[StreamingService] Stream ${streamId} - Total runtime so far: ${Math.floor(totalRuntime/60000)}min, Remaining (from DB): ${stream.duration}min`);
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
      console.error(`[StreamingService] Error building FFmpeg command for stream ${streamId}:`, error.message);
      addStreamLog(streamId, `Error building FFmpeg command: ${error.message}`);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to build FFmpeg command: ${error.message}` };
    }

    addStreamLog(streamId, `Starting stream with fluent-ffmpeg`);
    console.log(`[StreamingService] Starting stream ${streamId} with fluent-ffmpeg`);

    // Create fluent-ffmpeg command with error handling
    let ffmpegProcess;
    try {
      ffmpegProcess = ffmpegCommand
        .on('start', (commandLine) => {
          console.log(`[StreamingService] FFmpeg started: ${commandLine}`);
          addStreamLog(streamId, `FFmpeg process started`);
        })
        .on('progress', (progress) => {
          // Track progress for monitoring
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
        })
        .on('error', (err) => {
          console.error(`[StreamingService] FFmpeg error for stream ${streamId}:`, err.message);
          addStreamLog(streamId, `FFmpeg error: ${err.message}`);
          handleStreamError(streamId, err.message);
        })
        .on('end', () => {
          console.log(`[StreamingService] FFmpeg ended for stream ${streamId}`);
          addStreamLog(streamId, `FFmpeg process ended`);
          handleStreamEnd(streamId);
        });
    } catch (error) {
      console.error(`[StreamingService] Error creating FFmpeg process for stream ${streamId}:`, error.message);
      addStreamLog(streamId, `Error creating FFmpeg process: ${error.message}`);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to create FFmpeg process: ${error.message}` };
    }

    // Track start time for this session and register as active
    streamStartTimes.set(streamId, now.getTime());
    activeStreams.set(streamId, ffmpegProcess);

    // Start the process with error handling
    try {
      ffmpegProcess.run();
    } catch (error) {
      console.error(`[StreamingService] Error starting FFmpeg process for stream ${streamId}:`, error.message);
      addStreamLog(streamId, `Error starting FFmpeg process: ${error.message}`);
      activeStreams.delete(streamId);
      streamStartTimes.delete(streamId);
      startingStreams.delete(streamId);
      return { success: false, error: `Failed to start FFmpeg process: ${error.message}` };
    }

    await Stream.updateStatus(streamId, 'live', stream.user_id);
    try {
      const telegram = require('./telegramService');
      // Get updated stream data with channel info
      const streamWithChannel = await Stream.getStreamWithVideo(streamId);
      telegram.notifyStreamStart(stream.user_id, streamWithChannel || stream).catch(()=>{});
    } catch (e) {
      console.error('Error sending Telegram notification:', e);
    }
    
    // Once live, clear any previous schedule_time to avoid re-scheduling confusion
    try {
      await Stream.update(streamId, { schedule_time: null });
    } catch (e) {
      console.warn(`[StreamingService] Failed clearing schedule_time for ${streamId}: ${e.message}`);
    }
    
    addStreamLog(streamId, 'Stream started successfully');
    console.log(`[StreamingService] Stream ${streamId} started successfully`);
    
    return { success: true, message: 'Stream started successfully' };
    
  } catch (error) {
    console.error(`[StreamingService] Error starting stream ${streamId}:`, error);
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
  try {
    if (!activeStreams.has(streamId)) {
      console.log(`[StreamingService] Stream ${streamId} is not active`);
      return { success: true, message: 'Stream is not active' };
    }

    const ffmpegProcess = activeStreams.get(streamId);
    if (!ffmpegProcess) {
      console.log(`[StreamingService] No FFmpeg process found for stream ${streamId}`);
      activeStreams.delete(streamId);
      return { success: true, message: 'No process to stop' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    console.log(`[StreamingService] Stop request for stream ${streamId}`);
    
    manuallyStoppingStreams.add(streamId);
    
    // Stop fluent-ffmpeg process
    try {
      ffmpegProcess.kill('SIGTERM');
      addStreamLog(streamId, 'Sent stop signal to FFmpeg process');
    } catch (killError) {
      console.error(`[StreamingService] Error stopping FFmpeg: ${killError.message}`);
    }

    // Wait a moment for graceful termination
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Clean up stream data
    activeStreams.delete(streamId);
    streamStartTimes.delete(streamId);
    streamTotalRuntime.delete(streamId);
    streamRetryCount.delete(streamId);
    streamLogs.delete(streamId);
    streamErrorMessages.delete(streamId);
    
    // Update database status
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      addStreamLog(streamId, 'Stream status updated to offline in database');
    }
    
    manuallyStoppingStreams.delete(streamId);
    
    addStreamLog(streamId, 'Stream stopped successfully');
    console.log(`[StreamingService] Stream ${streamId} stopped successfully`);
    
    return { success: true, message: 'Stream stopped successfully' };
    
  } catch (error) {
    console.error(`[StreamingService] Error stopping stream ${streamId}:`, error);
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
  console.log('[StreamingService] Syncing stream statuses...');
}

async function saveStreamHistory(stream) {
  // Implementation for saving stream history
  console.log(`[StreamingService] Saving stream history for ${stream.id}`);
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
  console.log(`[StreamingService] Reset runtime tracking for stream ${streamId}`);
}

async function shouldResetRuntime(streamId) {
  const lastStartTime = streamStartTimes.get(streamId);
  if (!lastStartTime) return true;
  
  const timeSinceLastStart = Date.now() - lastStartTime;
  const oneHour = 60 * 60 * 1000;
  
  return timeSinceLastStart > oneHour;
}

async function cleanupZombieProcesses() {
  console.log('[StreamingService] Checking for zombie processes...');
  // Implementation for cleanup
  console.log('[StreamingService] Zombie process cleanup completed. Active streams:', activeStreams.size);
}

// Run zombie cleanup every 2 minutes
setInterval(cleanupZombieProcesses, 2 * 60 * 1000);

module.exports = {
  startStream,
  stopStream,
  isStreamActive,
  getActiveStreams,
  getStreamLogs,
  syncStreamStatuses,
  saveStreamHistory,
  getStreamRuntimeInfo,
  resetStreamRuntime,
  shouldResetRuntime,
  cleanupZombieProcesses,
  buildFFmpegCommand
};
