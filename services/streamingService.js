const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const schedulerService = require('./schedulerService');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
  console.log('Using system FFmpeg at:', ffmpegPath);
} else {
  ffmpegPath = ffmpegInstaller.path;
  console.log('Using bundled FFmpeg at:', ffmpegPath);
}
const Stream = require('../models/Stream');
const Video = require('../models/Video');
const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const streamStartTimes = new Map(); // Track actual start time for each stream
const streamTotalRuntime = new Map(); // Track total runtime across restarts
const MAX_RETRY_ATTEMPTS = 3;
const manuallyStoppingStreams = new Set();
const MAX_LOG_LINES = 100;
// Guard to prevent concurrent startStream invocations for the same stream
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

// Function to check if a process is actually running
function isProcessRunning(process) {
  try {
    // On Windows, we need to check differently
    if (process.platform === 'win32') {
      // For Windows, we'll use a different approach
      return process.exitCode === null && !process.killed;
    } else {
      // On Unix-like systems, we can check the process
      return process.exitCode === null && !process.killed;
    }
  } catch (error) {
    return false;
  }
}

// Function to safely kill a process and wait for it to terminate
async function safeKillProcess(process, streamId) {
  return new Promise((resolve) => {
    if (!process || !isProcessRunning(process)) {
      resolve();
      return;
    }

    try {
      process.kill('SIGTERM');
      
      // Wait up to 5 seconds for graceful termination
      const timeout = setTimeout(() => {
        try {
          if (isProcessRunning(process)) {
            process.kill('SIGKILL');
            addStreamLog(streamId, 'Force killed FFmpeg process after timeout');
          }
        } catch (error) {
          addStreamLog(streamId, `Error force killing process: ${error.message}`);
        }
        resolve();
      }, 5000);

      process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    } catch (error) {
      addStreamLog(streamId, `Error killing process: ${error.message}`);
      resolve();
    }
  });
}

