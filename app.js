require('dotenv').config();
require('./services/logger.js');
const express = require('express');
const path = require('path');
const engine = require('ejs-mate');
const os = require('os');
const multer = require('multer');
const fs = require('fs');
const csrf = require('csrf');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const User = require('./models/User');
const { db, checkIfUsersExist } = require('./db/database');
const systemMonitor = require('./services/systemMonitor');
const { uploadVideo } = require('./middleware/uploadMiddleware');
const { ensureDirectories } = require('./utils/storage');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegConfig = require('./utils/ffmpegConfig');

// Configure fluent-ffmpeg with detected paths
ffmpeg.setFfmpegPath(ffmpegConfig.getFFmpegPath());
ffmpeg.setFfprobePath(ffmpegConfig.getFFprobePath());
const { getVideoInfo, generateThumbnail } = require('./utils/videoProcessor');
const Video = require('./models/Video');
const streamingService = require('./services/streamingService');
const schedulerService = require('./services/schedulerService');
const telegramService = require('./services/telegramService');
process.on('unhandledRejection', (reason, promise) => {
  // Prevent infinite loop by using original console methods
  try {
    process.stderr.write('-----------------------------------\n');
    process.stderr.write('UNHANDLED REJECTION AT: ' + promise + '\n');
    process.stderr.write('REASON: ' + reason + '\n');
    process.stderr.write('-----------------------------------\n');
  } catch (e) {
    // If stderr is broken, just ignore
  }
});
process.on('uncaughtException', (error) => {
  // Prevent infinite loop by using original console methods
  try {
    process.stderr.write('-----------------------------------\n');
    process.stderr.write('UNCAUGHT EXCEPTION: ' + error.message + '\n');
    process.stderr.write('-----------------------------------\n');
  } catch (e) {
    // If stderr is broken, just ignore
  }
});
const app = express();
app.set("trust proxy", 1);
const port = process.env.PORT || 7575;
const tokens = new csrf();
ensureDirectories();
ensureDirectories();
app.locals.helpers = {
  getUsername: function (req) {
    if (req.session && req.session.username) {
      return req.session.username;
    }
    return 'User';
  },
  getAvatar: function (req) {
    if (req.session && req.session.userId) {
      const avatarPath = req.session.avatar_path;
      if (avatarPath) {
        return `<img src="${avatarPath}" alt="${req.session.username || 'User'}'s Profile" class="w-full h-full object-cover" onerror="this.onerror=null; this.src='/images/default-avatar.jpg';">`;
      }
    }
    return '<img src="/images/default-avatar.jpg" alt="Default Profile" class="w-full h-full object-cover">';
  },
  getPlatformIcon: function (platform) {
    switch (platform) {
      case 'YouTube': return 'youtube';
      case 'Facebook': return 'facebook';
      case 'Twitch': return 'twitch';
      case 'TikTok': return 'tiktok';
      case 'Instagram': return 'instagram';
      case 'Shopee Live': return 'shopping-bag';
      case 'Restream.io': return 'live-photo';
      default: return 'broadcast';
    }
  },
  getPlatformColor: function (platform) {
    switch (platform) {
      case 'YouTube': return 'red-500';
      case 'Facebook': return 'blue-500';
      case 'Twitch': return 'purple-500';
      case 'TikTok': return 'gray-100';
      case 'Instagram': return 'pink-500';
      case 'Shopee Live': return 'orange-500';
      case 'Restream.io': return 'teal-500';
      default: return 'gray-400';
    }
  },
  formatDateTime: function (isoString) {
    if (!isoString) return '--';
    
    const utcDate = new Date(isoString);
    
    return utcDate.toLocaleString('en-US', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  },
  formatDuration: function (seconds) {
    if (!seconds) return '--';
    const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${secs}`;
  }
};
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: './db/',
    table: 'sessions'
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use(async (req, res, next) => {
  if (req.session && req.session.userId) {
    try {
      const user = await User.findById(req.session.userId);
      if (user) {
        req.session.username = user.username;
        req.session.avatar_path = user.avatar_path;
        if (user.email) req.session.email = user.email;
        res.locals.user = {
          id: user.id,
          username: user.username,
          avatar_path: user.avatar_path,
          email: user.email
        };
      }
    } catch (error) {
      console.error('Error loading user:', error);
    }
  }
  res.locals.req = req;
  next();
});
app.use(function (req, res, next) {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = uuidv4();
  }
  res.locals.csrfToken = tokens.create(req.session.csrfSecret);
  next();
});
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', function (req, res, next) {
  res.header('Cache-Control', 'no-cache');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = './public/uploads/avatars';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = file.originalname.split('.').pop();
    cb(null, 'avatar-' + uniqueSuffix + '.' + ext);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  }
});
const videoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads', 'videos'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    let fileName = `video-${uniqueSuffix}${ext}`;
    let fullPath = path.join(__dirname, 'public', 'uploads', 'videos', fileName);
    let counter = 1;
    while (fs.existsSync(fullPath)) {
      fileName = `video-${uniqueSuffix}-${counter}${ext}`;
      fullPath = path.join(__dirname, 'public', 'uploads', 'videos', fileName);
      counter++;
    }
    cb(null, fileName);
  }
});
const videoUpload = multer({
  storage: videoStorage,
  fileFilter: function (req, file, cb) {
    if (!file.mimetype.match(/^video\/(mp4|avi|quicktime)$/)) {
      return cb(new Error('Only MP4, AVI, and MOV video files are allowed!'), false);
    }
    cb(null, true);
  }
});
const csrfProtection = function (req, res, next) {
  if ((req.path === '/login' && req.method === 'POST') ||
    (req.path === '/setup-account' && req.method === 'POST')) {
    return next();
  }
  const token = req.body._csrf || req.query._csrf || req.headers['x-csrf-token'];
  if (!token || !tokens.verify(req.session.csrfSecret, token)) {
    return res.status(403).render('error', {
      title: 'Error',
      error: 'CSRF validation failed. Please try again.'
    });
  }
  next();
};
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  res.redirect('/login');
};
app.use('/uploads', function (req, res, next) {
  res.header('Cache-Control', 'no-cache');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
  next();
});
app.use('/uploads/avatars', (req, res, next) => {
  const file = path.join(__dirname, 'public', 'uploads', 'avatars', path.basename(req.path));
  if (fs.existsSync(file)) {
    const ext = path.extname(file).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    res.header('Content-Type', contentType);
    res.header('Cache-Control', 'max-age=60, must-revalidate');
    fs.createReadStream(file).pipe(res);
  } else {
    next();
  }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('login', {
      title: 'Login',
      error: 'Too many login attempts. Please try again in 15 minutes.'
    });
  },
  requestWasSuccessful: (request, response) => {
    return response.statusCode < 400;
  }
});
const loginDelayMiddleware = async (req, res, next) => {
  await new Promise(resolve => setTimeout(resolve, 1000));
  next();
};
app.get('/login', async (req, res) => {
  if (req.session.userId) {
    return res.redirect('/dashboard');
  }
  try {
    const usersExist = await checkIfUsersExist();
    if (!usersExist) {
      return res.redirect('/setup-account');
    }
    res.render('login', {
      title: 'Login',
      error: null
    });
  } catch (error) {
    console.error('Error checking for users:', error);
    res.render('login', {
      title: 'Login',
      error: 'System error. Please try again.'
    });
  }
});
app.post('/login', loginDelayMiddleware, loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findByUsername(username);
    if (!user) {
      return res.render('login', {
        title: 'Login',
        error: 'Invalid username or password'
      });
    }
    const passwordMatch = await User.verifyPassword(password, user.password);
    if (!passwordMatch) {
      return res.render('login', {
        title: 'Login',
        error: 'Invalid username or password'
      });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', {
      title: 'Login',
      error: 'An error occurred during login. Please try again.'
    });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});
app.get('/setup-account', async (req, res) => {
  try {
    const usersExist = await checkIfUsersExist();
    if (usersExist && !req.session.userId) {
      return res.redirect('/login');
    }
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user && user.username) {
        return res.redirect('/dashboard');
      }
    }
    res.render('setup-account', {
      title: 'Complete Your Account',
      user: req.session.userId ? await User.findById(req.session.userId) : {},
      error: null
    });
  } catch (error) {
    console.error('Setup account error:', error);
    res.redirect('/login');
  }
});
app.post('/setup-account', upload.single('avatar'), [
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.password)
    .withMessage('Passwords do not match')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.render('setup-account', {
        title: 'Complete Your Account',
        user: { username: req.body.username || '' },
        error: errors.array()[0].msg
      });
    }
    const existingUsername = await User.findByUsername(req.body.username);
    if (existingUsername) {
      return res.render('setup-account', {
        title: 'Complete Your Account',
        user: { email: req.body.email || '' },
        error: 'Username is already taken'
      });
    }
    const avatarPath = req.file ? `/uploads/avatars/${req.file.filename}` : null;
    const usersExist = await checkIfUsersExist();
    if (!usersExist) {
      try {
        const userId = uuidv4();
        await User.create({
          id: userId,
          username: req.body.username,
          password: req.body.password,
          avatar_path: avatarPath,
        });
        req.session.userId = userId;
        req.session.username = req.body.username;
        if (avatarPath) {
          req.session.avatar_path = avatarPath;
        }
        return res.redirect('/dashboard');
      } catch (error) {
        console.error('User creation error:', error);
        return res.render('setup-account', {
          title: 'Complete Your Account',
          user: {},
          error: 'Failed to create user. Please try again.'
        });
      }
    } else {
      await User.update(req.session.userId, {
        username: req.body.username,
        password: req.body.password,
        avatar_path: avatarPath,
      });
      req.session.username = req.body.username;
      if (avatarPath) {
        req.session.avatar_path = avatarPath;
      }
      res.redirect('/dashboard');
    }
  } catch (error) {
    console.error('Account setup error:', error);
    res.render('setup-account', {
      title: 'Complete Your Account',
      user: { email: req.body.email || '' },
      error: 'An error occurred. Please try again.'
    });
  }
});
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});
app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    res.render('dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      user: user
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.redirect('/login');
  }
});
app.get('/gallery', isAuthenticated, async (req, res) => {
  try {
    const videos = await Video.findAll(req.session.userId);
    res.render('gallery', {
      title: 'Video Gallery',
      active: 'gallery',
      user: await User.findById(req.session.userId),
      videos: videos
    });
  } catch (error) {
    console.error('Gallery error:', error);
    res.redirect('/dashboard');
  }
});

app.get('/folders', isAuthenticated, async (req, res) => {
  try {
    const videos = await Video.findAll(req.session.userId);
    res.render('folders', {
      title: 'Folder Manager',
      active: 'folders',
      user: await User.findById(req.session.userId),
      videos: videos
    });
  } catch (error) {
    console.error('Folders error:', error);
    res.redirect('/dashboard');
  }
});

app.get('/stream-keys', isAuthenticated, async (req, res) => {
  try {
    res.render('stream-keys', {
      title: 'Stream Key Management',
      active: 'stream-keys',
      user: await User.findById(req.session.userId)
    });
  } catch (error) {
    console.error('Stream keys error:', error);
    res.redirect('/dashboard');
  }
});

app.get('/settings', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: user
    });
  } catch (error) {
    console.error('Settings error:', error);
    res.redirect('/login');
  }
});
app.get('/history', isAuthenticated, async (req, res) => {
  try {
    const db = require('./db/database').db;
    const history = await new Promise((resolve, reject) => {
      db.all(
        `SELECT h.*, v.thumbnail_path 
         FROM stream_history h 
         LEFT JOIN videos v ON h.video_id = v.id 
         WHERE h.user_id = ? 
         ORDER BY h.start_time DESC`,
        [req.session.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
    res.render('history', {
      active: 'history',
      title: 'Stream History',
      history: history,
      helpers: app.locals.helpers
    });
  } catch (error) {
    console.error('Error fetching stream history:', error);
    res.status(500).render('error', {
      title: 'Error',
      message: 'Failed to load stream history',
      error: error
    });
  }
});

app.get('/telegram-alerts', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    res.render('telegram-alerts', {
      title: 'Telegram Alerts',
      active: 'telegram-alerts',
      user: user
    });
  } catch (error) {
    console.error('Telegram alerts error:', error);
    res.redirect('/dashboard');
  }
});

// FFmpeg info endpoint
app.get('/api/ffmpeg-info', isAuthenticated, async (req, res) => {
  try {
    const { spawn } = require('child_process');
    
    const configInfo = ffmpegConfig.getConfigInfo();
    const ffmpegPath = configInfo.ffmpeg.path;
    const ffprobePath = configInfo.ffprobe.path;
    
    // Get FFmpeg version
    const ffmpegProcess = spawn(ffmpegPath, ['-version']);
    let versionOutput = '';
    
    ffmpegProcess.stdout.on('data', (data) => {
      versionOutput += data.toString();
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      versionOutput += data.toString();
    });
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        const lines = versionOutput.split('\n');
        const versionLine = lines[0];
        const configLine = lines[1];
        
        // Extract version info
        const versionMatch = versionLine.match(/ffmpeg version (.+?) Copyright/);
        const version = versionMatch ? versionMatch[1] : 'Unknown';
        
        // Extract build info
        const buildMatch = versionLine.match(/built with (.+?)$/);
        const buildInfo = buildMatch ? buildMatch[1] : 'Unknown';
        
        // Extract library versions
        const libVersions = {};
        lines.forEach(line => {
          const libMatch = line.match(/^lib(\w+)\s+(\d+\.\s*\d+\.\s*\d+)/);
          if (libMatch) {
            libVersions[libMatch[1]] = libMatch[2];
          }
        });
        
        res.json({
          success: true,
          ffmpeg: {
            path: ffmpegPath,
            source: configInfo.ffmpeg.source,
            version: version,
            buildInfo: buildInfo,
            configuration: configLine,
            libraries: libVersions,
            fullOutput: versionOutput,
            available: configInfo.ffmpeg.available
          },
          ffprobe: {
            path: ffprobePath,
            source: configInfo.ffprobe.source,
            available: configInfo.ffprobe.available
          },
          platform: configInfo.platform
        });
      } else {
        res.json({
          success: false,
          error: 'Failed to get FFmpeg version',
          ffmpeg: {
            path: ffmpegPath,
            source: configInfo.ffmpeg.source,
            available: configInfo.ffmpeg.available
          },
          ffprobe: {
            path: ffprobePath,
            source: configInfo.ffprobe.source,
            available: configInfo.ffprobe.available
          },
          platform: configInfo.platform
        });
      }
    });
    
  } catch (error) {
    console.error('FFmpeg info error:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// Telegram alerts routes
app.post('/telegram-alerts/save', isAuthenticated, [
  body('botToken').trim().matches(/^\d{6,}:[A-Za-z0-9_\-]{20,}$/).withMessage('Invalid bot token format'),
  body('chatId').trim().isLength({ min: 1 }).withMessage('Chat ID is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('telegram-alerts', {
        title: 'Telegram Alerts',
        active: 'telegram-alerts',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg
      });
    }
    const enabled = req.body.enabled === 'on' || req.body.enabled === 'true' || req.body.enabled === true;
    const alertOnStart = req.body.alertOnStart === 'on' || req.body.alertOnStart === 'true' || req.body.alertOnStart === true;
    const alertOnError = req.body.alertOnError === 'on' || req.body.alertOnError === 'true' || req.body.alertOnError === true;
    const alertOnStop = req.body.alertOnStop === 'on' || req.body.alertOnStop === 'true' || req.body.alertOnStop === true;
    await User.update(req.session.userId, {
      telegram_bot_token: req.body.botToken,
      telegram_chat_id: req.body.chatId,
      telegram_enabled: enabled ? 1 : 0,
      telegram_alert_on_start: alertOnStart ? 1 : 0,
      telegram_alert_on_error: alertOnError ? 1 : 0,
      telegram_alert_on_stop: alertOnStop ? 1 : 0,
    });
    return res.render('telegram-alerts', {
      title: 'Telegram Alerts',
      active: 'telegram-alerts',
      user: await User.findById(req.session.userId),
      success: 'Telegram settings saved successfully!'
    });
  } catch (error) {
    console.error('Error saving Telegram settings:', error);
    return res.render('telegram-alerts', {
      title: 'Telegram Alerts',
      active: 'telegram-alerts',
      user: await User.findById(req.session.userId),
      error: 'Failed to save Telegram settings'
    });
  }
});

app.post('/telegram-alerts/clear', isAuthenticated, async (req, res) => {
  try {
    await User.update(req.session.userId, {
      telegram_bot_token: null,
      telegram_chat_id: null,
      telegram_enabled: 0,
      telegram_alert_on_start: 0,
      telegram_alert_on_error: 0,
      telegram_alert_on_stop: 0,
    });
    return res.render('telegram-alerts', {
      title: 'Telegram Alerts',
      active: 'telegram-alerts',
      user: await User.findById(req.session.userId),
      success: 'Telegram API information cleared successfully!'
    });
  } catch (error) {
    console.error('Error clearing Telegram settings:', error);
    return res.render('telegram-alerts', {
      title: 'Telegram Alerts',
      active: 'telegram-alerts',
      user: await User.findById(req.session.userId),
      error: 'Failed to clear Telegram settings'
    });
  }
});

app.post('/telegram-alerts/test', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.telegram_bot_token || !user.telegram_chat_id) {
      return res.status(400).json({ success: false, error: 'Telegram token or chat id not set' });
    }
    const ok = await telegramService.sendMessage(user.telegram_bot_token, user.telegram_chat_id, '✅ Test message from Streamflow');
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to send test message' });
  }
});
app.delete('/api/history/:id', isAuthenticated, async (req, res) => {
  try {
    const db = require('./db/database').db;
    const historyId = req.params.id;
    const history = await new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM stream_history WHERE id = ? AND user_id = ?',
        [historyId, req.session.userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    if (!history) {
      return res.status(404).json({
        success: false,
        error: 'History entry not found or not authorized'
      });
    }
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM stream_history WHERE id = ?',
        [historyId],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
    res.json({ success: true, message: 'History entry deleted' });
  } catch (error) {
    console.error('Error deleting history entry:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete history entry'
    });
  }
});

app.delete('/api/history', isAuthenticated, async (req, res) => {
  try {
    const db = require('./db/database').db;
    const result = await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM stream_history WHERE user_id = ?',
        [req.session.userId],
        function (err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
    res.json({ 
      success: true, 
      message: `Deleted ${result.changes} history entries` 
    });
  } catch (error) {
    console.error('Error deleting all history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete all history'
    });
  }
});
app.get('/api/system-stats', isAuthenticated, async (req, res) => {
  try {
    const stats = await systemMonitor.getSystemStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.keys(interfaces).forEach((ifname) => {
    interfaces[ifname].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });
  return addresses.length > 0 ? addresses : ['localhost'];
}
app.post('/settings/profile', isAuthenticated, upload.single('avatar'), [
  body('username')
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'profile'
      });
    }
    const currentUser = await User.findById(req.session.userId);
    if (req.body.username !== currentUser.username) {
      const existingUser = await User.findByUsername(req.body.username);
      if (existingUser) {
        return res.render('settings', {
          title: 'Settings',
          active: 'settings',
          user: currentUser,
          error: 'Username is already taken',
          activeTab: 'profile'
        });
      }
    }
    const updateData = {
      username: req.body.username
    };
    if (req.file) {
      updateData.avatar_path = `/uploads/avatars/${req.file.filename}`;
    }
    await User.update(req.session.userId, updateData);
    req.session.username = updateData.username;
    if (updateData.avatar_path) {
      req.session.avatar_path = updateData.avatar_path;
    }
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Profile updated successfully!',
      activeTab: 'profile'
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while updating your profile',
      activeTab: 'profile'
    });
  }
});
app.post('/settings/password', isAuthenticated, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('confirmPassword')
    .custom((value, { req }) => value === req.body.newPassword)
    .withMessage('Passwords do not match'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'security'
      });
    }
    const user = await User.findById(req.session.userId);
    const passwordMatch = await User.verifyPassword(req.body.currentPassword, user.password);
    if (!passwordMatch) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: user,
        error: 'Current password is incorrect',
        activeTab: 'security'
      });
    }
    const hashedPassword = await bcrypt.hash(req.body.newPassword, 10);
    await User.update(req.session.userId, { password: hashedPassword });
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Password changed successfully',
      activeTab: 'security'
    });
  } catch (error) {
    console.error('Error changing password:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while changing your password',
      activeTab: 'security'
    });
  }
});
app.get('/settings', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.redirect('/login');
    }
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: user
    });
  } catch (error) {
    console.error('Settings error:', error);
    res.redirect('/dashboard');
  }
});
app.post('/settings/integrations/gdrive', isAuthenticated, [
  body('apiKey').notEmpty().withMessage('API Key is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'integrations'
      });
    }
    await User.update(req.session.userId, {
      gdrive_api_key: req.body.apiKey
    });
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Google Drive API key saved successfully!',
      activeTab: 'integrations'
    });
  } catch (error) {
    console.error('Error saving Google Drive API key:', error);
    res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'An error occurred while saving your Google Drive API key',
      activeTab: 'integrations'
    });
  }
});

// Telegram settings
app.post('/settings/integrations/telegram', isAuthenticated, [
  body('botToken').trim().matches(/^\d{6,}:[A-Za-z0-9_\-]{20,}$/).withMessage('Invalid bot token format'),
  body('chatId').trim().isLength({ min: 1 }).withMessage('Chat ID is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('settings', {
        title: 'Settings',
        active: 'settings',
        user: await User.findById(req.session.userId),
        error: errors.array()[0].msg,
        activeTab: 'integrations'
      });
    }
    const enabled = req.body.enabled === 'on' || req.body.enabled === 'true' || req.body.enabled === true;
    const alertOnStart = req.body.alertOnStart === 'on' || req.body.alertOnStart === 'true' || req.body.alertOnStart === true;
    const alertOnError = req.body.alertOnError === 'on' || req.body.alertOnError === 'true' || req.body.alertOnError === true;
    const alertOnStop = req.body.alertOnStop === 'on' || req.body.alertOnStop === 'true' || req.body.alertOnStop === true;
    await User.update(req.session.userId, {
      telegram_bot_token: req.body.botToken,
      telegram_chat_id: req.body.chatId,
      telegram_enabled: enabled ? 1 : 0,
      telegram_alert_on_start: alertOnStart ? 1 : 0,
      telegram_alert_on_error: alertOnError ? 1 : 0,
      telegram_alert_on_stop: alertOnStop ? 1 : 0,
    });
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      success: 'Telegram settings saved',
      activeTab: 'integrations'
    });
  } catch (error) {
    console.error('Error saving Telegram settings:', error);
    return res.render('settings', {
      title: 'Settings',
      active: 'settings',
      user: await User.findById(req.session.userId),
      error: 'Failed to save Telegram settings',
      activeTab: 'integrations'
    });
  }
});

app.post('/settings/integrations/telegram/test', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user || !user.telegram_bot_token || !user.telegram_chat_id) {
      return res.status(400).json({ success: false, error: 'Telegram token or chat id not set' });
    }
    const ok = await telegramService.sendMessage(user.telegram_bot_token, user.telegram_chat_id, '✅ Test message from Streamflow');
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to send test message' });
  }
});
app.post('/upload/video', isAuthenticated, uploadVideo.single('video'), async (req, res) => {
  try {
    console.log('Upload request received:', req.file);
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    const { filename, originalname, path: videoPath, mimetype, size } = req.file;
    const thumbnailName = path.basename(filename, path.extname(filename)) + '.jpg';
    const videoInfo = await getVideoInfo(videoPath);
    const thumbnailRelativePath = await generateThumbnail(videoPath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);
    let format = 'unknown';
    if (mimetype === 'video/mp4') format = 'mp4';
    else if (mimetype === 'video/avi') format = 'avi';
    else if (mimetype === 'video/quicktime') format = 'mov';
    const videoData = {
      title: path.basename(originalname, path.extname(originalname)),
      original_filename: originalname,
      filepath: `/uploads/videos/${filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: size,
      duration: videoInfo.duration,
      format: format,
      user_id: req.session.userId
    };
    const video = await Video.create(videoData);
    res.json({
      success: true,
      video: {
        id: video.id,
        title: video.title,
        filepath: video.filepath,
        thumbnail_path: video.thumbnail_path,
        duration: video.duration,
        file_size: video.file_size,
        format: video.format
      }
    });
  } catch (error) {
    console.error('Upload error details:', error);
    res.status(500).json({ 
      error: 'Failed to upload video',
      details: error.message 
    });
  }
});
app.post('/api/videos/upload', isAuthenticated, videoUpload.single('video'), async (req, res) => {
  try {
    console.log('Upload request received:', req.file);

    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    let title = path.parse(req.file.originalname).name;
    const filePath = `/uploads/videos/${req.file.filename}`;
    const fullFilePath = path.join(__dirname, 'public', filePath);
    const fileSize = req.file.size;
    const folderPath = req.body.folderPath || 'Default';

    // Create folder if it doesn't exist and it's not 'Default'
    if (folderPath !== 'Default') {
      try {
        const existingFolder = await new Promise((resolve, reject) => {
          db.get(
            'SELECT 1 FROM folders WHERE user_id = ? AND name = ? LIMIT 1',
            [req.session.userId, folderPath],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!existingFolder) {
          const folderId = uuidv4();
          await new Promise((resolve, reject) => {
            db.run(
              'INSERT INTO folders (id, name, user_id) VALUES (?, ?, ?)',
              [folderId, folderPath, req.session.userId],
              function (err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          console.log(`Created new folder: ${folderPath}`);
        }
      } catch (error) {
        console.error('Error creating folder:', error);
        // Continue with upload even if folder creation fails
      }
    }
    await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(fullFilePath, (err, metadata) => {
        if (err) {
          console.error('Error extracting metadata:', err);
          return reject(err);
        }
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        const duration = metadata.format.duration || 0;
        const format = metadata.format.format_name || '';
        const resolution = videoStream ? `${videoStream.width}x${videoStream.height}` : '';
        const bitrate = metadata.format.bit_rate ?
          Math.round(parseInt(metadata.format.bit_rate) / 1000) :
          null;
        let fps = null;
        if (videoStream && videoStream.avg_frame_rate) {
          const fpsRatio = videoStream.avg_frame_rate.split('/');
          if (fpsRatio.length === 2 && parseInt(fpsRatio[1]) !== 0) {
            fps = Math.round((parseInt(fpsRatio[0]) / parseInt(fpsRatio[1]) * 100)) / 100;
          } else {
            fps = parseInt(fpsRatio[0]) || null;
          }
        }
        const thumbnailFilename = `thumb-${path.parse(req.file.filename).name}.jpg`;
        const thumbnailPath = `/uploads/thumbnails/${thumbnailFilename}`;
        const fullThumbnailPath = path.join(__dirname, 'public', thumbnailPath);
        ffmpeg(fullFilePath)
          .screenshots({
            timestamps: ['10%'],
            filename: thumbnailFilename,
            folder: path.join(__dirname, 'public', 'uploads', 'thumbnails'),
            size: '854x480'
          })
          .on('end', async () => {
            try {
              const videoData = {
                title,
                filepath: filePath,
                thumbnail_path: thumbnailPath,
                file_size: fileSize,
                duration,
                format,
                resolution,
                bitrate,
                fps,
                folder_path: folderPath,
                user_id: req.session.userId
              };
              const video = await Video.create(videoData);
              res.json({
                success: true,
                message: 'Video uploaded successfully',
                video
              });
              resolve();
            } catch (dbError) {
              console.error('Database error:', dbError);
              reject(dbError);
            }
          })
          .on('error', (err) => {
            console.error('Error creating thumbnail:', err);
            reject(err);
          });
      });
    });
  } catch (error) {
    console.error('Upload error details:', error);
    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});
app.get('/api/videos/folders', isAuthenticated, async (req, res) => {
  try {
    // Get folders from both the folders table and from videos (for backward compatibility)
    const customFolders = await new Promise((resolve, reject) => {
      db.all(
        'SELECT name FROM folders WHERE user_id = ? ORDER BY name',
        [req.session.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map(row => row.name));
        }
      );
    });

    const videoFolders = await new Promise((resolve, reject) => {
      db.all(
        'SELECT DISTINCT folder_path FROM videos WHERE user_id = ? AND folder_path IS NOT NULL ORDER BY folder_path',
        [req.session.userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map(row => row.folder_path));
        }
      );
    });

    // Combine and deduplicate folders
    const allFolders = [...new Set([...customFolders, ...videoFolders])];

    // Ensure Default folder is always present
    if (!allFolders.includes('Default')) {
      allFolders.unshift('Default');
    }

    res.json({ success: true, folders: allFolders.sort() });
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch folders' });
  }
});

app.post('/api/videos/folders', isAuthenticated, [
  body('folderName').trim().isLength({ min: 1 }).withMessage('Folder name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { folderName } = req.body;

    if (folderName === 'Default') {
      return res.status(400).json({ success: false, error: 'Cannot create folder with reserved name "Default"' });
    }

    // Check if folder already exists in folders table
    const existingCustomFolder = await new Promise((resolve, reject) => {
      db.get(
        'SELECT 1 FROM folders WHERE user_id = ? AND name = ? LIMIT 1',
        [req.session.userId, folderName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existingCustomFolder) {
      return res.status(400).json({ success: false, error: 'Folder already exists' });
    }

    // Check if folder exists in videos table (for backward compatibility)
    const existingVideoFolder = await new Promise((resolve, reject) => {
      db.get(
        'SELECT 1 FROM videos WHERE user_id = ? AND folder_path = ? LIMIT 1',
        [req.session.userId, folderName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existingVideoFolder) {
      return res.status(400).json({ success: false, error: 'Folder already exists' });
    }

    // Create the folder in the folders table
    const folderId = uuidv4();
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO folders (id, name, user_id) VALUES (?, ?, ?)',
        [folderId, folderName, req.session.userId],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true, message: 'Folder created successfully', folderName });
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ success: false, error: 'Failed to create folder' });
  }
});

app.put('/api/videos/:id/move', isAuthenticated, [
  body('folderPath').trim().isLength({ min: 1 }).withMessage('Folder path is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const videoId = req.params.id;
    const { folderPath } = req.body;

    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await Video.update(videoId, { folder_path: folderPath });
    res.json({ success: true, message: 'Video moved successfully' });
  } catch (error) {
    console.error('Error moving video:', error);
    res.status(500).json({ success: false, error: 'Failed to move video' });
  }
});

app.put('/api/folders/:folderName/rename', isAuthenticated, [
  body('newName').trim().isLength({ min: 1 }).withMessage('New folder name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { folderName } = req.params;
    const { newName } = req.body;

    if (folderName === 'Default') {
      return res.status(400).json({ success: false, error: 'Cannot rename default folder' });
    }

    if (newName === 'Default') {
      return res.status(400).json({ success: false, error: 'Cannot use reserved name "Default"' });
    }

    // Check if new name already exists
    const existingFolder = await new Promise((resolve, reject) => {
      db.get(
        'SELECT 1 FROM folders WHERE user_id = ? AND name = ? LIMIT 1',
        [req.session.userId, newName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const existingVideoFolder = await new Promise((resolve, reject) => {
      db.get(
        'SELECT 1 FROM videos WHERE user_id = ? AND folder_path = ? LIMIT 1',
        [req.session.userId, newName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existingFolder || existingVideoFolder) {
      return res.status(400).json({ success: false, error: 'Folder name already exists' });
    }

    // Update folder name in folders table
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND name = ?',
        [newName, req.session.userId, folderName],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Update all videos in the folder
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE videos SET folder_path = ? WHERE user_id = ? AND folder_path = ?',
        [newName, req.session.userId, folderName],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true, message: 'Folder renamed successfully' });
  } catch (error) {
    console.error('Error renaming folder:', error);
    res.status(500).json({ success: false, error: 'Failed to rename folder' });
  }
});

app.delete('/api/folders/:folderName', isAuthenticated, async (req, res) => {
  try {
    const { folderName } = req.params;

    if (folderName === 'Default') {
      return res.status(400).json({ success: false, error: 'Cannot delete default folder' });
    }

    // Delete from folders table
    await new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM folders WHERE user_id = ? AND name = ?',
        [req.session.userId, folderName],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Move all videos in this folder to Default
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE videos SET folder_path = ? WHERE user_id = ? AND folder_path = ?',
        ['Default', req.session.userId, folderName],
        function (err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.json({ success: true, message: 'Folder deleted successfully. Videos moved to Default folder.' });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ success: false, error: 'Failed to delete folder' });
  }
});

app.get('/api/videos', isAuthenticated, async (req, res) => {
  try {
    const videos = await Video.findAll(req.session.userId);
    res.json({ success: true, videos });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
});
// Reset usage counter for selected videos
app.post('/api/videos/reset-usage', isAuthenticated, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No video ids provided' });
    }
    const placeholders = ids.map(() => '?').join(',');
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE videos SET used_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND user_id = ?`,
        [...ids, req.session.userId],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting usage for selected videos:', error);
    res.status(500).json({ success: false, error: 'Failed to reset usage' });
  }
});
// Reset usage counter for all videos in a folder
app.post('/api/videos/folders/:folder/reset-usage', isAuthenticated, async (req, res) => {
  try {
    const folder = req.params.folder;
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE videos SET used_count = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND (folder_path = ? OR (? = 'Default' AND (folder_path IS NULL OR TRIM(folder_path) = '' OR folder_path = 'Default')))`,
        [req.session.userId, folder, folder],
        function (err) {
          if (err) return reject(err);
          resolve();
        }
      );
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error resetting usage for folder:', error);
    res.status(500).json({ success: false, error: 'Failed to reset folder usage' });
  }
});
app.delete('/api/videos/:id', isAuthenticated, async (req, res) => {
  try {
    const videoId = req.params.id;
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).json({ success: false, error: 'Video not found' });
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const videoPath = path.join(__dirname, 'public', video.filepath);
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
    }
    if (video.thumbnail_path) {
      const thumbnailPath = path.join(__dirname, 'public', video.thumbnail_path);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }
    await Video.delete(videoId, req.session.userId);
    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ success: false, error: 'Failed to delete video' });
  }
});
app.post('/api/videos/:id/rename', isAuthenticated, [
  body('title').trim().isLength({ min: 1 }).withMessage('Title cannot be empty')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const video = await Video.findById(req.params.id);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'You don\'t have permission to rename this video' });
    }
    await Video.update(req.params.id, { title: req.body.title });
    res.json({ success: true, message: 'Video renamed successfully' });
  } catch (error) {
    console.error('Error renaming video:', error);
    res.status(500).json({ error: 'Failed to rename video' });
  }
});
app.get('/stream/:videoId', isAuthenticated, async (req, res) => {
  try {
    const videoId = req.params.videoId;
    const video = await Video.findById(videoId);
    if (!video) {
      return res.status(404).send('Video not found');
    }
    if (video.user_id !== req.session.userId) {
      return res.status(403).send('You do not have permission to access this video');
    }
    const videoPath = path.join(__dirname, 'public', video.filepath);
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const file = fs.createReadStream(videoPath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).send('Error streaming video');
  }
});
app.get('/api/settings/gdrive-status', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    res.json({
      hasApiKey: !!user.gdrive_api_key,
      message: user.gdrive_api_key ? 'Google Drive API key is configured' : 'No Google Drive API key found'
    });
  } catch (error) {
    console.error('Error checking Google Drive API status:', error);
    res.status(500).json({ error: 'Failed to check API key status' });
  }
});
app.post('/api/settings/gdrive-api-key', isAuthenticated, [
  body('apiKey').notEmpty().withMessage('API Key is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }
    await User.update(req.session.userId, {
      gdrive_api_key: req.body.apiKey
    });
    return res.json({
      success: true,
      message: 'Google Drive API key saved successfully!'
    });
  } catch (error) {
    console.error('Error saving Google Drive API key:', error);
    res.status(500).json({
      success: false,
      error: 'An error occurred while saving your Google Drive API key'
    });
  }
});
app.post('/api/videos/import-drive', isAuthenticated, [
  body('driveUrl').notEmpty().withMessage('Google Drive URL is required'),
  body('folderPath').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const { driveUrl, folderPath } = req.body;
    const user = await User.findById(req.session.userId);
    if (!user.gdrive_api_key) {
      return res.status(400).json({
        success: false,
        error: 'Google Drive API key is not configured'
      });
    }

    // Create folder if it doesn't exist and it's not 'Default'
    if (folderPath && folderPath !== 'Default') {
      try {
        const existingFolder = await new Promise((resolve, reject) => {
          db.get(
            'SELECT 1 FROM folders WHERE user_id = ? AND name = ? LIMIT 1',
            [req.session.userId, folderPath],
            (err, row) => {
              if (err) reject(err);
              else resolve(row);
            }
          );
        });

        if (!existingFolder) {
          const folderId = uuidv4();
          await new Promise((resolve, reject) => {
            db.run(
              'INSERT INTO folders (id, name, user_id) VALUES (?, ?, ?)',
              [folderId, folderPath, req.session.userId],
              function (err) {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          console.log(`Created new folder for Google Drive import: ${folderPath}`);
        }
      } catch (error) {
        console.error('Error creating folder for Google Drive import:', error);
        // Continue with import even if folder creation fails
      }
    }
    const { extractFileId, extractFolderId, isFolder } = require('./utils/googleDriveService');
    try {
      let resourceId;
      let isGoogleFolder = false;

      // First try to extract as folder
      try {
        resourceId = extractFolderId(driveUrl);
        isGoogleFolder = await isFolder(user.gdrive_api_key, resourceId);
      } catch (folderError) {
        // If folder extraction fails, try file extraction
        try {
          resourceId = extractFileId(driveUrl);
        } catch (fileError) {
          throw new Error('Invalid Google Drive URL format');
        }
      }

      const jobId = uuidv4();

      if (isGoogleFolder) {
        processGoogleDriveFolderImport(jobId, user.gdrive_api_key, resourceId, req.session.userId, folderPath)
          .catch(err => console.error('Drive folder import failed:', err));
      } else {
        processGoogleDriveImport(jobId, user.gdrive_api_key, resourceId, req.session.userId, folderPath)
          .catch(err => console.error('Drive import failed:', err));
      }

      return res.json({
        success: true,
        message: isGoogleFolder ? 'Folder import started' : 'Video import started',
        jobId: jobId,
        isFolder: isGoogleFolder
      });
    } catch (error) {
      console.error('Google Drive URL parsing error:', error);
      return res.status(400).json({
        success: false,
        error: 'Invalid Google Drive URL format'
      });
    }
  } catch (error) {
    console.error('Error importing from Google Drive:', error);
    res.status(500).json({ success: false, error: 'Failed to import video' });
  }
});
app.get('/api/videos/import-status/:jobId', isAuthenticated, async (req, res) => {
  const jobId = req.params.jobId;
  if (!importJobs[jobId]) {
    return res.status(404).json({ success: false, error: 'Import job not found' });
  }
  return res.json({
    success: true,
    status: importJobs[jobId]
  });
});

// Stream Key Groups API endpoints
app.get('/api/stream-key-groups', isAuthenticated, async (req, res) => {
  try {
    const groups = await StreamKeyGroup.findAll(req.session.userId);
    res.json({ success: true, groups });
  } catch (error) {
    console.error('Error fetching stream key groups:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream key groups' });
  }
});

app.post('/api/stream-key-groups', isAuthenticated, [
  body('name').trim().isLength({ min: 1 }).withMessage('Group name is required'),
  body('description').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { name, description } = req.body;
    
    // Check if group name already exists
    const nameExists = await StreamKeyGroup.isNameInUse(name, req.session.userId);
    if (nameExists) {
      return res.status(400).json({ success: false, error: 'Group name already exists' });
    }

    const group = await StreamKeyGroup.create({
      name,
      description,
      user_id: req.session.userId
    });

    res.status(201).json({ success: true, group });
  } catch (error) {
    console.error('Error creating stream key group:', error);
    res.status(500).json({ success: false, error: 'Failed to create stream key group' });
  }
});

app.put('/api/stream-key-groups/:id', isAuthenticated, [
  body('name').optional().trim().isLength({ min: 1 }).withMessage('Group name cannot be empty'),
  body('description').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { id } = req.params;
    const { name, description } = req.body;

    // Check if group exists
    const group = await StreamKeyGroup.findById(id);
    if (!group || group.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    // Check if new name already exists (if name is being changed)
    if (name && name !== group.name) {
      const nameExists = await StreamKeyGroup.isNameInUse(name, req.session.userId, id);
      if (nameExists) {
        return res.status(400).json({ success: false, error: 'Group name already exists' });
      }
    }

    const updatedGroup = await StreamKeyGroup.update(id, { name, description });
    res.json({ success: true, group: updatedGroup });
  } catch (error) {
    console.error('Error updating stream key group:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream key group' });
  }
});

