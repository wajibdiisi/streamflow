const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const dbDir = path.join(__dirname);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'streamflow.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  } else {
    createTables();
  }
});
function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar_path TEXT,
    gdrive_api_key TEXT,
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    telegram_enabled BOOLEAN DEFAULT 0,
    telegram_alert_on_start BOOLEAN DEFAULT 0,
    telegram_alert_on_error BOOLEAN DEFAULT 0,
    telegram_alert_on_stop BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`, (err) => {
    if (err) {
      console.error('Error creating users table:', err.message);
    }
  });
  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filepath TEXT NOT NULL,
    thumbnail_path TEXT,
    file_size INTEGER,
    duration REAL,
    format TEXT,
    resolution TEXT,
    bitrate INTEGER,
    fps TEXT,
    folder_path TEXT DEFAULT 'Default',
    used_count INTEGER DEFAULT 0,
    user_id TEXT,
    upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`, (err) => {
    if (err) {
      console.error('Error creating videos table:', err.message);
    }
  });

  // Add folder_path column to existing videos table if it doesn't exist
  db.run(`ALTER TABLE videos ADD COLUMN folder_path TEXT DEFAULT 'Default'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding folder_path column:', err.message);
    }
  });
  // Add used_count column to existing videos table if it doesn't exist
  db.run(`ALTER TABLE videos ADD COLUMN used_count INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding used_count column:', err.message);
    }
  });
  // Telegram columns migration for existing users table
  db.run(`ALTER TABLE users ADD COLUMN telegram_bot_token TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_bot_token column:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN telegram_chat_id TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_chat_id column:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN telegram_enabled BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_enabled column:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN telegram_alert_on_start BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_alert_on_start column:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN telegram_alert_on_error BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_alert_on_error column:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN telegram_alert_on_stop BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding telegram_alert_on_stop column:', err.message);
    }
  });

  // Add stop_time column to streams table
  db.run(`ALTER TABLE streams ADD COLUMN stop_time TIMESTAMP`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding stop_time column:', err.message);
    }
  });
  db.run(`CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    video_id TEXT,
    rtmp_url TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    platform TEXT,
    platform_icon TEXT,
    bitrate INTEGER DEFAULT 2500,
    resolution TEXT,
    fps INTEGER DEFAULT 30,
    orientation TEXT DEFAULT 'horizontal',
    loop_video BOOLEAN DEFAULT 1,
    schedule_time TIMESTAMP,
    duration INTEGER,
    status TEXT DEFAULT 'offline',
    status_updated_at TIMESTAMP,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    exp_stop_time TIMESTAMP,
    use_advanced_settings BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  )`, (err) => {
    if (err) {
      console.error('Error creating streams table:', err.message);
    }
  });

  // Add exp_stop_time column if it doesn't exist (migration)
  db.run(`ALTER TABLE streams ADD COLUMN exp_stop_time TIMESTAMP`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding exp_stop_time column:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(name, user_id)
  )`, (err) => {
    if (err) {
      console.error('Error creating folders table:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS stream_history (
    id TEXT PRIMARY KEY,
    stream_id TEXT,
    title TEXT NOT NULL,
    platform TEXT,
    platform_icon TEXT,
    video_id TEXT,
    video_title TEXT,
    resolution TEXT,
    bitrate INTEGER,
    fps INTEGER,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    duration INTEGER,
    use_advanced_settings BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (stream_id) REFERENCES streams(id),
    FOREIGN KEY (video_id) REFERENCES videos(id)
  )`, (err) => {
    if (err) {
      console.error('Error creating stream_history table:', err.message);
    }
  });

  // Create stream_key_groups table
  db.run(`CREATE TABLE IF NOT EXISTS stream_key_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(name, user_id)
  )`, (err) => {
    if (err) {
      console.error('Error creating stream_key_groups table:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS stream_keys (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    rtmp_url TEXT,
    platform TEXT,
    platform_icon TEXT,
    is_active BOOLEAN DEFAULT 0,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT NOT NULL,
    FOREIGN KEY (group_id) REFERENCES stream_key_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(stream_key, user_id)
  )`, (err) => {
    if (err) {
      console.error('Error creating stream_keys table:', err.message);
    }
  });

  // Run migrations after ensuring tables exist
  migrateStreamKeysGroupId();
}

// Migration: add group_id column to existing stream_keys table and backfill
function migrateStreamKeysGroupId() {
  // Check if column group_id exists
  db.all(`PRAGMA table_info(stream_keys)`, (err, rows) => {
    if (err) {
      console.error('Error reading stream_keys schema:', err.message);
      return;
    }

    const hasGroupId = Array.isArray(rows) && rows.some((r) => r.name === 'group_id');
    if (hasGroupId) {
      return; // Nothing to do
    }

    db.serialize(() => {
      // 1) Add the column (nullable for legacy rows)
      db.run(`ALTER TABLE stream_keys ADD COLUMN group_id TEXT`, (alterErr) => {
        if (alterErr) {
          // If it's anything other than duplicate, log and stop
          if (!alterErr.message.includes('duplicate column name')) {
            console.error('Error adding group_id to stream_keys:', alterErr.message);
            return;
          }
        }

        // 2) For each user, ensure a default group exists and backfill
        db.all(`SELECT DISTINCT user_id FROM stream_keys WHERE user_id IS NOT NULL`, (usersErr, users) => {
          if (usersErr) {
            console.error('Error selecting users for backfill:', usersErr.message);
            return;
          }
          if (!users || users.length === 0) {
            return;
          }

          users.forEach((u) => {
            const userId = u.user_id;
            // Check if a default group exists
            db.get(`SELECT id FROM stream_key_groups WHERE user_id = ? AND name = ?`, [userId, 'Default'], (getErr, row) => {
              if (getErr) {
                console.error('Error checking default group:', getErr.message);
                return;
              }

              const ensureBackfill = (groupId) => {
                db.run(
                  `UPDATE stream_keys SET group_id = ? WHERE user_id = ? AND (group_id IS NULL OR group_id = '')`,
                  [groupId, userId],
                  (updErr) => {
                    if (updErr) {
                      console.error('Error backfilling group_id for user:', userId, updErr.message);
                    }
                  }
                );
              };

              if (row && row.id) {
                ensureBackfill(row.id);
              } else {
                // Create default group
                const newGroupId = uuidv4();
                const now = new Date().toISOString();
                db.run(
                  `INSERT INTO stream_key_groups (id, name, description, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
                  [newGroupId, 'Default', 'Auto-created group', userId, now, now],
                  (insErr) => {
                    if (insErr) {
                      console.error('Error creating default group:', insErr.message);
                      return;
                    }
                    ensureBackfill(newGroupId);
                  }
                );
              }
            });
          });
        });
      });
    });
  });
}
function checkIfUsersExist() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM users', [], (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result.count > 0);
    });
  });
}
module.exports = {
  db,
  checkIfUsersExist
};