async function buildFFmpegArgs(stream) {
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
    console.error(`[StreamingService] stream.video_id: ${stream.video_id}`);
    console.error(`[StreamingService] video.filepath (from DB): ${video.filepath}`);
    console.error(`[StreamingService] Calculated relativeVideoPath: ${relativeVideoPath}`);
    console.error(`[StreamingService] process.cwd(): ${process.cwd()}`);
    throw new Error('Video file not found on disk. Please check paths and file existence.');
  }
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopOption = stream.loop_video ? '-stream_loop' : '-stream_loop 0';
  const loopValue = stream.loop_video ? '-1' : '0';
  if (!stream.use_advanced_settings) {
    return [
      '-hwaccel', 'none',
      '-loglevel', 'error',
      '-re',
      '-fflags', '+genpts+igndts',
      loopOption, loopValue,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'flv',
      rtmpUrl
    ];
  }
  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;
  return [
    '-hwaccel', 'none',
    '-loglevel', 'error',
    '-re',
    loopOption, loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate * 1.5}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-s', resolution,
    '-r', fps.toString(),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpUrl
  ];
}
async function startStream(streamId) {
  try {
    // Fast-fail if a start for this stream is already in progress
    if (startingStreams.has(streamId)) {
      console.warn(`[StreamingService] Start already in progress for ${streamId}, skipping duplicate start`);
      addStreamLog(streamId, 'Start already in progress, ignored duplicate start request');
      return { success: false, error: 'Start already in progress' };
    }
    startingStreams.add(streamId);
    
    // Check if stream is already active and kill any existing process
    if (activeStreams.has(streamId)) {
      const existingProcess = activeStreams.get(streamId);
      console.log(`[StreamingService] Stream ${streamId} already has an active process, killing existing one...`);
      addStreamLog(streamId, 'Killing existing FFmpeg process before starting new one');
      await safeKillProcess(existingProcess, streamId);
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
    const originalDuration = stream.duration ? stream.duration * 60 * 1000 : null; // Convert to milliseconds
    
    if (originalDuration && totalRuntime >= originalDuration) {
      console.log(`[StreamingService] Stream ${streamId} has already exceeded its total duration (${totalRuntime}ms >= ${originalDuration}ms)`);
      addStreamLog(streamId, `Stream exceeded total duration, not restarting`);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      return { success: false, error: 'Stream duration exceeded' };
    }

    // Calculate remaining duration
    let remainingDuration = null;
    if (originalDuration) {
      remainingDuration = Math.max(0, originalDuration - totalRuntime);
      console.log(`[StreamingService] Stream ${streamId} - Total runtime: ${Math.floor(totalRuntime/60000)}min, Remaining: ${Math.floor(remainingDuration/60000)}min`);
      addStreamLog(streamId, `Starting stream with ${Math.floor(remainingDuration/60000)} minutes remaining out of ${stream.duration} total`);
    }

    const ffmpegArgs = await buildFFmpegArgs(stream);
    const fullCommand = `${ffmpegPath} ${ffmpegArgs.join(' ')}`;
    addStreamLog(streamId, `Starting stream with command: ${fullCommand}`);
    console.log(`Starting stream: ${fullCommand}`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Add process exit event listener for proper cleanup
    ffmpegProcess.on('exit', (code, signal) => {
      console.log(`[StreamingService] FFmpeg process for stream ${streamId} exited with code ${code}, signal ${signal}`);
      
      // Only cleanup if this is still the current process for this stream
      if (activeStreams.get(streamId) === ffmpegProcess) {
        activeStreams.delete(streamId);
        streamStartTimes.delete(streamId);
        streamTotalRuntime.delete(streamId);
        streamRetryCount.delete(streamId);
        streamLogs.delete(streamId);
        manuallyStoppingStreams.delete(streamId);
        
        // Update database status if process exited unexpectedly
        if (code !== 0 && !manuallyStoppingStreams.has(streamId)) {
          Stream.updateStatus(streamId, 'offline', stream.user_id).then(() => {
            console.log(`[StreamingService] Updated stream ${streamId} status to offline due to unexpected exit`);
          }).catch(err => {
            console.error(`[StreamingService] Error updating stream status: ${err.message}`);
          });
        }
      }
    });

    // Add error event listener
    ffmpegProcess.on('error', (error) => {
      console.error(`[StreamingService] FFmpeg process error for stream ${streamId}:`, error);
      addStreamLog(streamId, `FFmpeg error: ${error.message}`);
    });

    // Track start time for this session
    streamStartTimes.set(streamId, now.getTime());
    activeStreams.set(streamId, ffmpegProcess);
    
    await Stream.updateStatus(streamId, 'live', stream.user_id);
    ffmpegProcess.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[OUTPUT] ${message}`);
        console.log(`[FFMPEG_STDOUT] ${streamId}: ${message}`);
      }
    });
    ffmpegProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        addStreamLog(streamId, `[FFmpeg] ${message}`);
        if (!message.includes('frame=')) {
          console.error(`[FFMPEG_STDERR] ${streamId}: ${message}`);
        }
      }
    });
    ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `Stream ended with code ${code}, signal: ${signal}`);
      console.log(`[FFMPEG_EXIT] ${streamId}: Code=${code}, Signal=${signal}`);
      
      // Calculate runtime for this session and add to total
      const sessionStartTime = streamStartTimes.get(streamId);
      if (sessionStartTime) {
        const sessionRuntime = Date.now() - sessionStartTime;
        const currentTotal = streamTotalRuntime.get(streamId) || 0;
        streamTotalRuntime.set(streamId, currentTotal + sessionRuntime);
        streamStartTimes.delete(streamId);
        
        console.log(`[StreamingService] Stream ${streamId} session runtime: ${Math.floor(sessionRuntime/60000)}min, Total runtime: ${Math.floor((currentTotal + sessionRuntime)/60000)}min`);
        addStreamLog(streamId, `Session runtime: ${Math.floor(sessionRuntime/60000)}min, Total runtime: ${Math.floor((currentTotal + sessionRuntime)/60000)}min`);
      }
      
      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);
      
      if (isManualStop) {
        console.log(`[StreamingService] Stream ${streamId} was manually stopped, not restarting`);
        manuallyStoppingStreams.delete(streamId);
        if (wasActive) {
          try {
            await Stream.updateStatus(streamId, 'offline');
            if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after manual stop: ${error.message}`);
          }
        }
        return;
      }

      // Check if stream has exceeded total duration
      const totalRuntime = streamTotalRuntime.get(streamId) || 0;
      const stream = await Stream.findById(streamId);
      if (stream && stream.duration) {
        const maxDurationMs = stream.duration * 60 * 1000;
        if (totalRuntime >= maxDurationMs) {
          console.log(`[StreamingService] Stream ${streamId} has exceeded total duration (${Math.floor(totalRuntime/60000)}min >= ${stream.duration}min), not restarting`);
          addStreamLog(streamId, `Stream exceeded total duration, not restarting`);
          try {
            await Stream.updateStatus(streamId, 'offline');
            if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after duration exceeded: ${error.message}`);
          }
          return;
        }
      }

      if (signal === 'SIGSEGV') {
        const retryCount = streamRetryCount.get(streamId) || 0;
        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          console.log(`[StreamingService] FFmpeg crashed with SIGSEGV. Attempting restart #${retryCount + 1} for stream ${streamId}`);
          addStreamLog(streamId, `FFmpeg crashed with SIGSEGV. Attempting restart #${retryCount + 1}`);
          setTimeout(async () => {
            try {
              const streamInfo = await Stream.findById(streamId);
              if (streamInfo) {
                const result = await startStream(streamId);
                if (!result.success) {
                  console.error(`[StreamingService] Failed to restart stream: ${result.error}`);
                  await Stream.updateStatus(streamId, 'offline');
                }
              } else {
                console.error(`[StreamingService] Cannot restart stream ${streamId}: not found in database`);
              }
            } catch (error) {
              console.error(`[StreamingService] Error during stream restart: ${error.message}`);
              try {
                await Stream.updateStatus(streamId, 'offline');
              } catch (dbError) {
                console.error(`Error updating stream status: ${dbError.message}`);
              }
            }
          }, 3000);
          return;
        } else {
          console.error(`[StreamingService] Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached for stream ${streamId}`);
          addStreamLog(streamId, `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached, stopping stream`);
        }
      }
      else {
        let errorMessage = '';
        if (code !== 0 && code !== null) {
          errorMessage = `FFmpeg process exited with error code ${code}`;
          addStreamLog(streamId, errorMessage);
          console.error(`[StreamingService] ${errorMessage} for stream ${streamId}`);
          const retryCount = streamRetryCount.get(streamId) || 0;
          if (retryCount < MAX_RETRY_ATTEMPTS) {
            streamRetryCount.set(streamId, retryCount + 1);
            console.log(`[StreamingService] FFmpeg exited with code ${code}. Attempting restart #${retryCount + 1} for stream ${streamId}`);
            setTimeout(async () => {
              try {
                const streamInfo = await Stream.findById(streamId);
                if (streamInfo) {
                  const result = await startStream(streamId);
                  if (!result.success) {
                    console.error(`[StreamingService] Failed to restart stream: ${result.error}`);
                    await Stream.updateStatus(streamId, 'offline');
                  }
                }
              } catch (error) {
                console.error(`[StreamingService] Error during stream restart: ${error.message}`);
                await Stream.updateStatus(streamId, 'offline');
              }
            }, 3000);
            return;
          }
        }
        if (wasActive) {
          try {
            console.log(`[StreamingService] Updating stream ${streamId} status to offline after FFmpeg exit`);
            await Stream.updateStatus(streamId, 'offline');
            if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after exit: ${error.message}`);
          }
        }
      }
    });
    ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Error in stream process: ${err.message}`);
      console.error(`[FFMPEG_PROCESS_ERROR] ${streamId}: ${err.message}`);
      activeStreams.delete(streamId);
      try {
        await Stream.updateStatus(streamId, 'offline');
      } catch (error) {
        console.error(`Error updating stream status: ${error.message}`);
      }
    });
    ffmpegProcess.unref();
    
    // Schedule termination with remaining duration instead of original duration
    if (remainingDuration && typeof schedulerService !== 'undefined') {
      const remainingMinutes = Math.ceil(remainingDuration / 60000);
      console.log(`[StreamingService] Scheduling stream ${streamId} termination after ${remainingMinutes} minutes (remaining)`);
      addStreamLog(streamId, `Scheduled termination after ${remainingMinutes} minutes (remaining)`);
      schedulerService.scheduleStreamTermination(streamId, remainingMinutes);
    } else if (stream.duration && typeof schedulerService !== 'undefined') {
      // Fallback to original duration if no remaining duration calculated
      schedulerService.scheduleStreamTermination(streamId, stream.duration);
    }
    
    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings,
      remainingDuration: remainingDuration ? Math.ceil(remainingDuration / 60000) : null
    };
  } catch (error) {
    addStreamLog(streamId, `Failed to start stream: ${error.message}`);
    console.error(`Error starting stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
  finally {
    // Ensure we always clear the starting flag
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
    console.log(`[StreamingService] Stop request for stream ${streamId}, isActive: ${isStreamActive(streamId)}`);
    
    manuallyStoppingStreams.add(streamId);
    
    // First try graceful termination
    try {
      ffmpegProcess.kill('SIGTERM');
      addStreamLog(streamId, 'Sent SIGTERM to FFmpeg process');
    } catch (killError) {
      console.error(`[StreamingService] Error sending SIGTERM: ${killError.message}`);
    }

    // Wait for graceful termination with timeout
    let processStopped = false;
    const maxWaitTime = 10000; // 10 seconds
    const checkInterval = 100; // Check every 100ms
    const startTime = Date.now();
    
    while (!processStopped && (Date.now() - startTime) < maxWaitTime) {
      if (!isProcessRunning(ffmpegProcess)) {
        processStopped = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    // If process is still running, force kill it
    if (!processStopped && isProcessRunning(ffmpegProcess)) {
      try {
        console.log(`[StreamingService] Force killing FFmpeg process for stream ${streamId}`);
        ffmpegProcess.kill('SIGKILL');
        addStreamLog(streamId, 'Force killed FFmpeg process with SIGKILL');
        
        // Wait a bit more for SIGKILL to take effect
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (forceKillError) {
        console.error(`[StreamingService] Error force killing process: ${forceKillError.message}`);
      }
    }
    
    // Clean up stream data
    activeStreams.delete(streamId);
    streamStartTimes.delete(streamId);
    streamTotalRuntime.delete(streamId);
    streamRetryCount.delete(streamId);
    streamLogs.delete(streamId);
    
    // Update database status
    const stream = await Stream.findById(streamId);
    if (stream) {
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
      const updatedStream = await Stream.findById(streamId);
      await saveStreamHistory(updatedStream);
      addStreamLog(streamId, 'Stream status updated to offline in database');
    }
    
    manuallyStoppingStreams.delete(streamId);
    
    // Notify scheduler
    if (typeof schedulerService !== 'undefined' && schedulerService.handleStreamStopped) {
      schedulerService.handleStreamStopped(streamId);
    }
    
    console.log(`[StreamingService] Successfully stopped stream ${streamId}`);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    console.error(`[StreamingService] Error stopping stream ${streamId}:`, error);
    return { success: false, error: error.message };
  }
}
async function syncStreamStatuses() {
  try {
    console.log('[StreamingService] Syncing stream statuses...');
    
    // Check streams marked as 'live' in DB but not active in memory
    const liveStreams = await Stream.findAll(null, 'live');
    for (const stream of liveStreams) {
      const isReallyActive = activeStreams.has(stream.id);
      if (!isReallyActive) {
        console.log(`[StreamingService] Found inconsistent stream ${stream.id}: marked as 'live' in DB but not active in memory`);
        
        // Check if this stream is currently being stopped
        if (manuallyStoppingStreams.has(stream.id)) {
          console.log(`[StreamingService] Stream ${stream.id} is currently being stopped, skipping status update`);
          continue;
        }
        
        // Update status to offline
        await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        console.log(`[StreamingService] Updated stream ${stream.id} status to 'offline'`);
        
        // Clean up any orphaned data
        streamStartTimes.delete(stream.id);
        streamTotalRuntime.delete(stream.id);
        streamRetryCount.delete(stream.id);
        streamLogs.delete(stream.id);
      }
    }
    
    // Check streams active in memory but not 'live' in DB
    const activeStreamIds = Array.from(activeStreams.keys());
    for (const streamId of activeStreamIds) {
      const stream = await Stream.findById(streamId);
      if (!stream || stream.status !== 'live') {
        console.log(`[StreamingService] Found inconsistent stream ${streamId}: active in memory but not 'live' in DB`);
        
        if (stream) {
          // Update DB status to match memory
          await Stream.updateStatus(streamId, 'live', stream.user_id);
          console.log(`[StreamingService] Updated stream ${streamId} status to 'live'`);
        } else {
          // Stream not found in DB, clean up memory
          console.log(`[StreamingService] Stream ${streamId} not found in DB, removing from active streams`);
          const process = activeStreams.get(streamId);
          if (process) {
            try {
              if (isProcessRunning(process)) {
                process.kill('SIGTERM');
                console.log(`[StreamingService] Sent SIGTERM to orphaned process for stream ${streamId}`);
                
                // Wait a bit then force kill if still running
                setTimeout(() => {
                  if (isProcessRunning(process)) {
                    try {
                      process.kill('SIGKILL');
                      console.log(`[StreamingService] Force killed orphaned process for stream ${streamId}`);
                    } catch (error) {
                      console.error(`[StreamingService] Error force killing orphaned process: ${error.message}`);
                    }
                  }
                }, 5000);
              }
            } catch (error) {
              console.error(`[StreamingService] Error killing orphaned process: ${error.message}`);
            }
          }
          
          // Clean up all data
          activeStreams.delete(streamId);
          streamStartTimes.delete(streamId);
          streamTotalRuntime.delete(streamId);
          streamRetryCount.delete(streamId);
          streamLogs.delete(streamId);
          manuallyStoppingStreams.delete(streamId);
        }
      }
    }
    
    // Clean up any streams that are stuck in manuallyStoppingStreams
    for (const streamId of manuallyStoppingStreams) {
      if (!activeStreams.has(streamId)) {
        console.log(`[StreamingService] Cleaning up stuck stopping flag for stream ${streamId}`);
        manuallyStoppingStreams.delete(streamId);
      }
    }
    
    console.log(`[StreamingService] Stream status sync completed. Active streams: ${activeStreamIds.length}, Stopping: ${manuallyStoppingStreams.size}`);
  } catch (error) {
    console.error('[StreamingService] Error syncing stream statuses:', error);
  }
}
setInterval(syncStreamStatuses, 5 * 60 * 1000);
function isStreamActive(streamId) {
  return activeStreams.has(streamId);
}
function getActiveStreams() {
  return Array.from(activeStreams.keys());
}
function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

// Function to get current stream runtime information
function getStreamRuntimeInfo(streamId) {
  const sessionStartTime = streamStartTimes.get(streamId);
  const totalRuntime = streamTotalRuntime.get(streamId) || 0;
  
  let currentSessionRuntime = 0;
  if (sessionStartTime) {
    currentSessionRuntime = Date.now() - sessionStartTime;
  }
  
  return {
    currentSessionRuntime,
    totalRuntime,
    currentSessionRuntimeMinutes: Math.floor(currentSessionRuntime / 60000),
    totalRuntimeMinutes: Math.floor(totalRuntime / 60000)
  };
}

// Function to reset stream runtime (useful for manual resets)
function resetStreamRuntime(streamId) {
  streamTotalRuntime.delete(streamId);
  streamStartTimes.delete(streamId);
  streamRetryCount.delete(streamId);
  console.log(`[StreamingService] Reset runtime tracking for stream ${streamId}`);
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - no start time recorded`);
      return false;
    }
    
    // Use tracked runtime if available, otherwise calculate from start/end times
    let durationSeconds = 0;
    const trackedRuntime = streamTotalRuntime.get(stream.id);
    
    if (trackedRuntime) {
      durationSeconds = Math.floor(trackedRuntime / 1000);
      console.log(`[StreamingService] Using tracked runtime for stream ${stream.id}: ${durationSeconds}s`);
    } else {
      const startTime = new Date(stream.start_time);
      const endTime = stream.end_time ? new Date(stream.end_time) : new Date();
      durationSeconds = Math.floor((endTime - startTime) / 1000);
    }
    
    if (durationSeconds < 1) {
      console.log(`[StreamingService] Not saving history for stream ${stream.id} - duration too short (${durationSeconds}s)`);
      return false;
    }
    
    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;
    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: stream.end_time || new Date().toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };
    
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            console.error('[StreamingService] Error saving stream history:', err.message);
            return reject(err);
          }
          console.log(`[StreamingService] Stream history saved for stream ${stream.id}, duration: ${durationSeconds}s`);
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    console.error('[StreamingService] Failed to save stream history:', error);
    return false;
  }
}