app.delete('/api/stream-key-groups/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    
    // First, delete all stream keys in this group
    const StreamKey = require('./models/StreamKey');
    const streamKeysInGroup = await StreamKey.findByGroupId(id, req.session.userId);
    
    for (const streamKey of streamKeysInGroup) {
      await StreamKey.delete(streamKey.id, req.session.userId);
    }
    
    // Then delete the group
    const result = await StreamKeyGroup.delete(id, req.session.userId);
    
    if (!result.deleted) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    res.json({ 
      success: true, 
      message: `Group and ${streamKeysInGroup.length} stream keys deleted successfully` 
    });
  } catch (error) {
    console.error('Error deleting stream key group:', error);
    res.status(500).json({ success: false, error: 'Failed to delete stream key group' });
  }
});

// Stream Keys API endpoints
app.get('/api/stream-keys', isAuthenticated, async (req, res) => {
  try {
    const streamKeys = await StreamKey.findAll(req.session.userId);
    
    // Add usage information for each stream key
    const streamKeysWithUsage = await Promise.all(
      streamKeys.map(async (key) => {
        const isUsedInStreams = await StreamKey.isStreamKeyUsedInStreams(key.stream_key, req.session.userId);
        return {
          ...key,
          is_used_in_streams: isUsedInStreams
        };
      })
    );
    
    res.json({ success: true, streamKeys: streamKeysWithUsage });
  } catch (error) {
    console.error('Error fetching stream keys:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream keys' });
  }
});

