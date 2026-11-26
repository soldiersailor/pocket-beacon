const path = require("path");
const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");

const config = require("./config");
const db = require("./db");
const logger = require("./logger");
const SqliteSessionStore = require("./store");
const createRouter = require("./routes");
const sockets = require("./sockets");

/**
 * Собирает Express-приложение и Socket.IO.
 * secureCookies=false нужен только для dev-режима по HTTP на localhost.
 */
function createApp({ ip, secureCookies = true }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  const sessionMiddleware = session({
    name: "pb.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new SqliteSessionStore(db.db),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      maxAge: 7 * 24 * 3600 * 1000,
    },
  });
  app.use(sessionMiddleware);

  // Leaflet из node_modules — без CDN
  const leafletDist = path.join(
    path.dirname(require.resolve("leaflet/package.json")),
    "dist"
  );
  app.use("/vendor/leaflet", express.static(leafletDist));
  app.use(express.static(config.publicDir, { extensions: ["html"] }));
  app.use(createRouter({ ip }));

  // Ошибки — в лог, клиенту — нейтральный 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(`HTTP ${req.method} ${req.url}:`, err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  });

  function attach(server) {
    const io = new Server(server);
    sockets.init(io, sessionMiddleware);
    return io;
  }

  return { app, attach };
}

module.exports = { createApp };
