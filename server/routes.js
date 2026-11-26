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
      res.json({ url: serverUrl, qr, yandexEnabled: !!config.yandexClientId });
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

  // ---------- вход через Яндекс ----------

  // Переадресующая страница на GitHub Pages: фиксированный HTTPS-адрес без
  // IP/порта, поэтому Redirect URI в кабинете Яндекса регистрируется один раз
  // навсегда. Реальный адрес сервера путешествует внутри state (base64url) и
  // валидируется по сессии при возврате.
  const YANDEX_RELAY_URL =
    process.env.YANDEX_RELAY_URL ||
    "https://soldiersailor.github.io/pocket-beacon/oauth.html";

  function yandexCallbackUrl(req) {
    return `${req.protocol}://${req.get("host")}/api/auth/yandex/callback`;
  }

  function sha256Base64Url(s) {
    return require("crypto").createHash("sha256").update(s).digest("base64url");
  }

  /** Свободный логин на базе яндекс-логина: при занятости — автосуффикс. */
  function freeYandexLogin(raw) {
    let base = String(raw || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_.-]/gu, "")
      .slice(0, 20);
    if (base.length < 2) base = "user";
    let candidate = base;
    for (let n = 1; db.findUserByLogin(candidate); n++) {
      candidate = n === 1 ? `${base}.ya` : `${base}.ya${n + 1}`;
    }
    return candidate;
  }

  // Старт OAuth: редирект на Яндекс. PKCE: verifier запоминаем в сессии,
  // challenge уходит в запрос; секрет приложения не используется вообще
  // (публичный клиент) — поэтому вход работает из коробки у всех установок.
  router.get("/api/auth/yandex", (req, res) => {
    if (!config.yandexClientId) {
      return res.status(404).json({ error: "Вход через Яндекс не настроен" });
    }
    const rand = config.randomString(16);
    const cb = yandexCallbackUrl(req);
    const verifier = config.randomString(64);
    req.session.yandexAuth = { rand, cb, verifier };
    const state = rand + "~" + Buffer.from(cb, "utf8").toString("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.yandexClientId,
      redirect_uri: YANDEX_RELAY_URL,
      state,
      scope: "login:info",
      force_confirm: "yes",
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: "S256",
    });
    res.redirect("https://oauth.yandex.ru/authorize?" + params.toString());
  });

  // Колбэк от Яндекса (после переадресующей страницы): обмен кода на токен
  // через PKCE-verifier, получение личности, вход/создание пользователя
  router.get("/api/auth/yandex/callback", async (req, res) => {
    const fail = (why) => {
      logger.log(`Яндекс-вход не удался: ${why}`);
      res.redirect("/?auth_error=yandex");
    };
    if (!config.yandexClientId) return fail("не настроен");
    const { code, state, error } = req.query;

    // Проверка state: случайная часть и адрес возврата должны совпасть с сессией
    const expected = req.session.yandexAuth;
    delete req.session.yandexAuth;
    const parts = String(state || "").split("~");
    let cb = null;
    if (parts.length === 2) {
      try {
        cb = Buffer.from(parts[1], "base64url").toString("utf8");
      } catch { /* невалидный base64 */ }
    }
    if (!expected || parts[0] !== expected.rand || !cb || cb !== expected.cb) {
      return fail("state");
    }
    if (error) return fail(String(error));
    if (!code) return fail("нет кода");

    try {
      const tokenRes = await fetch("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(code),
          client_id: config.yandexClientId,
          code_verifier: expected.verifier,
        }),
      });
      if (!tokenRes.ok) return fail(`обмен кода: HTTP ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();
      if (!access_token) return fail("нет токена");

      const infoRes = await fetch("https://login.yandex.ru/info?format=json", {
        headers: { Authorization: `OAuth ${access_token}` },
      });
      if (!infoRes.ok) return fail(`личность: HTTP ${infoRes.status}`);
      const info = await infoRes.json();
      if (!info || !info.id) return fail("нет id");

      let user = db.findUserByYandexId(info.id);
      if (!user) {
        const login = freeYandexLogin(
          info.login || (info.default_email || "").split("@")[0] || `user${info.id}`
        );
        user = db.createYandexUser(login, info.id);
        logger.log(`Создан пользователь «${login}» через Яндекс (id ${info.id})`);
      }
      if (user.is_banned) {
        req.session.destroy(() => {});
        return res.redirect("/?auth_error=banned");
      }
      req.session.userId = user.id;
      logger.log(`Вход через Яндекс: ${user.login}`);
      res.redirect("/");
    } catch (err) {
      logger.error("Яндекс-вход, ошибка:", err);
      res.redirect("/?auth_error=yandex");
    }
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
    sockets.sendToUser(target.id, "admin:changed", { isAdmin: makeAdmin });
    logger.log(`Админ ${req.user.login} ${makeAdmin ? "дал права админа" : "снял права админа"}: ${target.login}`);
    res.json({ ok: true });
  });

  return router;
};