app.post('/api/stream-keys', isAuthenticated, [
  body('group_id').trim().isLength({ min: 1 }).withMessage('Group ID is required'),
  // name optional; fallback to stream_key if missing
  body('stream_key').trim().isLength({ min: 1 }).withMessage('Stream key is required'),
  body('rtmp_url').optional().custom((value) => {
    if (!value) return true; // Optional field
    // Check if it's a valid RTMP URL or just a hostname
    const rtmpPattern = /^(rtmp:\/\/)?([a-zA-Z0-9.-]+)(:\d+)?(\/.*)?$/;
    if (rtmpPattern.test(value)) return true;
    throw new Error('Invalid RTMP URL format');
  }),
  body('platform').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    let { group_id, name, stream_key, rtmp_url, platform, platform_icon } = req.body;
    // Normalize and validate stream_key early to avoid false duplicate errors
    stream_key = (stream_key || '').trim();
    if (!stream_key) {
      return res.status(400).json({ success: false, error: 'Stream key is required' });
    }
    // Use stream key as display name if name not provided
    if (!name || !name.trim()) {
      name = stream_key;
    }

    // Check if group exists
    const group = await StreamKeyGroup.findById(group_id);
    if (!group || group.user_id !== req.session.userId) {
      return res.status(400).json({ success: false, error: 'Group not found' });
    }

    // Check if stream key already exists
    const existingKey = await StreamKey.isStreamKeyInUse(stream_key, req.session.userId);
    if (existingKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'Stream key already exists' 
      });
    }

    const streamKeyData = {
      group_id,
      name,
      stream_key,
      rtmp_url,
      platform,
      platform_icon,
      user_id: req.session.userId
    };

    const streamKey = await StreamKey.create(streamKeyData);
    res.json({ success: true, streamKey });
  } catch (error) {
    console.error('Error creating stream key:', error);
    res.status(500).json({ success: false, error: 'Failed to create stream key' });
  }
});

