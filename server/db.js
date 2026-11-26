const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const config = require("./config");
const logger = require("./logger");
const { haversineM } = require("./geo");

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, "pocketbeacon.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    lat REAL,
    lon REAL,
    accuracy REAL,
    location_updated_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS location_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy REAL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_user_ts ON location_history(user_id, ts);
`);

// Миграция: колонка yandex_id для входа через Яндекс (несколько NULL — ок,
// поэтому уникальность через частичный индекс)
{
  const cols = db.pragma("table_info(users)");
  if (!cols.some((c) => c.name === "yandex_id")) {
    db.exec("ALTER TABLE users ADD COLUMN yandex_id TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_yandex ON users(yandex_id) WHERE yandex_id IS NOT NULL"
    );
    logger.log("Миграция БД: добавлена колонка yandex_id.");
  }
}

const q = {
  insertUser: db.prepare(
    "INSERT INTO users (login, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)"
  ),
  insertYandexUser: db.prepare(
    "INSERT INTO users (login, password_hash, yandex_id, created_at) VALUES (?, ?, ?, ?)"
  ),
  userByYandexId: db.prepare("SELECT * FROM users WHERE yandex_id = ?"),
  userByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  updateLocation: db.prepare(
    "UPDATE users SET lat = ?, lon = ?, accuracy = ?, location_updated_at = ? WHERE id = ?"
  ),
  clearLocation: db.prepare(
    "UPDATE users SET lat = NULL, lon = NULL, accuracy = NULL WHERE id = ?"
  ),
  setHidden: db.prepare("UPDATE users SET is_hidden = ? WHERE id = ?"),
  setBanned: db.prepare("UPDATE users SET is_banned = ? WHERE id = ?"),
  setAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  countActiveAdmins: db.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND is_banned = 0"
  ),
  listVisible: db.prepare(`
    SELECT id, login, lat, lon, accuracy, location_updated_at
    FROM users
    WHERE is_banned = 0 AND is_hidden = 0 AND lat IS NOT NULL
  `),
  listHidden: db.prepare(
    "SELECT id, login FROM users WHERE is_banned = 0 AND is_hidden = 1"
  ),
  listNoLocation: db.prepare(
    "SELECT id, login FROM users WHERE is_banned = 0 AND is_hidden = 0 AND lat IS NULL"
  ),
  setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  listAll: db.prepare(`
    SELECT id, login, is_admin, is_banned, is_hidden, location_updated_at, created_at
    FROM users ORDER BY login
  `),
  lastHistoryPoint: db.prepare(
    "SELECT lat, lon, ts FROM location_history WHERE user_id = ? ORDER BY ts DESC LIMIT 1"
  ),
  insertHistory: db.prepare(
    "INSERT INTO location_history (user_id, lat, lon, accuracy, ts) VALUES (?, ?, ?, ?, ?)"
  ),
  historySince: db.prepare(
    "SELECT lat, lon, ts FROM location_history WHERE user_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 10000"
  ),
  pruneHistory: db.prepare("DELETE FROM location_history WHERE ts < ?"),
  pruneSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
};

// ---------- пользователи ----------

function createUser(login, password, isAdmin = false) {
  const hash = bcrypt.hashSync(password, 10);
  const res = q.insertUser.run(login, hash, isAdmin ? 1 : 0, Date.now());
  return getUserById(res.lastInsertRowid);
}

/** Пользователь, созданный через Яндекс-вход: пароль случайный (не используется). */
function createYandexUser(login, yandexId) {
  const hash = bcrypt.hashSync(config.randomString(24), 10);
  const res = q.insertYandexUser.run(login, hash, String(yandexId), Date.now());
  return getUserById(res.lastInsertRowid);
}

function findUserByYandexId(yandexId) {
  return q.userByYandexId.get(String(yandexId));
}

function findUserByLogin(login) {
  return q.userByLogin.get(login);
}

function getUserById(id) {
  return q.userById.get(id);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

// ---------- геолокация ----------

function updateLocation(userId, lat, lon, accuracy) {
  q.updateLocation.run(lat, lon, accuracy, Date.now(), userId);
}

/** Записывает точку в историю с прореживанием: >15 м или >60 сек от прошлой точки. */
function maybeRecordHistory(userId, lat, lon, accuracy) {
  const last = q.lastHistoryPoint.get(userId);
  const now = Date.now();
  if (
    last &&
    now - last.ts < config.historyMinIntervalMs &&
    haversineM(last.lat, last.lon, lat, lon) < config.historyMinDistanceM
  ) {
    return;
  }
  q.insertHistory.run(userId, lat, lon, accuracy, now);
}

function getHistory(userId) {
  return q.historySince.all(userId, Date.now() - config.historyRetentionMs);
}

// ---------- флаги ----------

function setHidden(userId, hidden) {
  q.setHidden.run(hidden ? 1 : 0, userId);
  if (hidden) q.clearLocation.run(userId); // при скрытии стираем последнюю позицию
}

function setBanned(userId, banned) {
  q.setBanned.run(banned ? 1 : 0, userId);
  if (banned) q.clearLocation.run(userId);
}

function setAdmin(userId, isAdmin) {
  q.setAdmin.run(isAdmin ? 1 : 0, userId);
}

function setPassword(userId, password) {
  q.setPassword.run(bcrypt.hashSync(password, 10), userId);
}

function clearLocation(userId) {
  q.clearLocation.run(userId);
}

function deleteUser(userId) {
  q.deleteUser.run(userId); // история удалится каскадно
}

function countActiveAdmins() {
  return q.countActiveAdmins.get().c;
}

// ---------- списки ----------

function listVisible() {
  return q.listVisible.all();
}

function listHidden() {
  return q.listHidden.all();
}

/** Пользователи без координат (наблюдатели и те, кто ещё не получил GPS-фикс). */
function listNoLocation() {
  return q.listNoLocation.all();
}

function listAll() {
  return q.listAll.all();
}

function deleteSessionsForUser(userId) {
  q.deleteUserSessions.run(userId);
}

// ---------- служебное ----------

function seedAdmin() {
  const existing = findUserByLogin(config.adminLogin);
  if (!existing) {
    // Пароль: из .env (если задан явно) или стандартный «admin».
    // При запуске сервер предложит сменить стандартный пароль (index.js).
    const password = config.adminInitialPassword || "admin";
    createUser(config.adminLogin, password, true);
    if (config.adminInitialPassword) {
      logger.log(`Создан администратор «${config.adminLogin}» (пароль из .env).`);
    } else {
      logger.log(`Создан администратор «${config.adminLogin}» со стандартным паролем.`);
    }
  } else if (!existing.is_admin) {
    setAdmin(existing.id, true);
    logger.log(`Пользователь «${config.adminLogin}» назначен администратором.`);
  }
}

function cleanup() {
  q.pruneHistory.run(Date.now() - config.historyRetentionMs);
  q.pruneSessions.run(Date.now());
}

seedAdmin();
cleanup();
setInterval(cleanup, 3600 * 1000).unref();

module.exports = {
  db,
  createUser,
  createYandexUser,
  findUserByYandexId,
  findUserByLogin,
  getUserById,
  verifyPassword,
  updateLocation,
  maybeRecordHistory,
  getHistory,
  setHidden,
  setBanned,
  setAdmin,
  setPassword,
  clearLocation,
  deleteUser,
  countActiveAdmins,
  listVisible,
  listHidden,
  listNoLocation,
  listAll,
  deleteSessionsForUser,
};
