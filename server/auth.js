const rateLimit = require("express-rate-limit");
const db = require("./db");

/** Проверяет сессию и актуальное состояние пользователя (бан действует сразу). */
function requireAuth(req, res, next) {
  const userId = req.session && req.session.userId;
  if (!userId) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  const user = db.getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Не авторизован" });
  }
  if (user.is_banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Аккаунт заблокирован", banned: true });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: "Требуются права администратора" });
  }
  next();
}

function rateLimitHandler(req, res) {
  res.status(429).json({ error: "Слишком много попыток. Попробуйте позже." });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

module.exports = { requireAuth, requireAdmin, loginLimiter, registerLimiter };