app.put('/api/stream-keys/:id', isAuthenticated, [
  body('name').optional().trim().isLength({ min: 1 }).withMessage('Stream key name cannot be empty'),
  body('stream_key').optional().trim().isLength({ min: 1 }).withMessage('Stream key cannot be empty'),
  body('rtmp_url').optional().custom((value) => {
    if (!value) return true; // Optional field
    // Check if it's a valid RTMP URL or just a hostname
    const rtmpPattern = /^(rtmp:\/\/)?([a-zA-Z0-9.-]+)(:\d+)?(\/.*)?$/;
    if (rtmpPattern.test(value)) return true;
    throw new Error('Invalid RTMP URL format');
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { id } = req.params;
    const { name, stream_key, rtmp_url, platform, platform_icon } = req.body;

    // Check if stream key exists and belongs to user
    const existingKey = await StreamKey.findById(id);
    if (!existingKey || existingKey.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Stream key not found' });
    }

    // If stream_key is being changed, check if new one already exists
    if (stream_key && stream_key !== existingKey.stream_key) {
      const keyInUse = await StreamKey.isStreamKeyInUse(stream_key, req.session.userId, id);
      if (keyInUse) {
        return res.status(400).json({ 
          success: false, 
          error: 'Stream key already exists' 
        });
      }
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (stream_key) updateData.stream_key = stream_key;
    if (rtmp_url !== undefined) updateData.rtmp_url = rtmp_url;
    if (platform !== undefined) updateData.platform = platform;
    if (platform_icon !== undefined) updateData.platform_icon = platform_icon;

    const streamKey = await StreamKey.update(id, updateData);
    res.json({ success: true, streamKey });
  } catch (error) {
    console.error('Error updating stream key:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream key' });
  }
});

app.delete('/api/stream-keys/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if stream key is being used in any streams
    const streamKey = await StreamKey.findById(id);
    if (!streamKey || streamKey.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Stream key not found' });
    }

    const isUsedInStreams = await StreamKey.isStreamKeyUsedInStreams(streamKey.stream_key, req.session.userId);
    if (isUsedInStreams) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete stream key that is currently being used in streams' 
      });
    }

    const result = await StreamKey.delete(id, req.session.userId);
    if (result.deleted) {
      res.json({ success: true, message: 'Stream key deleted successfully' });
    } else {
      res.status(404).json({ success: false, error: 'Stream key not found' });
    }
  } catch (error) {
    console.error('Error deleting stream key:', error);
    res.status(500).json({ success: false, error: 'Failed to delete stream key' });
  }
});

