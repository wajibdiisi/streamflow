const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

class StreamKey {
  static create(data) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = new Date().toISOString();
      const {
        group_id,
        name,
        stream_key,
        rtmp_url,
        platform,
        platform_icon,
        user_id
      } = data;

      db.run(
        `INSERT INTO stream_keys (
          id, group_id, name, stream_key, rtmp_url, platform, platform_icon, user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, group_id, name, stream_key, rtmp_url, platform, platform_icon, user_id, now, now],
        function (err) {
          if (err) {
            console.error('Error creating stream key:', err.message);
            return reject(err);
          }
          resolve({ id, ...data, created_at: now, updated_at: now });
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM stream_keys WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding stream key:', err.message);
          return reject(err);
        }
        if (row) {
          row.is_active = row.is_active === 1;
        }
        resolve(row);
      });
    });
  }

  static findAll(userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId ?
        `SELECT sk.*, skg.name as group_name, skg.description as group_description 
         FROM stream_keys sk 
         LEFT JOIN stream_key_groups skg ON sk.group_id = skg.id 
         WHERE sk.user_id = ? ORDER BY skg.name ASC, sk.name ASC` :
        `SELECT sk.*, skg.name as group_name, skg.description as group_description 
         FROM stream_keys sk 
         LEFT JOIN stream_key_groups skg ON sk.group_id = skg.id 
         ORDER BY skg.name ASC, sk.name ASC`;
      const params = userId ? [userId] : [];

      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding stream keys:', err.message);
          return reject(err);
        }
        if (rows) {
          rows.forEach(row => {
            row.is_active = row.is_active === 1;
          });
        }
        resolve(rows || []);
      });
    });
  }

  static findByGroupId(groupId, userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId ?
        `SELECT sk.*, skg.name as group_name, skg.description as group_description 
         FROM stream_keys sk 
         LEFT JOIN stream_key_groups skg ON sk.group_id = skg.id 
         WHERE sk.group_id = ? AND sk.user_id = ? ORDER BY sk.name ASC` :
        `SELECT sk.*, skg.name as group_name, skg.description as group_description 
         FROM stream_keys sk 
         LEFT JOIN stream_key_groups skg ON sk.group_id = skg.id 
         WHERE sk.group_id = ? ORDER BY sk.name ASC`;
      const params = userId ? [groupId, userId] : [groupId];

      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding stream keys by group:', err.message);
          return reject(err);
        }
        if (rows) {
          rows.forEach(row => {
            row.is_active = row.is_active === 1;
          });
        }
        resolve(rows || []);
      });
    });
  }

  static update(id, streamKeyData) {
    const fields = [];
    const values = [];
    Object.entries(streamKeyData).forEach(([key, value]) => {
      if (key === 'is_active' && typeof value === 'boolean') {
        fields.push(`${key} = ?`);
        values.push(value ? 1 : 0);
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const query = `UPDATE stream_keys SET ${fields.join(', ')} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, values, function (err) {
        if (err) {
          console.error('Error updating stream key:', err.message);
          return reject(err);
        }
        resolve({ id, ...streamKeyData });
      });
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM stream_keys WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) {
            console.error('Error deleting stream key:', err.message);
            return reject(err);
          }
          resolve({ success: true, deleted: this.changes > 0 });
        }
      );
    });
  }

  static async isStreamKeyInUse(streamKey, userId, excludeId = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT COUNT(*) as count FROM stream_keys WHERE stream_key = ? AND user_id = ?';
      const params = [streamKey, userId];
      if (excludeId) {
        query += ' AND id != ?';
        params.push(excludeId);
      }
      db.get(query, params, (err, row) => {
        if (err) {
          console.error('Error checking stream key:', err.message);
          return reject(err);
        }
        resolve(row.count > 0);
      });
    });
  }

  static async isStreamKeyUsedInStreams(streamKey, userId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT COUNT(*) as count FROM streams WHERE stream_key = ? AND user_id = ?';
      db.get(query, [streamKey, userId], (err, row) => {
        if (err) {
          console.error('Error checking stream key usage in streams:', err.message);
          return reject(err);
        }
        resolve(row.count > 0);
      });
    });
  }

  static async updateLastUsed(id) {
    return new Promise((resolve, reject) => {
      const now = new Date().toISOString();
      db.run(
        'UPDATE stream_keys SET last_used = ?, updated_at = ? WHERE id = ?',
        [now, now, id],
        function (err) {
          if (err) {
            console.error('Error updating last used:', err.message);
            return reject(err);
          }
          resolve({ success: true, updated: this.changes > 0 });
        }
      );
    });
  }

  static async updateLastUsedByStreamKey(streamKey, userId) {
    return new Promise((resolve, reject) => {
      const now = new Date().toISOString();
      db.run(
        'UPDATE stream_keys SET last_used = ?, updated_at = ? WHERE stream_key = ? AND user_id = ?',
        [now, now, streamKey, userId],
        function (err) {
          if (err) {
            console.error('Error updating last used by stream key:', err.message);
            return reject(err);
          }
          resolve({ success: true, updated: this.changes > 0 });
        }
      );
    });
  }

  static async getStreamKeyWithUsage(streamKeyId, userId) {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT sk.*, 
                CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_used_in_stream,
                s.title as used_in_stream_title,
                s.status as used_in_stream_status
         FROM stream_keys sk
         LEFT JOIN streams s ON sk.stream_key = s.stream_key AND s.user_id = ?
         WHERE sk.id = ? AND sk.user_id = ?`,
        [userId, streamKeyId, userId],
        (err, row) => {
          if (err) {
            console.error('Error fetching stream key with usage:', err.message);
            return reject(err);
          }
          if (row) {
            row.is_active = row.is_active === 1;
            row.is_used_in_stream = row.is_used_in_stream === 1;
          }
          resolve(row);
        }
      );
    });
  }
}

module.exports = StreamKey;
