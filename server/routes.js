const express = require("express");
const QRCode = require("qrcode");
const db = require("./db");
const config = require("./config");
const logger = require("./logger");
const { validateCoords } = require("./geo");
const { requireAuth, requireAdmin, loginLimiter, registerLimiter } = require("./auth");
const sockets = require("./sockets");

const LOGIN_RE = /^[\p{L}\p{N}_.\-]{2,24}$/u;

function mePayload(user) {
  return {
    id: user.id,
    login: user.login,
    isAdmin: !!user.is_admin,
    isHidden: !!user.is_hidden,
  };
}

function visiblePayload() {
  return db.listVisible().map((u) => ({
    id: u.id,
    login: u.login,
    lat: u.lat,
    lon: u.lon,
    accuracy: u.accuracy,
    updatedAt: u.location_updated_at,
  }));
}

function usersPayload() {
  const online = new Set(sockets.getOnlineUserIds());
  return {
    serverTime: Date.now(),
    visible: visiblePayload(),
    hidden: db.listHidden().map((u) => ({ id: u.id, login: u.login })),
    observers: db.listNoLocation()
      .filter((u) => online.has(u.id))
      .map((u) => ({ id: u.id, login: u.login })),
  };
}

module.exports = function createRouter({ ip }) {
  const router = express.Router();
  const serverUrl = `https://${ip}:${config.port}`;

  // ---------- служебное ----------

  router.get("/api/server-info", async (req, res) => {
    try {
      const qr = await QRCode.toDataURL(serverUrl, { width: 512, margin: 1 });
      res.json({ url: serverUrl, qr });
    } catch {
      res.status(500).json({ error: "Не удалось сгенерировать QR-код" });
    }
  });

  // ---------- авторизация ----------

  router.post("/api/register", registerLimiter, (req, res) => {
    const { login, password } = req.body || {};
    if (typeof login !== "string" || !LOGIN_RE.test(login)) {
      return res.status(400).json({
        error: "Логин: 2–24 символа, буквы/цифры и _. -",
      });
    }
    if (typeof password !== "string" || password.length < 1 || password.length > 128) {
      return res.status(400).json({ error: "Пароль: от 1 до 128 символов" });
    }
    if (db.findUserByLogin(login)) {
      return res.status(409).json({ error: "Логин занят" });
    }
    const user = db.createUser(login, password);
    req.session.userId = user.id;
    logger.log(`Регистрация: ${user.login}`);
    res.json({ me: mePayload(user) });
  });

  router.post("/api/login", loginLimiter, (req, res) => {
    const { login, password } = req.body || {};
    const user = typeof login === "string" ? db.findUserByLogin(login) : null;
    if (!user || typeof password !== "string" || !db.verifyPassword(user, password)) {
      logger.log(`Неудачный вход: ${typeof login === "string" ? login : "?"}`);
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }
    if (user.is_banned) {
      return res.status(403).json({ error: "Аккаунт заблокирован", banned: true });
    }
    req.session.userId = user.id;
    logger.log(`Вход: ${user.login}`);
    res.json({ me: mePayload(user) });
  });

  router.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get("/api/me", requireAuth, (req, res) => {
    res.json({ me: mePayload(req.user) });
  });

  // ---------- геолокация ----------

  router.post("/api/location", requireAuth, (req, res) => {
    if (req.user.is_hidden) {
      return res.json({ ok: true, ignored: true });
    }
    const coords = validateCoords(req.body);
    if (!coords) {
      return res.status(400).json({ error: "Некорректные координаты" });
    }
    if (coords.accuracy !== null && coords.accuracy > config.maxAccuracyM) {
      return res.json({ ok: true, ignored: true, reason: "low_accuracy" });
    }
    db.updateLocation(req.user.id, coords.lat, coords.lon, coords.accuracy);
    db.maybeRecordHistory(req.user.id, coords.lat, coords.lon, coords.accuracy);
    sockets.broadcastUsers();
    res.json({ ok: true });
  });

  router.post("/api/visibility", requireAuth, (req, res) => {
    const hidden = !!(req.body && req.body.hidden);
    db.setHidden(req.user.id, hidden);
    sockets.broadcastUsers();
    res.json({ ok: true, hidden });
  });

  // Режим наблюдателя: стираем свои координаты, не трогая флаг скрытия
  router.post("/api/location/clear", requireAuth, (req, res) => {
    db.clearLocation(req.user.id);
    sockets.broadcastUsers();
    res.json({ ok: true });
  });

  router.get("/api/users", requireAuth, (req, res) => {
    res.json(usersPayload());
  });

  router.get("/api/history/:id", requireAuth, (req, res) => {
    const target = db.getUserById(parseInt(req.params.id, 10));
    // Скрытым и забаненным пользователям трек не показываем
    if (!target || target.is_banned || target.is_hidden) {
      return res.json({ points: [] });
    }
    res.json({ points: db.getHistory(target.id) });
  });

  // ---------- админка ----------

  router.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
    res.json({
      serverTime: Date.now(),
      users: db.listAll().map((u) => ({
        id: u.id,
        login: u.login,
        isAdmin: !!u.is_admin,
        isBanned: !!u.is_banned,
        isHidden: !!u.is_hidden,
        online:
          !u.is_banned && !u.is_hidden && u.location_updated_at
            ? Date.now() - u.location_updated_at < 60000
            : false,
        createdAt: u.created_at,
      })),
    });
  });

  function adminTargetGuard(req, res) {
    const target = db.getUserById(parseInt(req.params.id, 10));
    if (!target) {
      res.status(404).json({ error: "Пользователь не найден" });
      return null;
    }
    if (target.id === req.user.id) {
      res.status(400).json({ error: "Нельзя выполнить действие над собой" });
      return null;
    }
    return target;
  }

  function lastAdminGuard(res, target) {
    if (target.is_admin && db.countActiveAdmins() <= 1) {
      res.status(400).json({ error: "Нельзя заблокировать или удалить последнего администратора" });
      return false;
    }
    return true;
  }

  router.post("/api/admin/ban/:id", requireAuth, requireAdmin, (req, res) => {
    const target = adminTargetGuard(req, res);
    if (!target) return;
    if (!lastAdminGuard(res, target)) return;
    db.setBanned(target.id, true);
    db.deleteSessionsForUser(target.id);
    sockets.kickUser(target.id, "banned");
    sockets.broadcastUsers();
    logger.log(`Админ ${req.user.login} забанил ${target.login}`);
    res.json({ ok: true });
  });

  router.post("/api/admin/unban/:id", requireAuth, requireAdmin, (req, res) => {
    const target = db.getUserById(parseInt(req.params.id, 10));
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });
    db.setBanned(target.id, false);
    logger.log(`Админ ${req.user.login} разбанил ${target.login}`);
    res.json({ ok: true });
  });

  router.delete("/api/admin/user/:id", requireAuth, requireAdmin, (req, res) => {
    const target = adminTargetGuard(req, res);
    if (!target) return;
    if (!lastAdminGuard(res, target)) return;
    db.deleteUser(target.id);
    db.deleteSessionsForUser(target.id);
    sockets.kickUser(target.id, "force:logout");
    sockets.broadcastUsers();
    logger.log(`Админ ${req.user.login} удалил ${target.login}`);
    res.json({ ok: true });
  });

  router.post("/api/admin/admin/:id", requireAuth, requireAdmin, (req, res) => {
    const target = adminTargetGuard(req, res);
    if (!target) return;
    const makeAdmin = !!(req.body && req.body.isAdmin);
    if (!makeAdmin && target.is_admin && db.countActiveAdmins() <= 1) {
      return res.status(400).json({ error: "Нельзя снять права с последнего администратора" });
    }
    db.setAdmin(target.id, makeAdmin);
    logger.log(`Админ ${req.user.login} ${makeAdmin ? "дал права админа" : "снял права админа"}: ${target.login}`);
    res.json({ ok: true });
  });

  return router;
};
