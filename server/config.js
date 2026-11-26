require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env");

function randomString(len) {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * Гарантирует наличие SESSION_SECRET: если .env отсутствует или значение
 * пустое/заглушка (change-me) — генерирует случайный и записывает в .env.
 * Пользовательских данных (паролей) в .env не храним — только секрет сервера.
 */
function ensureSessionSecret() {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const m = content.match(/^SESSION_SECRET=(.*)$/m);
  const value = m ? m[1].trim() : "";
  if (value && !value.startsWith("change-me")) return;

  const fresh = randomString(48);
  if (m) {
    content = content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${fresh}`);
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `SESSION_SECRET=${fresh}\n`;
  }
  fs.writeFileSync(envPath, content, "utf8");
  process.env.SESSION_SECRET = fresh;
}

ensureSessionSecret();

// Пароль админа из .env — необязательная опция для первого запуска.
// Заглушки и пустые значения игнорируем.
const envAdminPassword = (process.env.ADMIN_PASSWORD || "").trim();
const envOrNull = (v) => (v && v.trim() ? v.trim() : null);

module.exports = {
  port: parseInt(process.env.PORT || "3443", 10),
  hostIp: process.env.HOST_IP || "",
  sessionSecret: process.env.SESSION_SECRET,
  adminLogin: process.env.ADMIN_LOGIN || "admin",
  adminInitialPassword:
    envAdminPassword && !envAdminPassword.startsWith("change-me")
      ? envAdminPassword
      : null,
  // Яндекс-вход (опционально). Без client_id кнопки нет — фича выключена.
  yandexClientId: envOrNull(process.env.YANDEX_CLIENT_ID),
  yandexClientSecret: envOrNull(process.env.YANDEX_CLIENT_SECRET),
  root,
  envPath,
  dataDir: path.join(root, "data"),
  certsDir: path.join(root, "certs"),
  publicDir: path.join(root, "public"),
  randomString,
  // Геолокация
  historyRetentionMs: 24 * 3600 * 1000, // хранить историю 24 часа
  historyMinDistanceM: 15, // писать точку, если сместились больше чем на 15 м
  historyMinIntervalMs: 60 * 1000, // или если прошло больше 60 сек
  maxAccuracyM: 100, // игнорировать фиксы грубее 100 м
};
