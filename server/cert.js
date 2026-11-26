require("reflect-metadata");
const fs = require("fs");
const path = require("path");
const { webcrypto } = require("crypto");
const x509 = require("@peculiar/x509");
const logger = require("./logger");

const CERT_DAYS = 825; // максимум, который принимает iOS для сертификатов без CA
const RENEW_MARGIN_MS = 7 * 24 * 3600 * 1000; // перевыпускать за неделю до истечения

function pemEncode(der, label) {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function generate(ip) {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01" + Date.now().toString(16),
    name: "CN=Pocket Beacon",
    notBefore: new Date(Date.now() - 24 * 3600 * 1000),
    notAfter: new Date(Date.now() + CERT_DAYS * 24 * 3600 * 1000),
    signingAlgorithm: { name: "SHA-256" },
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
        { type: "ip", value: ip },
      ]),
      new x509.BasicConstraintsExtension({ ca: false }),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true
      ),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]), // serverAuth
    ],
  });

  const keyPem = pemEncode(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
    "PRIVATE KEY"
  );
  const certPem = cert.toString("pem");
  return { keyPem, certPem };
}

/**
 * Возвращает { key, cert } для HTTPS.
 * Перевыпускает сертификат, если он отсутствует, истёк или IP сервера сменился.
 */
async function ensureCerts(certsDir, ip) {
  fs.mkdirSync(certsDir, { recursive: true });
  const keyPath = path.join(certsDir, "key.pem");
  const certPath = path.join(certsDir, "cert.pem");
  const metaPath = path.join(certsDir, "meta.json");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const fresh = new Date(meta.notAfter).getTime() > Date.now() + RENEW_MARGIN_MS;
      if (meta.ip === ip && fresh) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      }
      logger.log("IP сервера сменился или сертификат истекает — перевыпускаю.");
    } catch {
      // битая мета — просто перевыпустим
    }
  }

  logger.log(`Генерирую самоподписанный сертификат для IP ${ip}...`);
  const { keyPem, certPem } = await generate(ip);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      ip,
      notAfter: new Date(Date.now() + CERT_DAYS * 24 * 3600 * 1000).toISOString(),
    })
  );
  return { key: Buffer.from(keyPem), cert: Buffer.from(certPem) };
}

module.exports = { ensureCerts };
