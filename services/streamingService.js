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
const streamErrorMessages = new Map(); // Track error messages for better restart logic
const streamLastTimestampSeconds = new Map(); // Track last precise pts timestamp from FFmpeg
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

// Cache for video durations to avoid repeated probes
const videoDurationCache = new Map();

function parseFfprobeDuration(output) {
  // ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "file"
  const trimmed = (output || '').toString().trim();
  const seconds = parseFloat(trimmed);
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : null;
}

async function getVideoDurationSeconds(videoPath) {
  if (videoDurationCache.has(videoPath)) {
    return videoDurationCache.get(videoPath);
  }
  return await new Promise((resolve) => {
    try {
      const ffprobeCmd = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
      const probe = spawn(ffprobeCmd, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1',
        videoPath
      ]);
      let stdout = '';
      let stderr = '';
      probe.stdout.on('data', d => { stdout += d.toString(); });
      probe.stderr.on('data', d => { stderr += d.toString(); });
      probe.on('close', () => {
        const secs = parseFfprobeDuration(stdout);
        if (secs !== null) {
          videoDurationCache.set(videoPath, secs);
          resolve(secs);
        } else {
          resolve(null);
        }
      });
      probe.on('error', () => resolve(null));
    } catch (_) {
      resolve(null);
    }
  });
}

