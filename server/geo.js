/** Гео-утилиты и валидация координат. */

function toNum(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Проверяет и нормализует { lat, lon, accuracy }.
 * Возвращает { lat, lon, accuracy } или null, если координаты невалидны.
 */
function validateCoords(data) {
  if (!data || typeof data !== "object") return null;
  const lat = toNum(data.lat);
  const lon = toNum(data.lon);
  let accuracy = toNum(data.accuracy);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (accuracy === null || accuracy < 0 || accuracy > 100000) accuracy = null;
  return { lat, lon, accuracy };
}

/** Расстояние между двумя точками в метрах (гаверсинус). */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { validateCoords, haversineM };
