const os = require("os");

// Подстроки в именах адаптеров, которые почти наверняка не являются LAN
const VIRTUAL_HINTS = [
  "vethernet",
  "vmware",
  "virtualbox",
  "hyper-v",
  "wsl",
  "loopback",
  "tailscale",
  "zerotier",
  "vpn",
  "tap-",
  "tun",
  "bluetooth",
  "docker",
  "isatap",
  "teredo",
];

function scoreAdapter(name, ip) {
  const n = name.toLowerCase();
  if (VIRTUAL_HINTS.some((h) => n.includes(h))) return -1;
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0; // публичный/необычный адрес — на крайний случай
}

/** Определяет IPv4-адрес машины в локальной сети. */
function getLanIp() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const isV4 = a.family === "IPv4" || a.family === 4;
      if (!isV4 || a.internal) continue;
      const score = scoreAdapter(name, a.address);
      if (score >= 0) candidates.push({ ip: a.address, score, name });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    throw new Error(
      "Не удалось определить IP-адрес в локальной сети. Задайте HOST_IP в файле .env вручную."
    );
  }
  return candidates[0].ip;
}

module.exports = { getLanIp };