async function buildFFmpegArgs(stream, seekSeconds) {
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

  // Determine effective seek position
  let effectiveSeek = null;
  if (typeof seekSeconds === 'number' && seekSeconds > 0) {
    effectiveSeek = seekSeconds;
    if (stream.loop_video) {
      // If we can get duration, modulo it to resume within the loop
      const durationSeconds = await getVideoDurationSeconds(videoPath);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        effectiveSeek = effectiveSeek % durationSeconds;
      }
    }
  }
  if (!stream.use_advanced_settings) {
    const args = [
      '-re',
      loopOption, loopValue,
    ];
    if (effectiveSeek !== null) {
      args.push('-ss', effectiveSeek.toString());
    }
    args.push(
      '-i', videoPath,
'-c', 'copy', '-f', 'flv', '-loglevel', 'debug', '-nostats',
      rtmpUrl
    );
    return args;
  }
  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;
  const advArgs = [
    '-hwaccel', 'none',
    '-loglevel', 'error',
    '-re',
    loopOption, loopValue,
  ];
  if (effectiveSeek !== null) {
    advArgs.push('-ss', effectiveSeek.toString());
  }
  advArgs.push(
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
  );
  return advArgs;
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
      await safeKillProcess(existingProcess, streamId);
      activeStreams.delete(streamId);
    }

    // Reset retry count for new start attempt
    streamRetryCount.set(streamId, 0);
    
    // Check if we should reset runtime tracking (if stream has been offline for a while)
    if (await shouldResetRuntime(streamId)) {
      console.log(`[StreamingService] Stream ${streamId} has been offline for over 1 hour, resetting runtime tracking`);
      resetStreamRuntime(streamId);
    }
    
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    // Track start time and calculate remaining duration
    const now = new Date();
    const totalRuntime = streamTotalRuntime.get(streamId) || 0;
    // IMPORTANT: In this app, `stream.duration` is treated as remaining minutes on restarts.
    // Therefore, do not compare accumulated total runtime against it here. Just use it as remaining.
    // If it's zero or negative, refuse to start.
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
    const ffmpegArgs = await buildFFmpegArgs(stream, seekSeconds);
    const fullCommand = `${ffmpegPath} ${ffmpegArgs.join(' ')}`;
    addStreamLog(streamId, `Starting stream with command: ${fullCommand}`);
    console.log(`Starting stream: ${fullCommand}`);

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Note: exit/error handlers are registered later with richer logic

    // Track start time for this session and register as active
    streamStartTimes.set(streamId, now.getTime());
    activeStreams.set(streamId, ffmpegProcess);

    // Verify process actually stays running briefly before marking DB as live
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!isProcessRunning(ffmpegProcess)) {
      addStreamLog(streamId, 'FFmpeg exited immediately after start; not marking as live');
      // Clean up maps
      activeStreams.delete(streamId);
      streamStartTimes.delete(streamId);
      // Return failure so scheduler/UI can handle it
      return { success: false, error: 'FFmpeg failed to start' };
    }

    await Stream.updateStatus(streamId, 'live', stream.user_id);
    // Once live, clear any previous schedule_time to avoid re-scheduling confusion
    try {
      await Stream.update(streamId, { schedule_time: null });
    } catch (e) {
      console.warn(`[StreamingService] Failed clearing schedule_time for ${streamId}: ${e.message}`);
    }
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
        // Capture precise playback timestamp if present, e.g. time=00:12:34.56
        const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2})(?:[\.,](\d{1,3}))?/);
        if (timeMatch) {
          const hh = parseInt(timeMatch[1], 10) || 0;
          const mm = parseInt(timeMatch[2], 10) || 0;
          const ss = parseInt(timeMatch[3], 10) || 0;
          const ms = timeMatch[4] ? parseInt(timeMatch[4].padEnd(3, '0'), 10) : 0;
          const seconds = hh * 3600 + mm * 60 + ss + (ms / 1000);
          if (Number.isFinite(seconds)) {
            streamLastTimestampSeconds.set(streamId, seconds);
          }
        }
        if (!message.includes('frame=')) {
          console.error(`[FFMPEG_STDERR] ${streamId}: ${message}`);
          // Track error messages for better restart logic
          if (message.includes('Connection reset by peer') || 
              message.includes('av_interleaved_write_frame') ||
              message.includes('Broken pipe') ||
              message.includes('End of file') ||
              message.includes('Connection timed out') ||
              message.includes('Network is unreachable')) {
            streamErrorMessages.set(streamId, message);
          }
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

        // Decrement remaining minutes and persist
        try {
          const s = await Stream.findById(streamId);
          if (s && typeof s.duration === 'number') {
            const minutesThisSession = Math.ceil(sessionRuntime / 60000);
            const newRemaining = Math.max(0, s.duration - minutesThisSession);
            if (newRemaining !== s.duration) {
              await Stream.update(streamId, { duration: newRemaining });
              addStreamLog(streamId, `Updated remaining minutes to ${newRemaining} after this session`);
            }
          }
        } catch (e) {
          console.warn(`[StreamingService] Failed updating remaining minutes for ${streamId}: ${e.message}`);
        }
      }
      
      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);
      
      // Clean up error message tracking
      streamErrorMessages.delete(streamId);
      streamLastTimestampSeconds.delete(streamId);
      
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

      // Check remaining minutes; if none left, do not restart
      const totalRuntime = streamTotalRuntime.get(streamId) || 0;
      const stream = await Stream.findById(streamId);
      if (stream && typeof stream.duration === 'number' && stream.duration <= 0) {
        console.log(`[StreamingService] Stream ${streamId} has no remaining minutes, not restarting`);
        addStreamLog(streamId, `No remaining minutes, not restarting`);
        try {
          await Stream.updateStatus(streamId, 'offline');
          if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
            schedulerService.handleStreamStopped(streamId);
          }
        } catch (error) {
          console.error(`[StreamingService] Error updating stream status after remaining reached zero: ${error.message}`);
        }
        return;
      }

      // Additional check: if stream status is already 'offline' in database, don't restart
      const currentStreamStatus = await Stream.findById(streamId);
      if (currentStreamStatus && currentStreamStatus.status === 'offline') {
        console.log(`[StreamingService] Stream ${streamId} status is already 'offline' in database, not restarting`);
        addStreamLog(streamId, `Stream status is already 'offline' in database, not restarting`);
        return;
      }

      if (signal === 'SIGSEGV') {
        // Check remaining minutes before attempting restart
        const currentStream = await Stream.findById(streamId);
        if (currentStream && typeof currentStream.duration === 'number' && currentStream.duration <= 0) {
          console.log(`[StreamingService] Stream ${streamId} has no remaining minutes, not restarting due to SIGSEGV`);
          addStreamLog(streamId, `No remaining minutes, not restarting due to SIGSEGV`);
          try {
            await Stream.updateStatus(streamId, 'offline');
            if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
              schedulerService.handleStreamStopped(streamId);
            }
          } catch (error) {
            console.error(`[StreamingService] Error updating stream status after remaining reached zero: ${error.message}`);
          }
          return;
        }

        // Additional check: if stream status is already 'offline' in database, don't restart
        if (currentStream && currentStream.status === 'offline') {
          console.log(`[StreamingService] Stream ${streamId} status is already 'offline' in database, not restarting due to SIGSEGV`);
          addStreamLog(streamId, `Stream status is already 'offline' in database, not restarting due to SIGSEGV`);
          return;
        }
        
        const retryCount = streamRetryCount.get(streamId) || 0;
        // Allow restart for longer runtime for SIGSEGV (crash) as it's usually a system issue
        const runtimeInfo = getStreamRuntimeInfo(streamId);
        const allowRestart = runtimeInfo.totalRuntimeMinutes < 30; // Increased from 10 to 30 minutes for crashes
        
        if (retryCount < MAX_RETRY_ATTEMPTS && allowRestart) {
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
        } else if (retryCount >= MAX_RETRY_ATTEMPTS) {
          console.error(`[StreamingService] Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached for stream ${streamId}`);
          addStreamLog(streamId, `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached, stopping stream`);
        } else {
          console.log(`[StreamingService] Stream ${streamId} runtime too long (${runtimeInfo.totalRuntimeMinutes}min), not restarting due to SIGSEGV`);
          addStreamLog(streamId, `Stream runtime too long (${runtimeInfo.totalRuntimeMinutes}min), not restarting due to SIGSEGV`);
        }
      }
      else {
        let errorMessage = '';
        if (code !== 0 && code !== null) {
          errorMessage = `FFmpeg process exited with error code ${code}`;
          addStreamLog(streamId, errorMessage);
          console.error(`[StreamingService] ${errorMessage} for stream ${streamId}`);
          
          // Check remaining minutes again before attempting restart
          const currentStream = await Stream.findById(streamId);
          if (currentStream && typeof currentStream.duration === 'number' && currentStream.duration <= 0) {
            console.log(`[StreamingService] Stream ${streamId} has no remaining minutes, not restarting due to error code ${code}`);
            addStreamLog(streamId, `No remaining minutes, not restarting due to error code ${code}`);
            try {
              await Stream.updateStatus(streamId, 'offline');
              if (typeof schedulerService !== 'undefined' && schedulerService.cancelStreamTermination) {
                schedulerService.handleStreamStopped(streamId);
              }
            } catch (error) {
              console.error(`[StreamingService] Error updating stream status after remaining reached zero: ${error.message}`);
            }
            return;
          }

          // Additional check: if stream status is already 'offline' in database, don't restart
          if (currentStream && currentStream.status === 'offline') {
            console.log(`[StreamingService] Stream ${streamId} status is already 'offline' in database, not restarting due to error code ${code}`);
            addStreamLog(streamId, `Stream status is already 'offline' in database, not restarting due to error code ${code}`);
            return;
          }
          
          // Only restart for certain error codes that are likely recoverable
          // Error code 1 often means "End of file" which can be temporary
          // Error code 255 usually means normal termination (like when stopping stream)
          const isRecoverableError = code === 1; // Only code 1 is truly recoverable
          
          if (isRecoverableError) {
            const retryCount = streamRetryCount.get(streamId) || 0;
            // Allow restart for longer runtime if it's a recoverable error
            const runtimeInfo = getStreamRuntimeInfo(streamId);
            
            // Special handling for network-related errors - allow restart for much longer streams
            // as these are usually temporary network issues that can be resolved
            const trackedError = streamErrorMessages.get(streamId);
            const isNetworkError = trackedError && (
              trackedError.includes('Connection reset by peer') || 
              trackedError.includes('av_interleaved_write_frame') ||
              trackedError.includes('Broken pipe') ||
              trackedError.includes('End of file') ||
              trackedError.includes('Connection timed out') ||
              trackedError.includes('Network is unreachable')
            );
            
            let allowRestart;
            if (isNetworkError) {
              // For network errors, allow restart up to 24 hours (1440 minutes)
              // This handles network issues that commonly occur with long streams
              allowRestart = runtimeInfo.totalRuntimeMinutes < 1440;
              console.log(`[StreamingService] Network error detected for stream ${streamId}, allowing restart up to 1440 minutes runtime`);
            } else {
              // For other error code 1, use extended limit (1000 minutes)
              allowRestart = runtimeInfo.totalRuntimeMinutes < 1000;
              console.log(`[StreamingService] Standard error code 1 for stream ${streamId}, allowing restart up to 1000 minutes runtime`);
            }
            
            if (retryCount < MAX_RETRY_ATTEMPTS && allowRestart) {
              streamRetryCount.set(streamId, retryCount + 1);
              const restartType = isNetworkError ? 'network error' : `error code ${code}`;
              console.log(`[StreamingService] FFmpeg exited with recoverable ${restartType}. Attempting restart #${retryCount + 1} for stream ${streamId}`);
              addStreamLog(streamId, `FFmpeg exited with recoverable ${restartType}. Attempting restart #${retryCount + 1}`);
              
              // For network errors, wait longer before restart to allow network to stabilize
              const restartDelay = isNetworkError ? 10000 : 3000; // 10 seconds for network errors, 3 seconds for others
              
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
              }, restartDelay);
              return;
            } else if (retryCount >= MAX_RETRY_ATTEMPTS) {
              console.error(`[StreamingService] Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached for stream ${streamId}`);
              addStreamLog(streamId, `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) reached, stopping stream`);
            } else {
              const reason = isNetworkError ? 'network error' : `error code ${code}`;
              console.log(`[StreamingService] Stream ${streamId} runtime too long (${runtimeInfo.totalRuntimeMinutes}min), not restarting for ${reason}`);
              addStreamLog(streamId, `Stream runtime too long (${runtimeInfo.totalRuntimeMinutes}min), not restarting for ${reason}`);
            }
          } else if (code === 255) {
            // Error code 255 usually means normal termination (like when stopping stream)
            console.log(`[StreamingService] Stream ${streamId} exited with code 255 (normal termination), not restarting`);
            addStreamLog(streamId, `Stream exited with code 255 (normal termination), not restarting`);
          } else {
            console.log(`[StreamingService] Stream ${streamId} exited with non-recoverable error code ${code}, not restarting`);
            addStreamLog(streamId, `Stream exited with non-recoverable error code ${code}, not restarting`);
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
      streamErrorMessages.delete(streamId);
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
      // Persist remaining minutes so Dashboard shows remaining, not original
      try {
        await Stream.update(streamId, { duration: remainingMinutes });
        addStreamLog(streamId, `Updated stored duration to remaining: ${remainingMinutes} minutes`);
      } catch (e) {
        console.warn(`[StreamingService] Failed to update remaining duration for ${streamId}: ${e.message}`);
      }
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
    streamErrorMessages.delete(streamId);
    
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
        // If this stream has a future (or just-started) schedule_time, it should not be forced offline.
        // This handles cases where a scheduled stream was accidentally marked 'live' prematurely.
        const nowTs = Date.now();
        const scheduleTs = stream.schedule_time ? new Date(stream.schedule_time).getTime() : null;
        const isInFuture = scheduleTs && nowTs < scheduleTs;
        if (isInFuture) {
          try {
            console.log(`[StreamingService] Reverting stream ${stream.id} status to 'scheduled' due to future schedule_time`);
            await Stream.updateStatus(stream.id, 'scheduled', stream.user_id);
          } catch (e) {
            console.warn(`[StreamingService] Failed reverting ${stream.id} to 'scheduled': ${e.message}`);
          }
          continue;
        }
        // Grace period and protective checks to avoid premature offline flips
        const updatedAt = stream.status_updated_at ? new Date(stream.status_updated_at).getTime() : 0;
        const justWentLive = updatedAt && (Date.now() - updatedAt) < (5 * 60_000); // 5 minutes
        const isStartingNow = startingStreams.has(stream.id);
        const scheduledMap = (typeof schedulerService !== 'undefined' && schedulerService.getScheduledTerminations)
          ? schedulerService.getScheduledTerminations() : {};
        const hasScheduledTermination = !!scheduledMap[stream.id];
        if (justWentLive || isStartingNow || hasScheduledTermination) {
          console.log(`[StreamingService] Skipping status correction for ${stream.id}: ` +
            `${justWentLive ? 'within grace window; ' : ''}` +
            `${isStartingNow ? 'start in progress; ' : ''}` +
            `${hasScheduledTermination ? 'termination scheduled' : ''}`);
          continue;
        }
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
        streamErrorMessages.delete(stream.id);
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
          streamErrorMessages.delete(streamId);
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
  streamErrorMessages.delete(streamId);
  console.log(`[StreamingService] Reset runtime tracking for stream ${streamId}`);
}

// Function to check if a stream should have its runtime reset (if it's been offline for a while)
async function shouldResetRuntime(streamId) {
  try {
    const stream = await Stream.findById(streamId);
    if (!stream || stream.status !== 'offline') {
      return false;
    }
    
    // If stream has been offline for more than 1 hour, reset runtime tracking
    const lastUpdate = stream.status_updated_at ? new Date(stream.status_updated_at).getTime() : 0;
    const offlineDuration = Date.now() - lastUpdate;
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
    
    return offlineDuration > oneHour;
  } catch (error) {
    console.error(`[StreamingService] Error checking runtime reset for stream ${streamId}: ${error.message}`);
    return false;
  }
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
        streamErrorMessages.delete(streamId);
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
  shouldResetRuntime,
  cleanupZombieProcesses
};
