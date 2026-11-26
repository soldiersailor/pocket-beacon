/** App — авторизация, сокет, геолокация, админ-панель. */
const App = (() => {
  let me = null;
  let socket = null;
  let hidden = false;
  let observer = localStorage.getItem("pb_observer") === "1";
  let geoStarted = false;
  let lastSent = null; // { lat, lon, t }
  let toastTimer = null;

  const SEND_INTERVAL_MS = 5000; // не чаще, чем раз в 5 сек
  const SEND_DISTANCE_M = 10; // и только если сместились на 10 м
  const KEEPALIVE_MS = 30000; // но не реже, чем раз в 30 сек

  // ---------- утилиты ----------

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---------- авторизация ----------

  let authMode = "login";

  function showAuth() {
    $("view-auth").classList.remove("hidden");
    $("view-map").classList.add("hidden");
  }

  function setAuthMode(mode) {
    authMode = mode;
    $("tab-login").classList.toggle("active", mode === "login");
    $("tab-register").classList.toggle("active", mode === "register");
    $("auth-submit").textContent = mode === "login" ? "Войти" : "Зарегистрироваться";
    $("auth-error").textContent = "";
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const login = $("auth-login").value.trim();
    const password = $("auth-password").value;
    $("auth-error").textContent = "";
    try {
      const { me: m } = await api.post("/api/" + authMode, { login, password });
      startApp(m);
    } catch (err) {
      $("auth-error").textContent = err.message;
    }
  }

  // ---------- запуск приложения ----------

  function startApp(m) {
    me = m;
    hidden = m.isHidden;
    $("view-auth").classList.add("hidden");
    $("view-map").classList.remove("hidden");
    $("me-login").textContent = m.login;
    if (m.isAdmin) $("btn-admin").classList.remove("hidden");

    MapModule.init(m);
    connectSocket();
    applyObserverUI();
    if (!observer) startGeo();
    updateVisibilityButton();
  }

  // ---------- режим наблюдателя ----------

  function applyObserverUI() {
    $("observer-badge").classList.toggle("hidden", !observer);
    $("btn-enable-geo").classList.toggle("hidden", !observer);
    $("btn-visibility").classList.toggle("hidden", observer);
  }

  function setObserver(value) {
    observer = value;
    localStorage.setItem("pb_observer", value ? "1" : "0");
    applyObserverUI();
    if (value) {
      // стираем свои координаты на сервере — переходим в список наблюдателей
      api.post("/api/location/clear").catch(() => {});
      $("geo-denied").classList.add("hidden");
      hideGeoStatus();
    } else if (!geoStarted) {
      startGeo();
    }
  }

  function startGeo() {
    if (geoStarted) return;
    geoStarted = true;
    if (!("geolocation" in navigator)) {
      showGeoStatus("Геолокация не поддерживается браузером");
      return;
    }
    navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: false,
      maximumAge: 5000,
      timeout: 20000,
    });
  }

  // ---------- сокет ----------

  function connectSocket() {
    socket = io();
    socket.on("users:update", (payload) => MapModule.updateUsers(payload));
    socket.on("banned", () => {
      socket.disconnect();
      $("banned-overlay").classList.remove("hidden");
    });
    socket.on("force:logout", () => {
      socket.disconnect();
      location.reload();
    });
    socket.on("disconnect", () => {
      // socket.io переподключится сам; координаты временно пойдут через REST
    });
  }

  // ---------- геолокация ----------

  function onPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (accuracy !== null && accuracy > 100) {
      showGeoStatus("Определяем позицию… (±" + Math.round(accuracy) + " м)");
      MapModule.onOwnPosition(lat, lon, accuracy); // локально показываем грубый фикс
      return; // но другим не отправляем
    }
    hideGeoStatus();
    MapModule.onOwnPosition(lat, lon, accuracy);
    maybeSend(lat, lon, accuracy);
  }

  function onGeoError(err) {
    if (err.code === 1) {
      $("geo-denied").classList.remove("hidden");
    } else {
      showGeoStatus("Не удаётся определить позицию…");
    }
  }

  function showGeoStatus(text) {
    const el = $("geo-status");
    el.textContent = text;
    el.classList.remove("hidden");
  }
  function hideGeoStatus() { $("geo-status").classList.add("hidden"); }

  function maybeSend(lat, lon, accuracy) {
    if (hidden || observer) return;
    const now = Date.now();
    if (lastSent) {
      const dt = now - lastSent.t;
      const dist = haversineM(lastSent.lat, lastSent.lon, lat, lon);
      if (dt < SEND_INTERVAL_MS) return;
      if (dist < SEND_DISTANCE_M && dt < KEEPALIVE_MS) return;
    }
    lastSent = { lat, lon, t: now };
    if (socket && socket.connected) {
      socket.emit("location:update", { lat, lon, accuracy });
    } else {
      api.post("/api/location", { lat, lon, accuracy }).catch(() => {});
    }
  }

  // ---------- видимость ----------

  function updateVisibilityButton() {
    $("btn-visibility").textContent = hidden ? "Показать меня" : "Скрыть меня";
  }

  async function toggleVisibility() {
    try {
      const res = await api.post("/api/visibility", { hidden: !hidden });
      hidden = res.hidden;
      lastSent = null; // при повторном показе отправим позицию сразу
      updateVisibilityButton();
      toast(hidden ? "Вы скрыты с карты" : "Вы снова видны на карте");
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- админ-панель ----------

  async function openAdmin() {
    $("admin-panel").classList.remove("hidden");
    await reloadAdminTable();
  }

  async function reloadAdminTable() {
    try {
      const { users } = await api.get("/api/admin/users");
      const tbody = document.querySelector("#admin-table tbody");
      tbody.textContent = "";
      for (const u of users) {
        tbody.appendChild(adminRow(u));
      }
    } catch (e) {
      toast(e.message);
    }
  }

  function adminRow(u) {
    const tr = document.createElement("tr");
    const isSelf = me && u.id === me.id;

    const tdLogin = document.createElement("td");
    tdLogin.textContent = u.login + (isSelf ? " (вы)" : "");

    const tdStatus = document.createElement("td");
    if (u.isAdmin) tdStatus.appendChild(badge("админ", "accent"));
    if (u.isBanned) tdStatus.appendChild(badge("забанен", "danger"));
    else if (u.isHidden) tdStatus.appendChild(badge("скрыт", ""));
    else if (u.online) tdStatus.appendChild(badge("онлайн", "ok"));

    const tdActions = document.createElement("td");
    if (!isSelf) {
      const actions = document.createElement("div");
      actions.className = "admin-actions";

      const banBtn = document.createElement("button");
      banBtn.className = "btn small" + (u.isBanned ? "" : " danger");
      banBtn.textContent = u.isBanned ? "Разбанить" : "Бан";
      banBtn.onclick = () => adminAction(() =>
        api.post("/api/admin/" + (u.isBanned ? "unban/" : "ban/") + u.id)
      );
      actions.appendChild(banBtn);

      const adminBtn = document.createElement("button");
      adminBtn.className = "btn small";
      adminBtn.textContent = u.isAdmin ? "Снять админа" : "Сделать админом";
      adminBtn.onclick = () => adminAction(() =>
        api.post("/api/admin/admin/" + u.id, { isAdmin: !u.isAdmin })
      );
      actions.appendChild(adminBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "btn small danger";
      delBtn.textContent = "Удалить";
      delBtn.onclick = () => {
        if (confirm("Удалить пользователя «" + u.login + "»? Действие необратимо.")) {
          adminAction(() => api.del("/api/admin/user/" + u.id));
        }
      };
      actions.appendChild(delBtn);

      tdActions.appendChild(actions);
    }

    tr.append(tdLogin, tdStatus, tdActions);
    return tr;
  }

  function badge(text, cls) {
    const b = document.createElement("span");
    b.className = "badge " + cls;
    b.textContent = text;
    return b;
  }

  async function adminAction(fn) {
    try {
      await fn();
      await reloadAdminTable();
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- инициализация ----------

  function bindEvents() {
    $("tab-login").onclick = () => setAuthMode("login");
    $("tab-register").onclick = () => setAuthMode("register");
    $("form-auth").onsubmit = onAuthSubmit;
    $("chk-observer").checked = observer;
    $("chk-observer").onchange = (e) => setObserver(e.target.checked);

    $("btn-logout").onclick = async () => {
      try { await api.post("/api/logout"); } catch { /* не страшно */ }
      location.reload();
    };
    $("btn-visibility").onclick = toggleVisibility;
    $("btn-enable-geo").onclick = () => setObserver(false);
    $("btn-continue-no-geo").onclick = () => setObserver(true);
    $("btn-locate").onclick = () => MapModule.recenter();
    $("btn-users").onclick = () => $("sidebar").classList.toggle("open");
    $("btn-admin").onclick = openAdmin;
    $("admin-close").onclick = () => $("admin-panel").classList.add("hidden");
  }

  async function boot() {
    bindEvents();
    try {
      const { me: m } = await api.get("/api/me");
      startApp(m);
    } catch {
      showAuth();
    }
  }

  boot();

  return { toast };
})();
