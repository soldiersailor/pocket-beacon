/**
 * E2E-проверка реального времени против dev-сервера (http://localhost:3444):
 * регистрация случайного пользователя -> сокет с cookie -> отправка координат ->
 * ожидание users:update с этими координатами -> проверка истории -> очистка.
 *
 * Перед запуском: npm run dev:http (в другом терминале).
 * Запуск: node scripts/test-socket.js
 */
require("dotenv").config();
const { io } = require("socket.io-client");

const BASE = "http://localhost:3444";
const LOGIN = "tester_" + Math.random().toString(36).slice(2, 8);
const PASSWORD = Math.random().toString(36).slice(2, 10);

async function apiPost(path, body, cookie) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

async function main() {
  // 1. регистрируем одноразового пользователя
  const reg = await apiPost("/api/register", { login: LOGIN, password: PASSWORD });
  if (!reg.res.ok) throw new Error("Регистрация не удалась: " + JSON.stringify(reg.data));
  const userId = reg.data.me.id;
  console.log("1. Зарегистрирован", LOGIN);

  // 2. сокет с сессионной cookie
  const socket = io(BASE, { extraHeaders: { Cookie: reg.cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Таймаут users:update")), 5000);
    socket.on("users:update", () => { clearTimeout(timer); resolve(); });
  });
  console.log("2. Сокет подключён, начальная рассылка получена");

  // 3. отправляем координаты и ждём рассылку с ними
  socket.emit("location:update", { lat: 55.7, lon: 37.6, accuracy: 10 });
  const payload = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Координаты не разосланы")), 5000);
    socket.on("users:update", (p) => {
      const me = p.visible.find((u) => u.login === LOGIN);
      if (me && Math.abs(me.lat - 55.7) < 1e-9) { clearTimeout(timer); resolve(p); }
    });
  });
  console.log("3. Координаты разосланы:", JSON.stringify(payload.visible.find((u) => u.login === LOGIN)));

  // 4. история записалась
  const hist = await fetch(`${BASE}/api/history/${userId}`, {
    headers: { Cookie: reg.cookie },
  }).then((r) => r.json());
  if (!hist.points.length) throw new Error("История пуста");
  console.log("4. Точек в истории:", hist.points.length);

  socket.disconnect();

  // 5. убираем за собой: удаляем тестового пользователя через админку
  const adminLogin = process.env.ADMIN_LOGIN;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminLogin && adminPassword) {
    const adm = await apiPost("/api/login", { login: adminLogin, password: adminPassword });
    if (adm.res.ok) {
      await fetch(`${BASE}/api/admin/user/${userId}`, {
        method: "DELETE",
        headers: { Cookie: adm.cookie },
      });
      console.log("5. Тестовый пользователь удалён");
    } else {
      console.log("5. Админ-логин не удался — тестовый пользователь остался в БД:", LOGIN);
    }
  }

  console.log("OK: реальное время работает");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