// Function to check for and clean up zombie processes
async function cleanupZombieProcesses() {
  try {
    console.log('[StreamingService] Checking for zombie processes...');
    const activeStreamIds = Array.from(activeStreams.keys());
    
    for (const streamId of activeStreamIds) {
      const process = activeStreams.get(streamId);
      if (process && !isProcessRunning(process)) {
        console.log(`[StreamingService] Found zombie process for stream ${streamId}, cleaning up...`);
        
        // Clean up memory
        activeStreams.delete(streamId);
        streamStartTimes.delete(streamId);
        streamTotalRuntime.delete(streamId);
        streamRetryCount.delete(streamId);
        streamLogs.delete(streamId);
        manuallyStoppingStreams.delete(streamId);
        
        // Update database status
        try {
          await Stream.updateStatus(streamId, 'offline');
          console.log(`[StreamingService] Updated zombie stream ${streamId} status to offline`);
        } catch (error) {
          console.error(`[StreamingService] Error updating zombie stream status: ${error.message}`);
        }
      }
    }
    
    console.log(`[StreamingService] Zombie process cleanup completed. Active streams: ${activeStreams.size}`);
  } catch (error) {
    console.error('[StreamingService] Error during zombie process cleanup:', error);
  }
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
  cleanupZombieProcesses
};
schedulerService.init(module.exports);