// Reset individual stream key
app.post('/api/stream-keys/:id/reset', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if stream key exists and belongs to user
    const streamKey = await StreamKey.findById(id);
    if (!streamKey || streamKey.user_id !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Stream key not found' });
    }

    // Stop any active streams using this key
    const activeStreams = await Stream.findActiveByStreamKey(streamKey.stream_key, req.session.userId);
    for (const stream of activeStreams) {
      try {
        await streamingService.stopStream(stream.id);
        console.log(`Stopped stream ${stream.id} using key ${streamKey.stream_key}`);
      } catch (error) {
        console.error(`Error stopping stream ${stream.id}:`, error);
      }
    }

    res.json({ success: true, message: 'Stream key reset successfully' });
  } catch (error) {
    console.error('Error resetting stream key:', error);
    res.status(500).json({ success: false, error: 'Failed to reset stream key' });
  }
});

// Reset all stream keys
app.post('/api/stream-keys/reset-all', isAuthenticated, async (req, res) => {
  try {
    // Get all stream keys for user
    const streamKeys = await StreamKey.findAll(req.session.userId);
    
    // Stop all active streams
    const activeStreams = await Stream.findActiveByUserId(req.session.userId);
    for (const stream of activeStreams) {
      try {
        await streamingService.stopStream(stream.id);
        console.log(`Stopped stream ${stream.id} during reset all`);
      } catch (error) {
        console.error(`Error stopping stream ${stream.id}:`, error);
      }
    }

    res.json({ success: true, message: 'All stream keys reset successfully' });
  } catch (error) {
    console.error('Error resetting all stream keys:', error);
    res.status(500).json({ success: false, error: 'Failed to reset all stream keys' });
  }
});
const importJobs = {};
async function processGoogleDriveImport(jobId, apiKey, fileId, userId, folderPath = 'Default') {
  const { downloadFile } = require('./utils/googleDriveService');
  const { getVideoInfo, generateThumbnail } = require('./utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');

  console.log('processGoogleDriveImport called with folderPath:', folderPath);

  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting download...'
  };

  try {
    const result = await downloadFile(apiKey, fileId, (progress) => {
      importJobs[jobId] = {
        status: 'downloading',
        progress: progress.progress,
        message: `Downloading ${progress.filename}: ${progress.progress}%`
      };
    }, folderPath);

    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: 'Processing video...'
    };

    const videoInfo = await getVideoInfo(result.localFilePath);

    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(result.localFilePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata);
      });
    });

    let resolution = '';
    let bitrate = null;

    const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
    if (videoStream) {
      resolution = `${videoStream.width}x${videoStream.height}`;
    }

    if (metadata.format && metadata.format.bit_rate) {
      bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
    }

    const thumbnailName = path.basename(result.filename, path.extname(result.filename)) + '.jpg';
    const thumbnailRelativePath = await generateThumbnail(result.localFilePath, thumbnailName)
      .then(() => `/uploads/thumbnails/${thumbnailName}`)
      .catch(() => null);

    let format = path.extname(result.filename).toLowerCase().replace('.', '');
    if (!format) format = 'mp4';

    const videoData = {
      title: path.basename(result.originalFilename, path.extname(result.originalFilename)),
      filepath: `/uploads/videos/${result.filename}`,
      thumbnail_path: thumbnailRelativePath,
      file_size: result.fileSize,
      duration: videoInfo.duration,
      format: format,
      resolution: resolution,
      bitrate: bitrate,
      folder_path: folderPath,
      user_id: userId
    };

    const video = await Video.create(videoData);

    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: 'Video imported successfully',
      videoId: video.id
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing Google Drive import:', error);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import video'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}

