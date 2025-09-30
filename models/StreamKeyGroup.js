const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

class StreamKeyGroup {
  static async create(data) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO stream_key_groups (
          id, name, description, user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id, data.name, data.description || null, data.user_id,
          now, now
        ],
        function (err) {
          if (err) {
            console.error('Error creating stream key group:', err.message);
            return reject(err);
          }
          resolve({ id, ...data, created_at: now, updated_at: now });
        }
      );
    });
  }

  static findById(id) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM stream_key_groups WHERE id = ?', [id], (err, row) => {
        if (err) {
          console.error('Error finding stream key group:', err.message);
          return reject(err);
        }
        resolve(row);
      });
    });
  }

  static findAll(userId = null) {
    return new Promise((resolve, reject) => {
      const query = userId ?
        'SELECT * FROM stream_key_groups WHERE user_id = ? ORDER BY name ASC' :
        'SELECT * FROM stream_key_groups ORDER BY name ASC';
      const params = userId ? [userId] : [];
      db.all(query, params, (err, rows) => {
        if (err) {
          console.error('Error finding stream key groups:', err.message);
          return reject(err);
        }
        resolve(rows || []);
      });
    });
  }

  static update(id, groupData) {
    const fields = [];
    const values = [];
    Object.entries(groupData).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const query = `UPDATE stream_key_groups SET ${fields.join(', ')} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, values, function (err) {
        if (err) {
          console.error('Error updating stream key group:', err.message);
          return reject(err);
        }
        resolve({ id, ...groupData });
      });
    });
  }

  static delete(id, userId) {
    return new Promise((resolve, reject) => {
      db.run(
        'DELETE FROM stream_key_groups WHERE id = ? AND user_id = ?',
        [id, userId],
        function (err) {
          if (err) {
            console.error('Error deleting stream key group:', err.message);
            return reject(err);
          }
          resolve({ success: true, deleted: this.changes > 0 });
        }
      );
    });
  }

  static isNameInUse(name, userId, excludeId = null) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT COUNT(*) as count FROM stream_key_groups WHERE name = ? AND user_id = ?';
      const params = [name, userId];
      if (excludeId) {
        query += ' AND id != ?';
        params.push(excludeId);
      }
      db.get(query, params, (err, row) => {
        if (err) {
          console.error('Error checking group name existence:', err.message);
          return reject(err);
        }
        resolve(row.count > 0);
      });
    });
  }
}

module.exports = StreamKeyGroup;
