require("dotenv").config();
const path = require("path");

function required(name, value) {
  if (!value) {
    console.error(
      `Ошибка: переменная окружения ${name} не задана.\n` +
        `Скопируйте .env.example в .env и заполните значения.`
    );
    process.exit(1);
  }
  return value;
}

const root = path.join(__dirname, "..");

module.exports = {
  port: parseInt(process.env.PORT || "3443", 10),
  hostIp: process.env.HOST_IP || "",
  sessionSecret: required("SESSION_SECRET", process.env.SESSION_SECRET),
  adminLogin: process.env.ADMIN_LOGIN || "admin",
  adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD),
  root,
  dataDir: path.join(root, "data"),
  certsDir: path.join(root, "certs"),
  publicDir: path.join(root, "public"),
  // Геолокация
  historyRetentionMs: 24 * 3600 * 1000, // хранить историю 24 часа
  historyMinDistanceM: 15, // писать точку, если сместились больше чем на 15 м
  historyMinIntervalMs: 60 * 1000, // или если прошло больше 60 сек
  maxAccuracyM: 100, // игнорировать фиксы грубее 100 м
};
