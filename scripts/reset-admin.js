/**
 * Сброс пароля администратора.
 *   node scripts/reset-admin.js            -> пароль сбрасывается на стандартный «admin»
 *   node scripts/reset-admin.js новыйпароль -> устанавливается указанный пароль
 * (через npm: npm run reset-admin -- новыйпароль)
 */
const db = require("../server/db");
const config = require("../server/config");

const admin = db.findUserByLogin(config.adminLogin);
if (!admin) {
  console.error(`Администратор «${config.adminLogin}» не найден.`);
  process.exit(1);
}
if (!admin.is_admin) {
  db.setAdmin(admin.id, true);
}

const arg = (process.argv[2] || "").trim();
const password = arg || "admin";
db.setPassword(admin.id, password);
db.deleteSessionsForUser(admin.id); // разлогиниваем на всех устройствах

console.log("");
console.log(`  Пароль администратора «${config.adminLogin}» установлен: ${password}`);
if (password === "admin") {
  console.log("  Это стандартный пароль — сервер предложит сменить его при запуске.");
}
console.log("");
