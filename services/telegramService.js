const axios = require('axios');
const User = require('../models/User');
const Stream = require('../models/Stream');

async function getUserTelegramSettings(userId) {
  const user = await User.findById(userId);
  if (!user) return null;
  return {
    enabled: !!user.telegram_enabled,
    token: user.telegram_bot_token,
    chatId: user.telegram_chat_id,
    alertOnStart: !!user.telegram_alert_on_start,
    alertOnError: !!user.telegram_alert_on_error,
    alertOnStop: !!user.telegram_alert_on_stop,
  };
}

async function sendMessage(token, chatId, text) {
  if (!token || !chatId || !text) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
    return true;
  } catch (e) {
    console.error('[Telegram] sendMessage failed:', e.message);
    return false;
  }
}

function formatDurationMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '-';
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function notifyStreamStart(userId, stream) {
  try {
    console.log(`[Telegram] Checking notification for user ${userId}, stream: ${stream?.title}`);
    const cfg = await getUserTelegramSettings(userId);
    console.log(`[Telegram] User settings:`, { enabled: cfg?.enabled, alertOnStart: cfg?.alertOnStart });
    
    if (!cfg || !cfg.enabled || !cfg.alertOnStart) {
      console.log(`[Telegram] Notification skipped - settings not enabled`);
      return false;
    }
    
    const title = stream.title || 'Untitled';
    const channel = stream.channel_name || '-';
    const streamKey = stream.stream_key || '-';
    const streamId = stream.id || '-';
    const timestamp = new Date().toLocaleString('en-US', { 
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const text = `🚀 <b>Stream Started</b>\n` +
                `📅 <b>Time:</b> ${timestamp} WIB\n` +
                `📺 <b>Title:</b> ${title}\n` +
                `📡 <b>Channel:</b> ${channel}\n` +
                `🔑 <b>Stream Key:</b> ${streamKey}\n` +
                `🆔 <b>Stream ID:</b> ${streamId}`;
    
    console.log(`[Telegram] Sending notification: ${text}`);
    const result = await sendMessage(cfg.token, cfg.chatId, text);
    console.log(`[Telegram] Notification result: ${result}`);
    return result;
  } catch (error) {
    console.error(`[Telegram] Error in notifyStreamStart:`, error);
    return false;
  }
}

async function notifyStreamError(userId, streamId, errorInfo) {
  const cfg = await getUserTelegramSettings(userId);
  if (!cfg || !cfg.enabled || !cfg.alertOnError) return false;
  const stream = await Stream.getStreamWithVideo(streamId);
  const title = stream?.title || 'Untitled';
  const channel = stream?.channel_name || '-';
  const streamKey = stream?.stream_key || '-';
  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  // Get runtime information
  const streamingService = require('./streamingService');
  const runtimeInfo = streamingService.getStreamRuntimeInfo(streamId);
  const runtimeText = formatDurationMinutes(runtimeInfo.totalRuntimeMinutes);
  
  // Get recent error logs from streaming service
  const streamLogs = streamingService.getStreamLogs(streamId);
  const errorLogs = streamLogs.filter(log => 
    log.message.toLowerCase().includes('error') || 
    log.message.toLowerCase().includes('failed') ||
    log.message.toLowerCase().includes('ffmpeg error')
  ).slice(-3); // Get last 3 error logs
  
  const parts = [];
  if (errorInfo?.code !== undefined && errorInfo?.code !== null) parts.push(`Code: ${errorInfo.code}`);
  if (errorInfo?.signal) parts.push(`Signal: ${errorInfo.signal}`);
  if (errorInfo?.message) parts.push(errorInfo.message);
  
  // Add error logs to details
  if (errorLogs.length > 0) {
    const logDetails = errorLogs.map(log => 
      `${log.timestamp}: ${log.message}`
    ).join('\n');
    parts.push(`\n📋 <b>Recent Error Logs:</b>\n<code>${logDetails}</code>`);
  }
  
  const meta = parts.length ? `\n🔍 <b>Details:</b> ${parts.join(', ')}` : '';
  
  const text = `⚠️ <b>Stream Error</b>\n` +
              `📅 <b>Time:</b> ${timestamp} WIB\n` +
              `📺 <b>Title:</b> ${title}\n` +
              `📡 <b>Channel:</b> ${channel}\n` +
              `🔑 <b>Stream Key:</b> ${streamKey}\n` +
              `🆔 <b>Stream ID:</b> ${streamId}\n` +
              `⏱️ <b>Runtime:</b> ${runtimeText}${meta}`;
  return sendMessage(cfg.token, cfg.chatId, text);
}

async function notifyStreamStop(userId, streamId, summary) {
  const cfg = await getUserTelegramSettings(userId);
  if (!cfg || !cfg.enabled || !cfg.alertOnStop) return false;
  const stream = await Stream.getStreamWithVideo(streamId);
  const title = stream?.title || 'Untitled';
  const channel = stream?.channel_name || '-';
  const streamKey = stream?.stream_key || '-';
  
  // Use runtime from summary if available, otherwise get from streaming service
  let runtimeText = '-';
  if (summary && summary.runtimeMinutes !== undefined) {
    runtimeText = formatDurationMinutes(summary.runtimeMinutes);
  } else {
    const streamingService = require('./streamingService');
    const runtimeInfo = streamingService.getStreamRuntimeInfo(streamId);
    runtimeText = formatDurationMinutes(runtimeInfo.totalRuntimeMinutes);
  }
  
  const timestamp = new Date().toLocaleString('en-US', { 
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const text = `🛑 <b>Stream Stopped</b>\n` +
              `📅 <b>Time:</b> ${timestamp} WIB\n` +
              `📺 <b>Title:</b> ${title}\n` +
              `📡 <b>Channel:</b> ${channel}\n` +
              `🔑 <b>Stream Key:</b> ${streamKey}\n` +
              `🆔 <b>Stream ID:</b> ${streamId}\n` +
              `⏱️ <b>Runtime:</b> ${runtimeText}`;
  return sendMessage(cfg.token, cfg.chatId, text);
}

module.exports = {
  getUserTelegramSettings,
  sendMessage,
  notifyStreamStart,
  notifyStreamError,
  notifyStreamStop,
};


