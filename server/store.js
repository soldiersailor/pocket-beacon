const session = require("express-session");

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

/** Хранилище сессий express-session поверх SQLite — сессии переживают перезапуск сервера. */
class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt = db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?");
    this.setStmt = db.prepare(
      "INSERT INTO sessions (sid, user_id, data, expires_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at"
    );
    this.destroyStmt = db.prepare("DELETE FROM sessions WHERE sid = ?");
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        this.destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + DEFAULT_TTL_MS;
      const userId = sess.userId || null;
      this.setStmt.run(sid, userId, JSON.stringify(sess), expires);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteSessionStore;
