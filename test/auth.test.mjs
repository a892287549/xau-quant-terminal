import test from "node:test";
import assert from "node:assert/strict";
import { authStatus, isAdminRequest, sanitizeSettings } from "../server/security/auth.js";

test("admin auth reports protected writes without a configured token", () => {
  const previous = process.env.XAU_ADMIN_TOKEN;
  delete process.env.XAU_ADMIN_TOKEN;
  assert.equal(authStatus().protectedWrites, true);
  assert.equal(authStatus().adminTokenConfigured, false);
  assert.equal(isAdminRequest({ headers: {} }), false);
  if (previous !== undefined) process.env.XAU_ADMIN_TOKEN = previous;
});

test("admin auth accepts bearer token using timing-safe comparison", () => {
  const previous = process.env.XAU_ADMIN_TOKEN;
  process.env.XAU_ADMIN_TOKEN = "secret-token";
  assert.equal(isAdminRequest({ headers: { authorization: "Bearer secret-token" } }), true);
  assert.equal(isAdminRequest({ headers: { authorization: "Bearer wrong" } }), false);
  if (previous === undefined) delete process.env.XAU_ADMIN_TOKEN;
  else process.env.XAU_ADMIN_TOKEN = previous;
});

test("settings sanitizer masks Feishu webhook for read-only clients", () => {
  const settings = {
    notifications: {
      feishu: {
        enabled: true,
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/secret"
      }
    }
  };
  const sanitized = sanitizeSettings(settings);
  assert.equal(sanitized.notifications.feishu.webhookUrl, "********");
  assert.equal(sanitized.notifications.feishu.webhookConfigured, true);
});
