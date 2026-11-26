require("reflect-metadata");
const https = require("https");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const config = require("./config");
const { getLanIp } = require("./net");
const { ensureCerts } = require("./cert");
const { createApp } = require("./app");

async function main() {
  const ip = config.hostIp || getLanIp();
  const url = `https://${ip}:${config.port}`;

  const { key, cert } = await ensureCerts(config.certsDir, ip);
  const { app, attach } = createApp({ ip, secureCookies: true });

  const server = https.createServer({ key, cert }, app);
  attach(server);

  server.listen(config.port, "0.0.0.0", async () => {
    console.log("");
    console.log("  Pocket Beacon запущен!");
    console.log(`  Адрес:        ${url}`);
    console.log(`  QR для входа: ${url}/qr`);
    console.log("");
    try {
      console.log(await QRCode.toString(url, { type: "terminal", small: true }));
    } catch {
      // QR в консоли — необязательная фича
    }
    console.log("  Если телефоны не подключаются:");
    console.log("  1) разрешите node.exe в брандмауэре Windows");
    console.log("  2) проверьте, что на роутере выключена изоляция клиентов (AP isolation)");
    console.log("  3) задайте HOST_IP в .env, если адрес определился неверно");
    console.log("");
  });
}

main().catch((err) => {
  console.error("Ошибка запуска:", err);
  process.exit(1);
});
