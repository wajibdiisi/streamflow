const Stream = require('../models/Stream');
const scheduledTerminations = new Map();
const SCHEDULE_LOOKAHEAD_SECONDS = 60;
let streamingService = null;

function init(streamingServiceInstance) {
  streamingService = streamingServiceInstance;
  console.log('Stream scheduler initialized');
  setInterval(checkScheduledStreams, 60 * 1000);
  setInterval(checkStreamDurations, 60 * 1000);
  checkScheduledStreams();
  checkStreamDurations();
}

async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      console.error('StreamingService not initialized in scheduler');
      return;
    }
    const now = new Date();
    const lookAheadTime = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_SECONDS * 1000);
    console.log(`Checking for scheduled streams (${now.toISOString()} to ${lookAheadTime.toISOString()})`);
    const streams = await Stream.findScheduledInRange(now, lookAheadTime);
    if (streams.length > 0) {
      console.log(`Found ${streams.length} streams to schedule start`);
      for (const stream of streams) {
        console.log(`Starting scheduled stream: ${stream.id} - ${stream.title}`);
        const result = await streamingService.startStream(stream.id);
        if (result.success) {
          console.log(`Successfully started scheduled stream: ${stream.id}`);
          // Note: startStream now handles duration scheduling internally
          if (result.remainingDuration) {
            console.log(`Stream ${stream.id} scheduled with ${result.remainingDuration} minutes remaining`);
          }
        } else {
          console.error(`Failed to start scheduled stream ${stream.id}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    console.error('Error checking scheduled streams:', error);
  }
}

async function checkStreamDurations() {
  try {
    if (!streamingService) {
      console.error('StreamingService not initialized in scheduler');
      return;
    }
    const liveStreams = await Stream.findAll(null, 'live');
    for (const stream of liveStreams) {
      if (stream.duration && stream.start_time && !scheduledTerminations.has(stream.id)) {
        // Get runtime info from streaming service
        const runtimeInfo = streamingService.getStreamRuntimeInfo ? 
          streamingService.getStreamRuntimeInfo(stream.id) : null;
        
        if (runtimeInfo && runtimeInfo.totalRuntimeMinutes >= stream.duration) {
          console.log(`Stream ${stream.id} exceeded duration (${runtimeInfo.totalRuntimeMinutes}min >= ${stream.duration}min), stopping now`);
          await streamingService.stopStream(stream.id);
        } else if (runtimeInfo) {
          // Calculate remaining time based on tracked runtime
          const remainingMinutes = Math.max(0, stream.duration - runtimeInfo.totalRuntimeMinutes);
          if (remainingMinutes > 0) {
            console.log(`Stream ${stream.id} - Total runtime: ${runtimeInfo.totalRuntimeMinutes}min, Remaining: ${remainingMinutes}min`);
            scheduleStreamTermination(stream.id, remainingMinutes);
          }
        } else {
          // Fallback to old method if runtime tracking not available
          const startTime = new Date(stream.start_time);
          const durationMs = stream.duration * 60 * 1000;
          const shouldEndAt = new Date(startTime.getTime() + durationMs);
          const now = new Date();
          if (shouldEndAt <= now) {
            console.log(`Stream ${stream.id} exceeded duration, stopping now`);
            await streamingService.stopStream(stream.id);
          } else {
            const timeUntilEnd = shouldEndAt.getTime() - now.getTime();
            scheduleStreamTermination(stream.id, timeUntilEnd / 60000);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking stream durations:', error);
  }
}

function scheduleStreamTermination(streamId, durationMinutes) {
  // Cancel existing termination if any
  if (scheduledTerminations.has(streamId)) {
    clearTimeout(scheduledTerminations.get(streamId));
    console.log(`[SchedulerService] Cancelled existing termination for stream ${streamId}`);
  }
  
  const durationMs = durationMinutes * 60 * 1000;
  console.log(`[SchedulerService] Scheduling termination for stream ${streamId} after ${durationMinutes} minutes`);
  
  const timeoutId = setTimeout(async () => {
    try {
      console.log(`[SchedulerService] Terminating stream ${streamId} after ${durationMinutes} minute duration`);
      await streamingService.stopStream(streamId);
      scheduledTerminations.delete(streamId);
    } catch (error) {
      console.error(`[SchedulerService] Error terminating stream ${streamId}:`, error);
    }
  }, durationMs);
  
  scheduledTerminations.set(streamId, timeoutId);
}

function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    clearTimeout(scheduledTerminations.get(streamId));
    scheduledTerminations.delete(streamId);
    console.log(`[SchedulerService] Cancelled scheduled termination for stream ${streamId}`);
    return true;
  }
  return false;
}

function handleStreamStopped(streamId) {
  return cancelStreamTermination(streamId);
}

// Function to get current scheduled terminations
function getScheduledTerminations() {
  const terminations = {};
  for (const [streamId, timeoutId] of scheduledTerminations.entries()) {
    terminations[streamId] = {
      timeoutId: timeoutId,
      hasScheduledTermination: true
    };
  }
  return terminations;
}

module.exports = {
  init,
  scheduleStreamTermination,
  cancelStreamTermination,
  handleStreamStopped,
  getScheduledTerminations
};