async function processGoogleDriveFolderImport(jobId, apiKey, folderId, userId, folderPath = 'Default') {
  const { downloadFolder } = require('./utils/googleDriveService');
  const { getVideoInfo, generateThumbnail } = require('./utils/videoProcessor');
  const ffmpeg = require('fluent-ffmpeg');

  console.log('processGoogleDriveFolderImport called with folderPath:', folderPath);

  importJobs[jobId] = {
    status: 'downloading',
    progress: 0,
    message: 'Starting folder download...'
  };

  try {
    const result = await downloadFolder(apiKey, folderId, (progress) => {
      importJobs[jobId] = {
        status: 'downloading',
        progress: progress.progress,
        message: `Downloading ${progress.currentFile || progress.filename}: ${progress.completed || 0}/${progress.total || 0} files (${progress.progress}%)`
      };
    }, folderPath);

    importJobs[jobId] = {
      status: 'processing',
      progress: 100,
      message: `Processing ${result.files.length} videos...`
    };

    const processedVideos = [];
    let processedCount = 0;

    for (const file of result.files) {
      try {
        const videoInfo = await getVideoInfo(file.localFilePath);

        const metadata = await new Promise((resolve, reject) => {
          ffmpeg.ffprobe(file.localFilePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
          });
        });

        let resolution = '';
        let bitrate = null;

        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (videoStream) {
          resolution = `${videoStream.width}x${videoStream.height}`;
        }

        if (metadata.format && metadata.format.bit_rate) {
          bitrate = Math.round(parseInt(metadata.format.bit_rate) / 1000);
        }

        const thumbnailName = path.basename(file.filename, path.extname(file.filename)) + '.jpg';
        const thumbnailRelativePath = await generateThumbnail(file.localFilePath, thumbnailName)
          .then(() => `/uploads/thumbnails/${thumbnailName}`)
          .catch(() => null);

        let format = path.extname(file.filename).toLowerCase().replace('.', '');
        if (!format) format = 'mp4';

        const videoData = {
          title: path.basename(file.originalFilename, path.extname(file.originalFilename)),
          filepath: `/uploads/videos/${file.filename}`,
          thumbnail_path: thumbnailRelativePath,
          file_size: file.fileSize,
          duration: videoInfo.duration,
          format: format,
          resolution: resolution,
          bitrate: bitrate,
          folder_path: folderPath,
          user_id: userId
        };

        const video = await Video.create(videoData);
        processedVideos.push(video);
        processedCount++;

        // Update progress
        const processingProgress = Math.round((processedCount / result.files.length) * 100);
        importJobs[jobId] = {
          status: 'processing',
          progress: processingProgress,
          message: `Processed ${processedCount}/${result.files.length} videos...`
        };

      } catch (error) {
        console.error(`Error processing video ${file.originalFilename}:`, error);
        // Continue with other files
      }
    }

    importJobs[jobId] = {
      status: 'complete',
      progress: 100,
      message: `Folder imported successfully: ${processedVideos.length}/${result.totalFiles} videos processed`,
      folderName: result.folderName,
      totalFiles: result.totalFiles,
      processedFiles: processedVideos.length
    };

    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  } catch (error) {
    console.error('Error processing Google Drive folder import:', error);
    importJobs[jobId] = {
      status: 'failed',
      progress: 0,
      message: error.message || 'Failed to import folder'
    };
    setTimeout(() => {
      delete importJobs[jobId];
    }, 5 * 60 * 1000);
  }
}
app.get('/api/stream/videos', isAuthenticated, async (req, res) => {
  try {
    const videos = await Video.findAll(req.session.userId);
    // Build map of videos currently in use with status information
    const videoStatusMap = await new Promise((resolve, reject) => {
      db.all(
        `SELECT video_id, 
                MAX(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS is_live,
                MAX(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS is_scheduled,
                MAX(CASE WHEN status IN ('live','scheduled') THEN 1 ELSE 0 END) AS in_use
         FROM streams
         WHERE user_id = ? AND video_id IS NOT NULL
         GROUP BY video_id`,
        [req.session.userId],
        (err, rows) => {
          if (err) return reject(err);
          const map = {};
          (rows || []).forEach(r => { 
            if (r.video_id) {
              map[r.video_id] = { 
                in_use: !!r.in_use,
                is_live: !!r.is_live,
                is_scheduled: !!r.is_scheduled,
                stream_status: r.is_live ? 'live' : (r.is_scheduled ? 'scheduled' : null)
              }; 
            }
          });
          resolve(map);
        }
      );
    });
    const formattedVideos = videos.map(video => {
      const duration = video.duration ? Math.floor(video.duration) : 0;
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      const formattedDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      const statusInfo = videoStatusMap[video.id] || { in_use: false, is_live: false, is_scheduled: false, stream_status: null };
      return {
        id: video.id,
        name: video.title,
        thumbnail: video.thumbnail_path,
        resolution: video.resolution || '1280x720',
        duration: formattedDuration,
        folder_path: video.folder_path || 'Default',
        used_count: typeof video.used_count === 'number' ? video.used_count : 0,
        in_use: statusInfo.in_use,
        is_live: statusInfo.is_live,
        is_scheduled: statusInfo.is_scheduled,
        stream_status: statusInfo.stream_status,
        url: `/stream/${video.id}`
      };
    });
    res.json(formattedVideos);
  } catch (error) {
    console.error('Error fetching videos for stream:', error);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});
const Stream = require('./models/Stream');
const StreamKey = require('./models/StreamKey');
const StreamKeyGroup = require('./models/StreamKeyGroup');
const { title } = require('process');
app.get('/api/streams', isAuthenticated, async (req, res) => {
  try {
    const filter = req.query.filter;
    const streams = await Stream.findAll(req.session.userId, filter);
    res.json({ success: true, streams });
  } catch (error) {
    console.error('Error fetching streams:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch streams' });
  }
});
// Bulk delete offline streams must be declared BEFORE parameterized routes
app.delete('/api/streams/offline', isAuthenticated, async (req, res) => {
  try {
    const result = await Stream.deleteOffline(req.session.userId);
    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error deleting offline streams:', error);
    return res.status(500).json({ success: false, error: 'Failed to delete offline streams' });
  }
});
app.post('/api/streams', isAuthenticated, [
  body('streamTitle').trim().isLength({ min: 1 }).withMessage('Title is required'),
  body('rtmpUrl').trim().isLength({ min: 1 }).withMessage('RTMP URL is required'),
  body('streamKey').trim().isLength({ min: 1 }).withMessage('Stream key is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const isInUse = await Stream.isStreamKeyInUse(req.body.streamKey, req.session.userId);
    if (isInUse) {
      return res.status(400).json({
        success: false,
        error: 'This stream key is already in use. Please use a different key.'
      });
    }

    // Optionally save manual key into a group (if requested)
    if (req.body.saveManualKey && req.body.saveManualKey.groupName) {
      try {
        const groupName = String(req.body.saveManualKey.groupName).trim();
        const stream_key = String(req.body.saveManualKey.streamKey || req.body.streamKey).trim();
        const rtmp_url = String(req.body.saveManualKey.rtmpUrl || req.body.rtmpUrl || '').trim();
        // Infer platform
        let platform = 'Custom';
        let platform_icon = 'ti-broadcast';
        if (rtmp_url.includes('youtube.com')) { platform = 'YouTube'; platform_icon = 'ti-brand-youtube'; }
        else if (rtmp_url.includes('facebook.com')) { platform = 'Facebook'; platform_icon = 'ti-brand-facebook'; }
        else if (rtmp_url.includes('twitch.tv')) { platform = 'Twitch'; platform_icon = 'ti-brand-twitch'; }
        else if (rtmp_url.includes('tiktok')) { platform = 'TikTok'; platform_icon = 'ti-brand-tiktok'; }
        else if (rtmp_url.includes('instagram')) { platform = 'Instagram'; platform_icon = 'ti-brand-instagram'; }
        else if (rtmp_url.includes('restream.io')) { platform = 'Restream.io'; platform_icon = 'ti-live-photo'; }

        // Find group by name or create
        const groups = await StreamKeyGroup.findAll(req.session.userId);
        let group = groups.find(g => g.name === groupName);
        if (!group) {
          group = await StreamKeyGroup.create({ name: groupName, description: null, user_id: req.session.userId });
        }
        // Create key only if not exists for this user
        const exists = await StreamKey.isStreamKeyInUse(stream_key, req.session.userId);
        if (!exists) {
          await StreamKey.create({
            group_id: group.id,
            name: stream_key,
            stream_key,
            rtmp_url: rtmp_url || null,
            platform,
            platform_icon,
            user_id: req.session.userId
          });
        }
      } catch (e) {
        console.error('Error saving manual key to group:', e);
        // Non-blocking
      }
    }
    let platform = 'Custom';
    let platform_icon = 'ti-broadcast';
    if (req.body.rtmpUrl.includes('youtube.com')) {
      platform = 'YouTube';
      platform_icon = 'ti-brand-youtube';
    } else if (req.body.rtmpUrl.includes('facebook.com')) {
      platform = 'Facebook';
      platform_icon = 'ti-brand-facebook';
    } else if (req.body.rtmpUrl.includes('twitch.tv')) {
      platform = 'Twitch';
      platform_icon = 'ti-brand-twitch';
    } else if (req.body.rtmpUrl.includes('tiktok.com')) {
      platform = 'TikTok';
      platform_icon = 'ti-brand-tiktok';
    } else if (req.body.rtmpUrl.includes('instagram.com')) {
      platform = 'Instagram';
      platform_icon = 'ti-brand-instagram';
    } else if (req.body.rtmpUrl.includes('shopee.io')) {
      platform = 'Shopee Live';
      platform_icon = 'ti-brand-shopee';
    } else if (req.body.rtmpUrl.includes('restream.io')) {
      platform = 'Restream.io';
      platform_icon = 'ti-live-photo';
    }
    const streamData = {
      title: req.body.streamTitle,
      video_id: req.body.videoId || null,
      rtmp_url: req.body.rtmpUrl,
      stream_key: req.body.streamKey,
      platform,
      platform_icon,
      bitrate: parseInt(req.body.bitrate) || 2500,
      resolution: req.body.resolution || '1280x720',
      fps: parseInt(req.body.fps) || 30,
      orientation: req.body.orientation || 'horizontal',
      loop_video: req.body.loopVideo === 'true' || req.body.loopVideo === true,
      use_advanced_settings: req.body.useAdvancedSettings === 'true' || req.body.useAdvancedSettings === true,
      user_id: req.session.userId
    };
    if (req.body.startNow) {
      // For start now, set status to live since it will be started immediately
      streamData.status = 'live';
    } else if (req.body.scheduleTime) {
      const scheduleDate = new Date(req.body.scheduleTime);
      
      const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      console.log(`[CREATE STREAM] Server timezone: ${serverTimezone}`);
      console.log(`[CREATE STREAM] Input time: ${req.body.scheduleTime}`);
      console.log(`[CREATE STREAM] Parsed time: ${scheduleDate.toISOString()}`);
      console.log(`[CREATE STREAM] Local display: ${scheduleDate.toLocaleString('en-US', { timeZone: serverTimezone })}`);
      
      streamData.schedule_time = scheduleDate.toISOString();
      streamData.status = 'scheduled';
      
      // Update last used for stream key if it exists in saved keys and stream is scheduled
      try {
        await StreamKey.updateLastUsedByStreamKey(req.body.streamKey, req.session.userId);
      } catch (error) {
        console.error('Error updating stream key last used:', error);
        // Don't fail the stream creation if this fails
      }
    } else {
      streamData.status = 'offline';
    }
    
    if (req.body.duration) {
      streamData.duration = parseInt(req.body.duration);
    }
    const stream = await Stream.create(streamData);
    // increment used_count for selected video
    if (streamData.video_id) {
      try { await Video.incrementUsedCount(streamData.video_id, 1); } catch(e) { console.error('used_count +1 failed', e.message); }
    }
    
    // Update last used for stream key if it exists in saved keys
    try {
      await StreamKey.updateLastUsedByStreamKey(req.body.streamKey, req.session.userId);
    } catch (error) {
      console.error('Error updating stream key last used:', error);
      // Don't fail the stream creation if this fails
    }
    
    // If startNow is true, start the stream immediately
    if (req.body.startNow) {
      try {
        console.log(`[CREATE STREAM] Starting stream immediately: ${stream.id}`);
        await streamingService.startStream(stream.id);
        console.log(`[CREATE STREAM] Stream started successfully: ${stream.id}`);
      } catch (error) {
        console.error(`[CREATE STREAM] Error starting stream immediately:`, error);
        // Don't fail the response, just log the error
      }
    }
    
    res.json({ success: true, stream });
  } catch (error) {
    console.error('Error creating stream:', error);
    res.status(500).json({ success: false, error: 'Failed to create stream' });
  }
});
app.get('/api/streams/:id', isAuthenticated, async (req, res) => {
  try {
    const stream = await Stream.getStreamWithVideo(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to access this stream' });
    }
    res.json({ success: true, stream });
  } catch (error) {
    console.error('Error fetching stream:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream' });
  }
});
app.put('/api/streams/:id', isAuthenticated, async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to update this stream' });
    }
    const updateData = {};
    if (req.body.streamTitle) updateData.title = req.body.streamTitle;
    if (req.body.videoId) updateData.video_id = req.body.videoId;
    if (req.body.rtmpUrl) updateData.rtmp_url = req.body.rtmpUrl;
    if (req.body.streamKey) updateData.stream_key = req.body.streamKey;
    if (req.body.bitrate) updateData.bitrate = parseInt(req.body.bitrate);
    if (req.body.resolution) updateData.resolution = req.body.resolution;
    if (req.body.fps) updateData.fps = parseInt(req.body.fps);
    if (req.body.orientation) updateData.orientation = req.body.orientation;
    if (req.body.loopVideo !== undefined) {
      updateData.loop_video = req.body.loopVideo === 'true' || req.body.loopVideo === true;
    }
    if (req.body.useAdvancedSettings !== undefined) {
      updateData.use_advanced_settings = req.body.useAdvancedSettings === 'true' || req.body.useAdvancedSettings === true;
    }
    // Handle duration (in minutes)
    if (req.body.duration !== undefined) {
      const parsedDuration = parseInt(req.body.duration, 10);
      if (!Number.isNaN(parsedDuration)) {
        updateData.duration = parsedDuration;
      }
    }
    if (req.body.scheduleTime) {
      const scheduleDate = new Date(req.body.scheduleTime);
      
      const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      console.log(`[UPDATE STREAM] Server timezone: ${serverTimezone}`);
      console.log(`[UPDATE STREAM] Input time: ${req.body.scheduleTime}`);
      console.log(`[UPDATE STREAM] Parsed time: ${scheduleDate.toISOString()}`);
      console.log(`[UPDATE STREAM] Local display: ${scheduleDate.toLocaleString('en-US', { timeZone: serverTimezone })}`);
      
      updateData.schedule_time = scheduleDate.toISOString();
      updateData.status = 'scheduled';
      
      // Update last used for stream key if it exists in saved keys and stream is scheduled
      try {
        await StreamKey.updateLastUsedByStreamKey(stream.stream_key, req.session.userId);
      } catch (error) {
        console.error('Error updating stream key last used:', error);
        // Don't fail the stream update if this fails
      }
    } else if ('scheduleTime' in req.body && !req.body.scheduleTime) {
      updateData.schedule_time = null;
      updateData.status = 'offline';
    }
    
    const updatedStream = await Stream.update(req.params.id, updateData);
    // if video_id changed, adjust used_count
    if (updateData.video_id && updateData.video_id !== stream.video_id) {
      try { if (stream.video_id) await Video.incrementUsedCount(stream.video_id, -1); } catch(e) { console.error('used_count -1 failed', e.message); }
      try { await Video.incrementUsedCount(updateData.video_id, 1); } catch(e) { console.error('used_count +1 failed', e.message); }
    }
    
    // Update last used for stream key if it exists in saved keys and was changed
    if (req.body.streamKey && req.body.streamKey !== stream.stream_key) {
      try {
        await StreamKey.updateLastUsedByStreamKey(req.body.streamKey, req.session.userId);
      } catch (error) {
        console.error('Error updating stream key last used:', error);
        // Don't fail the stream update if this fails
      }
    }
    
    // Update last used for stream key if it exists in saved keys and stream is scheduled
    if (req.body.scheduleTime && !req.body.streamKey) {
      try {
        await StreamKey.updateLastUsedByStreamKey(stream.stream_key, req.session.userId);
      } catch (error) {
        console.error('Error updating stream key last used:', error);
        // Don't fail the stream update if this fails
      }
    }
    
    res.json({ success: true, stream: updatedStream });
  } catch (error) {
    console.error('Error updating stream:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream' });
  }
});
app.delete('/api/streams/:id', isAuthenticated, async (req, res) => {
  try {
    const stream = await Stream.findById(req.params.id);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this stream' });
    }
    await Stream.delete(req.params.id, req.session.userId);
    // used_count should not decrease when stream is deleted
    // used_count can only be reset through folder manager
    res.json({ success: true, message: 'Stream deleted successfully' });
  } catch (error) {
    console.error('Error deleting stream:', error);
    res.status(500).json({ success: false, error: 'Failed to delete stream' });
  }
});
app.post('/api/streams/:id/status', isAuthenticated, [
  body('status').isIn(['live', 'offline', 'scheduled']).withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const newStatus = req.body.status;
    if (newStatus === 'live') {
      if (stream.status === 'live') {
        return res.json({
          success: false,
          error: 'Stream is already live',
          stream
        });
      }
      if (!stream.video_id) {
        return res.json({
          success: false,
          error: 'No video attached to this stream',
          stream
        });
      }
      const result = await streamingService.startStream(streamId);
      if (result.success) {
        // Update last used for stream key if it exists in saved keys
        try {
          await StreamKey.updateLastUsedByStreamKey(stream.stream_key, req.session.userId);
        } catch (error) {
          console.error('Error updating stream key last used:', error);
          // Don't fail the stream start if this fails
        }
        
        const updatedStream = await Stream.getStreamWithVideo(streamId);
        return res.json({
          success: true,
          stream: updatedStream,
          isAdvancedMode: result.isAdvancedMode
        });
      } else {
        return res.status(500).json({
          success: false,
          error: result.error || 'Failed to start stream'
        });
      }
    } else if (newStatus === 'offline') {
      if (stream.status === 'live') {
        const result = await streamingService.stopStream(streamId);
        if (!result.success) {
          console.warn('Failed to stop FFmpeg process:', result.error);
        }
        // Don't reset schedule_time for live streams to preserve scheduling info
        console.log(`Stopped live stream ${streamId}`);
      } else if (stream.status === 'scheduled') {
        await Stream.update(streamId, {
          schedule_time: null,
          status: 'offline'
        });
        console.log(`Scheduled stream ${streamId} was cancelled`);
      }
      const result = await Stream.updateStatus(streamId, 'offline', req.session.userId);
      if (!result.updated) {
        return res.status(404).json({
          success: false,
          error: 'Stream not found or not updated'
        });
      }
      return res.json({ success: true, stream: result });
    } else {
      const result = await Stream.updateStatus(streamId, newStatus, req.session.userId);
      if (!result.updated) {
        return res.status(404).json({
          success: false,
          error: 'Stream not found or not updated'
        });
      }
      
      // Update last used for stream key if it exists in saved keys and status is scheduled
      if (newStatus === 'scheduled') {
        try {
          await StreamKey.updateLastUsedByStreamKey(stream.stream_key, req.session.userId);
        } catch (error) {
          console.error('Error updating stream key last used:', error);
          // Don't fail the stream update if this fails
        }
      }
      
      return res.json({ success: true, stream: result });
    }
  } catch (error) {
    console.error('Error updating stream status:', error);
    res.status(500).json({ success: false, error: 'Failed to update stream status' });
  }
});
app.get('/api/streams/check-key', isAuthenticated, async (req, res) => {
  try {
    const streamKey = req.query.key;
    const excludeId = req.query.excludeId || null;
    if (!streamKey) {
      return res.status(400).json({
        success: false,
        error: 'Stream key is required'
      });
    }
    const isInUse = await Stream.isStreamKeyInUse(streamKey, req.session.userId, excludeId);
    res.json({
      success: true,
      isInUse: isInUse,
      message: isInUse ? 'Stream key is already in use' : 'Stream key is available'
    });
  } catch (error) {
    console.error('Error checking stream key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check stream key'
    });
  }
});
app.get('/api/streams/:id/logs', isAuthenticated, async (req, res) => {
  try {
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const logs = streamingService.getStreamLogs(streamId);
    const isActive = streamingService.isStreamActive(streamId);
    res.json({
      success: true,
      logs,
      isActive,
      stream
    });
  } catch (error) {
    console.error('Error fetching stream logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream logs' });
  }
});

