const db = require("./db");
const config = require("./config");
const { validateCoords } = require("./geo");

let io = null;
/** userId -> Set<socket> */
const userSockets = new Map();

function addSocket(userId, socket) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket);
}

function removeSocket(userId, socket) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socket);
  if (!set.size) userSockets.delete(userId);
}

/** id пользователей с живым сокетом (онлайн). */
function getOnlineUserIds() {
  return [...userSockets.keys()];
}

function buildUsersPayload() {
  const online = new Set(getOnlineUserIds());
  return {
    serverTime: Date.now(),
    visible: db.listVisible().map((u) => ({
      id: u.id,
      login: u.login,
      lat: u.lat,
      lon: u.lon,
      accuracy: u.accuracy,
      updatedAt: u.location_updated_at,
    })),
    hidden: db.listHidden().map((u) => ({ id: u.id, login: u.login })),
    // онлайн без координат: наблюдатели и те, кто ещё не получил GPS-фикс
    observers: db.listNoLocation()
      .filter((u) => online.has(u.id))
      .map((u) => ({ id: u.id, login: u.login })),
  };
}

// Рассылку схлопываем: не чаще одной за 300 мс
let broadcastTimer = null;
function broadcastUsers() {
  if (!io || broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    io.emit("users:update", buildUsersPayload());
  }, 300);
}

/** Отправляет событие всем сокетам конкретного пользователя. */
function sendToUser(userId, event, data) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const socket of set) socket.emit(event, data);
}

/** Отключает все сокеты пользователя, отправив событие (banned / force:logout). */
function kickUser(userId, event) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const socket of set) {
    socket.emit(event);
    socket.disconnect(true);
  }
  userSockets.delete(userId);
}

function init(ioInstance, sessionMiddleware) {
  io = ioInstance;

  // Авторизация сокета через ту же сессионную cookie
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, () => next());
  });

  io.on("connection", (socket) => {
    const sess = socket.request.session;
    const userId = sess && sess.userId;
    const user = userId ? db.getUserById(userId) : null;
    if (!user || user.is_banned) {
      return socket.disconnect(true);
    }
    addSocket(userId, socket);
    broadcastUsers(); // наблюдатель появился онлайн

    socket.emit("users:update", buildUsersPayload());

    socket.on("location:update", (data) => {
      const u = db.getUserById(userId);
      if (!u || u.is_banned) return socket.disconnect(true);
      if (u.is_hidden) return; // скрытые не передают координаты
      const coords = validateCoords(data);
      if (!coords) return;
      if (coords.accuracy !== null && coords.accuracy > config.maxAccuracyM) return;
      db.updateLocation(userId, coords.lat, coords.lon, coords.accuracy);
      db.maybeRecordHistory(userId, coords.lat, coords.lon, coords.accuracy);
      broadcastUsers();
    });

    socket.on("disconnect", () => {
      removeSocket(userId, socket);
      broadcastUsers(); // наблюдатель ушёл офлайн
    });
  });
}

module.exports = { init, broadcastUsers, kickUser, sendToUser, getOnlineUserIds };
