/**
 * Логирование в консоль и в файл logs/app.log одновременно.
 * Ротация при старте: файл больше 5 МБ переименовывается в app.1.log.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");

const logsDir = path.join(config.root, "logs");
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, "app.log");

try {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
    const backup = path.join(logsDir, "app.1.log");
    fs.rmSync(backup, { force: true });
    fs.renameSync(logFile, backup);
  }
} catch {
  // ротация не удалась — не критично
}

function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "object") return JSON.stringify(a);
      return String(a);
    })
    .join(" ");
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${fmt(args)}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // диск недоступен — остаёмся на консоли
  }
}

function log(...args) {
  console.log(...args);
  write("INFO", args);
}

function error(...args) {
  console.error(...args);
  write("ERROR", args);
}

module.exports = { log, error };