// New endpoint for monitoring stream runtime
app.get('/api/streams/:id/runtime', isAuthenticated, async (req, res) => {
  try {
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    const runtimeInfo = streamingService.getStreamRuntimeInfo(streamId);
    const isActive = streamingService.isStreamActive(streamId);
    const scheduledTerminations = schedulerService.getScheduledTerminations();
    
    res.json({
      success: true,
      runtimeInfo,
      isActive,
      hasScheduledTermination: scheduledTerminations[streamId]?.hasScheduledTermination || false,
      stream: {
        id: stream.id,
        title: stream.title,
        duration: stream.duration,
        start_time: stream.start_time,
        status: stream.status
      }
    });
  } catch (error) {
    console.error('Error fetching stream runtime:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stream runtime' });
  }
});

// New endpoint for resetting stream runtime (for debugging)
app.post('/api/streams/:id/reset-runtime', isAuthenticated, async (req, res) => {
  try {
    const streamId = req.params.id;
    const stream = await Stream.findById(streamId);
    if (!stream) {
      return res.status(404).json({ success: false, error: 'Stream not found' });
    }
    if (stream.user_id !== req.session.userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    
    // Stop the stream if it's active
    if (streamingService.isStreamActive(streamId)) {
      await streamingService.stopStream(streamId);
    }
    
    // Reset runtime tracking
    streamingService.resetStreamRuntime(streamId);
    
    res.json({
      success: true,
      message: 'Stream runtime reset successfully'
    });
  } catch (error) {
    console.error('Error resetting stream runtime:', error);
    res.status(500).json({ success: false, error: 'Failed to reset stream runtime' });
  }
});

// New endpoint for getting all active streams with runtime info
app.get('/api/streams/active/status', isAuthenticated, async (req, res) => {
  try {
    const activeStreamIds = streamingService.getActiveStreams();
    const activeStreams = [];
    
    for (const streamId of activeStreamIds) {
      const stream = await Stream.findById(streamId);
      if (stream && stream.user_id === req.session.userId) {
        const runtimeInfo = streamingService.getStreamRuntimeInfo(streamId);
        const scheduledTerminations = schedulerService.getScheduledTerminations();
        
        activeStreams.push({
          id: stream.id,
          title: stream.title,
          duration: stream.duration,
          start_time: stream.start_time,
          runtimeInfo,
          hasScheduledTermination: scheduledTerminations[streamId]?.hasScheduledTermination || false
        });
      }
    }
    
    res.json({
      success: true,
      activeStreams,
      count: activeStreams.length
    });
  } catch (error) {
    console.error('Error fetching active streams status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch active streams status' });
  }
});

