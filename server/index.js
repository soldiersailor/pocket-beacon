require("reflect-metadata");
const fs = require("fs");
const https = require("https");
const readline = require("readline");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const config = require("./config");
const logger = require("./logger");
const db = require("./db");
const { getLanIp, isPortFree, findFreePort } = require("./net");
const { ensureCerts } = require("./cert");
const { createApp } = require("./app");

/** Записывает выбранный порт в .env, чтобы при следующем старте он был постоянным. */
function savePortToEnv(port) {
  try {
    let content = fs.existsSync(config.envPath)
      ? fs.readFileSync(config.envPath, "utf8")
      : "";
    if (/^PORT=.*$/m.test(content)) {
      content = content.replace(/^PORT=.*$/m, `PORT=${port}`);
    } else {
      if (content && !content.endsWith("\n")) content += "\n";
      content += `PORT=${port}\n`;
    }
    fs.writeFileSync(config.envPath, content, "utf8");
  } catch (err) {
    logger.error("Не удалось записать PORT в .env:", err);
  }
}

/**
 * Проверяет порт из конфигурации. Если занят:
 *  - в консоли (TTY) — предлагает ближайший свободный ([Y/n]);
 *  - без консоли — автоматически берёт ближайший свободный.
 * Выбранный порт сохраняется в .env.
 */
async function resolvePort() {
  const want = config.port;
  if (await isPortFree(want)) return want;

  const free = await findFreePort(want + 1);
  if (!process.stdin.isTTY) {
    logger.log(`Порт ${want} занят. Автоматически выбран свободный порт ${free}.`);
    savePortToEnv(free);
    return free;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`Порт ${want} занят. Использовать свободный порт ${free}? [Y/n] `, res)
  );
  rl.close();
  if (/^\s*n/i.test(answer)) {
    console.log("Остановлено. Освободите порт или задайте PORT в .env и запустите снова.");
    process.exit(0);
  }
  savePortToEnv(free);
  return free;
}

/** Вопрос со скрытым вводом (звёздочки вместо символов). */
function questionHidden(rl, query) {
  return new Promise((resolve) => {
    const originalWrite = rl._writeToOutput;
    rl._writeToOutput = function (chunk) {
      if (chunk.includes(query) || chunk.includes("\n") || chunk.includes("\r")) {
        originalWrite.call(rl, chunk);
      } else {
        originalWrite.call(rl, "*");
      }
    };
    rl.question(query, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.output.write("\n");
      resolve(answer);
    });
  });
}

/**
 * Если у администратора стандартный пароль «admin» — предупреждаем
 * и в консоли предлагаем задать новый. Без консоли — только предупреждение в лог.
 */
async function maybePromptAdminPassword() {
  const admin = db.findUserByLogin(config.adminLogin);
  if (!admin || !db.verifyPassword(admin, "admin")) return;

  logger.log(`ВНИМАНИЕ: у администратора «${config.adminLogin}» стандартный пароль.`);
  if (!process.stdin.isTTY) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question("Сменить пароль администратора сейчас? [y/N] ", res)
  );
  if (/^\s*y/i.test(answer)) {
    const pw = (await questionHidden(rl, "Новый пароль: ")).trim();
    if (pw.length >= 1) {
      db.setPassword(admin.id, pw);
      db.deleteSessionsForUser(admin.id);
      console.log("Пароль администратора изменён.");
      logger.log("Пароль администратора изменён при запуске.");
    } else {
      console.log("Пустой пароль — оставлен стандартный.");
    }
  }
  rl.close();
}

async function main() {
  process.on("uncaughtException", (err) => {
    logger.error("Неперехваченная ошибка:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error("Необработанный reject:", err);
  });

  config.port = await resolvePort();
  await maybePromptAdminPassword();
  const ip = config.hostIp || getLanIp();
  const url = `https://${ip}:${config.port}`;

  const { key, cert } = await ensureCerts(config.certsDir, ip);
  const { app, attach } = createApp({ ip, secureCookies: true });

  const server = https.createServer({ key, cert }, app);
  attach(server);

  server.on("error", (err) => {
    logger.error("Ошибка сервера:", err);
    process.exit(1);
  });

  server.listen(config.port, "0.0.0.0", async () => {
    logger.log(`Pocket Beacon запущен: ${url}`);
    logger.log(`QR для входа: ${url}/qr`);
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
  logger.error("Ошибка запуска:", err);
  process.exit(1);
});
