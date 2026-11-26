/**
 * MapModule — карта Leaflet, маркеры пользователей, треки, списки.
 * Весь пользовательский текст вставляется через textContent — защита от XSS.
 */
const MapModule = (() => {
  let map = null;
  let me = null;
  let meMarker = null;
  let meCircle = null;
  let hasCentered = false;
  const markers = new Map(); // userId -> L.Marker
  const tracks = new Map(); // userId -> L.Polyline
  let serverOffset = 0; // serverTime - Date.now(): компенсация расхождения часов
  let lastPayload = null;

  const STALE_MS = 120000; // старше 2 мин — приглушаем маркер

  // ---------- инициализация ----------

  function init(meUser) {
    me = meUser;
    map = L.map("map").setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(map);
    setInterval(refreshTracks, 30000);
    setInterval(() => lastPayload && renderLists(lastPayload), 10000);
  }

  // ---------- своё местоположение ----------

  function onOwnPosition(lat, lon, accuracy) {
    if (!meMarker) {
      meMarker = L.circleMarker([lat, lon], {
        radius: 8, color: "#fff", weight: 2, fillColor: "#2b7de9", fillOpacity: 1,
      }).addTo(map);
      meCircle = L.circle([lat, lon], {
        radius: accuracy || 0, color: "#2b7de9", weight: 1, opacity: 0.4, fillOpacity: 0.08,
      }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lon]);
      meCircle.setLatLng([lat, lon]);
      meCircle.setRadius(accuracy || 0);
    }
    if (!hasCentered && (accuracy === null || accuracy <= 100)) {
      map.setView([lat, lon], 17);
      hasCentered = true;
    }
  }

  function recenter() {
    if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16));
  }

  // ---------- пользователи ----------

  function ageText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return "сейчас";
    if (s < 60) return s + " сек назад";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " мин назад";
    return Math.floor(m / 60) + " ч назад";
  }

  function makeTooltip(text) {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  }

  function upsertMarker(u, stale) {
    let entry = markers.get(u.id);
    if (!entry) {
      const marker = L.circleMarker([u.lat, u.lon], {
        radius: 8, color: "#fff", weight: 2, fillColor: "#e9902b", fillOpacity: 1,
      }).addTo(map);
      marker.on("click", () => toggleTrack(u.id));
      entry = { marker };
      markers.set(u.id, entry);
    }
    entry.marker.setLatLng([u.lat, u.lon]);
    entry.marker.setStyle({ opacity: stale ? 0.45 : 1, fillOpacity: stale ? 0.45 : 1 });
    const label = stale ? `${u.login} · ${ageText(serverNow() - u.updatedAt)}` : u.login;
    entry.marker.bindTooltip(makeTooltip(label), {
      permanent: true, direction: "top", offset: [0, -10], className: "user-label",
    });
  }

  function serverNow() {
    return Date.now() + serverOffset;
  }

  function updateUsers(payload) {
    serverOffset = payload.serverTime - Date.now();
    lastPayload = payload;

    const now = serverNow();
    const seen = new Set();

    for (const u of payload.visible) {
      if (me && u.id === me.id) continue; // себя рисуем по локальному GPS
      seen.add(u.id);
      upsertMarker(u, now - u.updatedAt > STALE_MS);
    }
    // удаляем маркеры и треки пропавших (скрылись, забанены, удалились)
    for (const [id, entry] of markers) {
      if (!seen.has(id)) {
        map.removeLayer(entry.marker);
        markers.delete(id);
      }
    }
    for (const [id, line] of tracks) {
      if (!seen.has(id)) {
        map.removeLayer(line);
        tracks.delete(id);
      }
    }
    renderLists(payload);
  }

  // ---------- списки в сайдбаре ----------

  function renderLists(payload) {
    const now = serverNow();
    const visibleUl = document.getElementById("list-visible");
    const hiddenUl = document.getElementById("list-hidden");
    visibleUl.textContent = "";
    hiddenUl.textContent = "";

    const visible = payload.visible.filter((u) => !me || u.id !== me.id);
    if (!visible.length) {
      visibleUl.appendChild(emptyItem("Никого нет на карте"));
    }
    for (const u of visible) {
      const stale = now - u.updatedAt > STALE_MS;
      const li = document.createElement("li");

      const dot = document.createElement("span");
      dot.className = "dot " + (stale ? "stale" : "online");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = u.login;

      const age = document.createElement("span");
      age.className = "age";
      age.textContent = ageText(now - u.updatedAt);

      const btn = document.createElement("button");
      btn.className = "btn small" + (tracks.has(u.id) ? " primary" : "");
      btn.textContent = tracks.has(u.id) ? "Скрыть трек" : "Трек";
      btn.onclick = () => toggleTrack(u.id);

      li.append(dot, name, age, btn);
      visibleUl.appendChild(li);
    }

    const others = payload.hidden.filter((u) => !me || u.id !== me.id);
    const selfHidden = me && payload.hidden.some((u) => u.id === me.id);
    if (!others.length && !selfHidden) {
      hiddenUl.appendChild(emptyItem("Нет скрытых пользователей"));
    }
    for (const u of others) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot hidden-dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = u.login;
      const badge = document.createElement("span");
      badge.className = "age";
      badge.textContent = "скрыт";
      li.append(dot, name, badge);
      hiddenUl.appendChild(li);
    }
    if (selfHidden) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot hidden-dot";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = me.login + " (вы)";
      const badge = document.createElement("span");
      badge.className = "age";
      badge.textContent = "скрыт";
      li.append(dot, name, badge);
      hiddenUl.appendChild(li);
    }
  }

  function emptyItem(text) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = text;
    return li;
  }

  // ---------- треки ----------

  async function toggleTrack(userId) {
    if (tracks.has(userId)) {
      map.removeLayer(tracks.get(userId));
      tracks.delete(userId);
      if (lastPayload) renderLists(lastPayload);
      return;
    }
    try {
      const { points } = await api.get("/api/history/" + userId);
      if (!points.length) {
        App.toast("Нет данных о перемещениях");
        return;
      }
      const line = L.polyline(
        points.map((p) => [p.lat, p.lon]),
        { weight: 3, opacity: 0.75, color: "#e9902b" }
      ).addTo(map);
      tracks.set(userId, line);
    } catch (e) {
      App.toast(e.message);
    }
    if (lastPayload) renderLists(lastPayload);
  }

  async function refreshTracks() {
    for (const [id, line] of tracks) {
      try {
        const { points } = await api.get("/api/history/" + id);
        if (!points.length) {
          map.removeLayer(line);
          tracks.delete(id);
        } else {
          line.setLatLngs(points.map((p) => [p.lat, p.lon]));
        }
      } catch { /* сеть моргнула — обновим в следующий раз */ }
    }
  }

  return { init, onOwnPosition, recenter, updateUsers };
})();
