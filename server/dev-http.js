/**
 * Dev-сервер: HTTP на localhost без сертификата.
 * Только для разработки — геолокация работает, т.к. localhost является
 * защищённым контекстом. НЕ использовать в локальной сети:
 * с других устройств геолокация по HTTP заблокирована браузерами.
 */
const http = require("http");
const config = require("./config");
const { createApp } = require("./app");

const PORT = 3444;
config.port = PORT; // чтобы ссылки/QR внутри dev-режима указывали на dev-порт

const { app, attach } = createApp({ ip: "127.0.0.1", secureCookies: false });
const server = http.createServer(app);
attach(server);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pocket Beacon (dev): http://localhost:${PORT}`);
});
