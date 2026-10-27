import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSaveRequest, wrapHandler } from "../src/main/webRemoteAccess/saveRequest.js";

test("parseSaveRequest 接受合法保存请求并收窄类型", () => {
  const request = parseSaveRequest({
    mode: "open",
    cfTeamDomain: " ",
    cfAud: "",
    cfAllowedEmails: [" a@b.com ", "", "c@d.com"],
    externalBaseUrl: "  https://zcode.example.com  ",
    regenerate: false,
    desktopEnabled: true,
    quickTunnelEnabled: true,
  });
  // 空项必须在此层过滤：allowlist 混入 "" 会把「无 email claim 的合法 JWT」放行
  // （校验端 isEmailAllowlisted 跳过空候选是第二重保险）。
  assert.deepEqual(request, {
    mode: "open",
    cfTeamDomain: "",
    cfAud: "",
    cfAllowedEmails: ["a@b.com", "c@d.com"],
    externalBaseUrl: "https://zcode.example.com",
    desktopEnabled: true,
    quickTunnelEnabled: true,
    regenerate: false,
  });
});

test("parseSaveRequest：全空 allowlist 过滤后为空数组（= 不限制 email）", () => {
  const request = parseSaveRequest({ mode: "cloudflare-access", cfAllowedEmails: ["", "  "] });
  assert.deepEqual(request, { mode: "cloudflare-access", cfAllowedEmails: [] });
});

test("parseSaveRequest 拒绝非对象与越界 mode（含 event 对象被误当 payload 的场景）", () => {
  assert.equal(parseSaveRequest(null), null);
  assert.equal(parseSaveRequest("open"), null);
  // ipcMain.handle 首参是 event：其中不存在字符串 mode 字段，必须判 null。
  assert.equal(parseSaveRequest({ sender: {}, frameId: 1 }), null);
  assert.equal(parseSaveRequest({ mode: "bogus" }), null);
  assert.equal(parseSaveRequest({ mode: 123 }), null);
});

test("wrapHandler 把 invoke 的 payload（而非 event）交给 handler", async () => {
  const seen: unknown[] = [];
  const wrapped = wrapHandler("test-channel", async (payload) => {
    seen.push(payload);
    return "ok";
  }, () => {});
  const fakeEvent = { sender: "renderer", frameId: 1 };
  const result = await wrapped(fakeEvent as never, { mode: "open" });
  assert.equal(result, "ok");
  assert.deepEqual(seen, [{ mode: "open" }]);
});

test("wrapHandler 在 handler 抛错时记录日志并原样上抛", async () => {
  const logged: unknown[][] = [];
  const wrapped = wrapHandler("test-channel", async () => {
    throw new Error("boom");
  }, (...args) => logged.push(args));
  await assert.rejects(() => wrapped({} as never, { mode: "open" }), /boom/);
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]?.[0]), /test-channel/);
  assert.match(String(logged[0]?.[1]), /boom/);
});
