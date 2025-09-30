const fs = require('fs');
const path = require('path');
const util = require('util');
const logDir = path.join(process.cwd(), 'logs');
const logFilePath = path.join(logDir, 'app.log');
const MAX_LOG_SIZE_MB = 10;
const MAX_LOG_SIZE_BYTES = MAX_LOG_SIZE_MB * 1024 * 1024; // 10MB in bytes
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleDebug = console.debug;
let isWritingToLog = false; // Prevent infinite loop
let logSizeAlertSent = false; // Prevent multiple alerts for the same log size issue

async function checkLogSizeAndAlert() {
  try {
    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      const fileSizeBytes = stats.size;
      const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
      
      if (fileSizeBytes > MAX_LOG_SIZE_BYTES && !logSizeAlertSent) {
        logSizeAlertSent = true;
        
        // Send Telegram alert
        try {
          const telegramService = require('./telegramService');
          const User = require('../models/User');
          
          // Get all users with Telegram enabled
          const users = await User.findAll();
          const usersWithTelegram = users.filter(user => user.telegram_enabled && user.telegram_bot_token && user.telegram_chat_id);
          
          for (const user of usersWithTelegram) {
            try {
              await telegramService.sendMessage(
                user.telegram_bot_token,
                user.telegram_chat_id,
                `⚠️ <b>Log File Size Alert</b>\n\n` +
                `📁 <b>File:</b> app.log\n` +
                `📏 <b>Current Size:</b> ${fileSizeMB} MB\n` +
                `🚨 <b>Limit:</b> ${MAX_LOG_SIZE_MB} MB\n` +
                `⏰ <b>Time:</b> ${new Date().toLocaleString('en-US', { 
                  timeZone: 'Asia/Jakarta',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false
                })} WIB\n\n` +
                `💡 <b>Recommendation:</b> Consider clearing or rotating the log file.`
              );
              console.log(`[Logger] Log size alert sent to user ${user.id}`);
            } catch (error) {
              console.error(`[Logger] Failed to send log size alert to user ${user.id}:`, error.message);
            }
          }
        } catch (error) {
          console.error('[Logger] Error sending log size alert:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('[Logger] Error checking log size:', error.message);
  }
}

function writeToLogFile(level, ...args) {
  if (isWritingToLog) return; // Prevent infinite loop
  
  isWritingToLog = true;
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
  const message = args.map(arg => typeof arg === 'string' ? arg : util.inspect(arg, { depth: null, colors: false })).join(' ');
  const logEntry = `${timestamp} [${level.toUpperCase()}] ${message}\n`;
  
  try {
    fs.appendFileSync(logFilePath, logEntry);
    
    // Check log size and send alert if needed (only check every 100 writes to avoid performance impact)
    if (Math.random() < 0.01) { // 1% chance to check
      setImmediate(() => {
        checkLogSizeAndAlert().catch(err => {
          console.error('[Logger] Error in checkLogSizeAndAlert:', err.message);
        });
      });
    }
  } catch (err) {
    // Log EPIPE errors but prevent infinite loop
    if (err.message.includes('EPIPE')) {
      try {
        process.stderr.write(`[Logger] EPIPE error writing to log file: ${err.message}\n`);
      } catch (e) {
        // If even stderr fails, just ignore
      }
    } else {
      try {
        originalConsoleError('Failed to write to log file:', err.message);
      } catch (e) {
        // If even original console.error fails, just ignore
      }
    }
  } finally {
    isWritingToLog = false;
  }
}

// Function to reset the alert flag (useful for testing or after log cleanup)
function resetLogSizeAlert() {
  logSizeAlertSent = false;
}

// Function to manually check log size
async function checkLogSizeNow() {
  await checkLogSizeAndAlert();
}

// Export functions for external use
module.exports = {
  resetLogSizeAlert,
  checkLogSizeNow
};

console.log = (...args) => {
  try {
    originalConsoleLog.apply(console, args);
  } catch (e) {
    // Log EPIPE errors but don't cause infinite loop
    if (e.message.includes('EPIPE')) {
      try {
        process.stderr.write(`[Logger] EPIPE error in console.log: ${e.message}\n`);
      } catch (e2) {
        // Ignore if even stderr fails
      }
    } else {
      try {
        originalConsoleError('Console.log error:', e.message);
      } catch (e2) {
        // Ignore all errors to prevent infinite loop
      }
    }
  }
  try {
    writeToLogFile('log', ...args);
  } catch (e) {
    // Log file write errors but don't cause infinite loop
    if (e.message.includes('EPIPE')) {
      try {
        process.stderr.write(`[Logger] EPIPE error writing to log file: ${e.message}\n`);
      } catch (e2) {
        // Ignore if even stderr fails
      }
    }
  }
};

console.error = (...args) => {
  try {
    originalConsoleError.apply(console, args);
  } catch (e) {
    // Log EPIPE errors but don't cause infinite loop
    if (e.message.includes('EPIPE')) {
      try {
        process.stderr.write(`[Logger] EPIPE error in console.error: ${e.message}\n`);
      } catch (e2) {
        // Ignore if even stderr fails
      }
    } else {
      try {
        process.stderr.write('Console.error error: ' + e.message + '\n');
      } catch (e2) {
        // Ignore all errors to prevent infinite loop
      }
    }
  }
  try {
    writeToLogFile('error', ...args);
  } catch (e) {
    // Log file write errors but don't cause infinite loop
    if (e.message.includes('EPIPE')) {
      try {
        process.stderr.write(`[Logger] EPIPE error writing to log file: ${e.message}\n`);
      } catch (e2) {
        // Ignore if even stderr fails
      }
    }
  }
};

console.warn = (...args) => {
  try {
    originalConsoleWarn.apply(console, args);
  } catch (e) {
    // Ignore EPIPE errors
  }
  writeToLogFile('warn', ...args);
};

console.info = (...args) => {
  try {
    originalConsoleInfo.apply(console, args);
  } catch (e) {
    // Ignore EPIPE errors
  }
  writeToLogFile('info', ...args);
};

console.debug = (...args) => {
  try {
    originalConsoleDebug.apply(console, args);
  } catch (e) {
    // Ignore EPIPE errors
  }
  writeToLogFile('debug', ...args);
};
console.log('Logger initialized. Output will be written to console and logs/app.log');