app.get('/api/server-time', (req, res) => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[now.getMonth()];
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const formattedTime = `${day} ${month} ${year} ${hours}:${minutes}:${seconds}`;
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const localISO = `${year}-${mm}-${day}T${hours}:${minutes}`; // server local time without timezone
  res.json({
    serverTime: now.toISOString(),
    formattedTime: formattedTime,
    localISO: localISO
  });
});

// API endpoint to manually check log size
app.get('/api/log-size-check', isAuthenticated, async (req, res) => {
  try {
    const logger = require('./services/logger');
    await logger.checkLogSizeNow();
    res.json({ 
      success: true, 
      message: 'Log size check completed' 
    });
  } catch (error) {
    console.error('Error checking log size:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check log size' 
    });
  }
});

// API endpoint to reset log size alert flag
app.post('/api/log-size-reset', isAuthenticated, async (req, res) => {
  try {
    const logger = require('./services/logger');
    logger.resetLogSizeAlert();
    res.json({ 
      success: true, 
      message: 'Log size alert flag reset' 
    });
  } catch (error) {
    console.error('Error resetting log size alert:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to reset log size alert' 
    });
  }
});

app.listen(port, '0.0.0.0', async () => {
  const ipAddresses = getLocalIpAddresses();
  console.log(`StreamFlow running at:`);
  if (ipAddresses && ipAddresses.length > 0) {
    ipAddresses.forEach(ip => {
      console.log(`  http://${ip}:${port}`);
    });
  } else {
    console.log(`  http://localhost:${port}`);
  }
  try {
    const streams = await Stream.findAll(null, 'live');
    if (streams && streams.length > 0) {
      console.log(`Resetting ${streams.length} live streams to offline state...`);
      for (const stream of streams) {
        await Stream.updateStatus(stream.id, 'offline');
      }
    }
  } catch (error) {
    console.error('Error resetting stream statuses:', error);
  }
  schedulerService.init(streamingService);
  try {
    await streamingService.syncStreamStatuses();
  } catch (error) {
    console.error('Failed to sync stream statuses:', error);
  }
});
