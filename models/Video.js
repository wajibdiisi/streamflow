const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
class Video {
  static async create(data) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO videos (
          id, title, filepath, thumbnail_path, file_size, 
          duration, format, resolution, bitrate, fps, folder_path, user_id, 
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, data.title, data.filepath, data.thumbnail_path, data.file_size,
          data.duration, data.format, data.resolution, data.bitrate, data.fps, data.folder_path || 'Default', data.user_id,
          now, now
        ],
        function (err) {
          if (err) {
            console.error('Error creating video:', err.message);
            return reject(err);
          }
          resolve({ id, ...data, created_at: now, updated_at: now });
        }
      );
    });
  }
  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM videos WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding video:', err.message);
          return reject(err);
        }
        resolve(row);
      });
    });
  }
  static findAll(userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId ?
        `SELECT v.* FROM videos v WHERE v.user_id = ?
         ORDER BY COALESCE(v.updated_at, v.created_at) DESC` :
        `SELECT v.* FROM videos v
         ORDER BY COALESCE(v.updated_at, v.created_at) DESC`;
      const params = userId ? [userId] : [];
      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding videos:', err.message);
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }
  static incrementUsedCount(id, delta) {
    return new Promise((resolve, reject) => {
      const change = parseInt(delta, 10);
      if (isNaN(change)) return resolve(false);
      const query = 'UPDATE videos SET used_count = MAX(0, used_count + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?';
      db.run(query, [change, id], function (err) {
        if (err) {
          console.error('Error updating used_count:', err.message);
          return reject(err);
        }
        resolve(this.changes > 0);
      });
    });
  }
  static update(id, videoData) {
    const fields = [];
    const values = [];
    Object.entries(videoData).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const query = `UPDATE videos SET ${fields.join(', ')} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, values, function (err) {
        if (err) {
          console.error('Error updating video:', err.message);
          return reject(err);
        }
        resolve({ id, ...videoData });
      });
    });
  }
  static delete(id) {
    return new Promise((resolve, reject) => {
      Video.findById(id)
        .then(video => {
          if (!video) {
            return reject(new Error('Video not found'));
          }
          db.run('DELETE FROM videos WHERE id = ?', [id], function (err) {
            if (err) {
              console.error('Error deleting video from database:', err.message);
              return reject(err);
            }
            if (video.filepath) {
              const fullPath = path.join(process.cwd(), 'public', video.filepath);
              try {
                if (fs.existsSync(fullPath)) {
                  fs.unlinkSync(fullPath);
                }
              } catch (fileErr) {
                console.error('Error deleting video file:', fileErr);
              }
            }
            if (video.thumbnail_path) {
              const thumbnailPath = path.join(process.cwd(), 'public', video.thumbnail_path);
              try {
                if (fs.existsSync(thumbnailPath)) {
                  fs.unlinkSync(thumbnailPath);
                }
              } catch (thumbErr) {
                console.error('Error deleting thumbnail:', thumbErr);
              }
            }
            resolve({ success: true, id });
          });
        })
        .catch(err => reject(err));
    });
  }
}
module.exports = Video;