import crypto from "node:crypto";

const ADMIN_TOKEN_ENV_KEYS = ["XAU_ADMIN_TOKEN", "ADMIN_TOKEN", "API_ADMIN_TOKEN"];

function configuredToken() {
  for (const key of ADMIN_TOKEN_ENV_KEYS) {
    const value = process.env[key];
    if (value) return String(value);
  }
  return "";
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return cryptoSafeEqual(leftBuffer, rightBuffer);
}

function cryptoSafeEqual(leftBuffer, rightBuffer) {
  try {
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function bearerToken(req, url = null) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (url?.searchParams?.get("adminToken")) return String(url.searchParams.get("adminToken")).trim();
  return String(req.headers["x-admin-token"] || "").trim();
}

export function authStatus() {
  return {
    adminTokenConfigured: Boolean(configuredToken()),
    protectedWrites: true
  };
}

export function isAdminRequest(req, url = null) {
  const token = configuredToken();
  if (!token) return false;
  return timingSafeEqualText(bearerToken(req, url), token);
}

export function protectAdminRoute(req, res, json) {
  const token = configuredToken();
  if (!token) {
    json(res, {
      ok: false,
      error: "admin_auth_not_configured",
      message: "Set XAU_ADMIN_TOKEN before using write/admin APIs."
    }, 503);
    return false;
  }
  if (!isAdminRequest(req)) {
    json(res, {
      ok: false,
      error: "unauthorized",
      message: "Admin token is required."
    }, 401);
    return false;
  }
  return true;
}

export function isProtectedApiRoute(method, pathname) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  return pathname === "/api/export/trades.csv" || pathname === "/api/logs";
}

export function maskSecret(value) {
  return value ? "********" : "";
}

export function sanitizeSettings(settings, { admin = false } = {}) {
  const out = structuredClone(settings || {});
  if (!admin && out.notifications?.feishu) {
    out.notifications.feishu = {
      ...out.notifications.feishu,
      webhookUrl: maskSecret(out.notifications.feishu.webhookUrl),
      webhookConfigured: Boolean(out.notifications.feishu.webhookUrl)
    };
  }
  return out;
}
