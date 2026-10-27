import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { WebSocket } from "ws";
import type { ServerResponse } from "node:http";
import {
  generateWebAccessToken,
  getDefaultWebAccessConfig,
  type WebAccessConfig,
} from "@zcode/server";
import {
  AuthFailureLimiter,
  isProxiedRequest,
  resolveAuthFailureKey,
  startWebRemoteAccessHttpServer,
  type WebRemoteAccessHttpServerHandle,
} from "../src/main/webRemoteAccess/webRemoteAccessHttpServer.js";
import { setDataBaseDir } from "@zcode/services/node";

interface TestFixture {
  handle: WebRemoteAccessHttpServerHandle;
  port: number;
  staticDir: string;
  baseDir: string;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** 固定设备标识（默认实现取 os.hostname()，测试注入以便断言链接与鉴权）。 */
const TEST_DEVICE = "test-host";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Zcode-Device": TEST_DEVICE,
  };
}

function wsPath(token: string): string {
  return `/ws?token=${encodeURIComponent(token)}&device=${encodeURIComponent(TEST_DEVICE)}`;
}

function makeConfig(overrides: Partial<WebAccessConfig>): WebAccessConfig {
  return { ...getDefaultWebAccessConfig(), ...overrides };
}

async function startFixture(
  config: WebAccessConfig,
  onClientConnected: (ws: import("ws").WebSocket) => void = () => {},
  onConfigUpdated?: (generatedToken?: string) => void,
): Promise<TestFixture> {
  // staticDir 是 baseDir 的子目录：穿越测试需要一个位于静态根之外的同级文件。
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-web-ra-test-"));
  const staticDir = join(baseDir, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<html>index</html>");
  const handle = await startWebRemoteAccessHttpServer({
    config,
    bindHost: "127.0.0.1",
    port: 0,
    webStaticDir: staticDir,
    deviceName: TEST_DEVICE,
    onClientConnected,
    onConfigUpdated,
    logger: noopLogger,
  });
  const port = handle.port;
  return { handle, port, staticDir, baseDir };
}

interface UpgradeResult {
  status?: number;
  upgraded?: boolean;
}

/** 裸 http upgrade 请求：完全掌控 Host/Origin 头（ws 客户端会按 URL 重写 Host）。 */
function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve({ upgraded: true });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", () => resolve({}));
    req.end();
  });
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status?: number;
  headers: ServerResponse["headers"];
  body: string;
}> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, headers });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", () => resolve({ headers: {}, body: "" }));
    req.end();
  });
}

test("open 档：非浏览器（无 Origin）可升级，同源 Origin 可升级", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  onTestFinished(() => fixture.handle.stop());
  const noOrigin = await rawUpgrade(fixture.port, "/ws", {});
  assert.equal(noOrigin.upgraded, true);
  const sameOrigin = await rawUpgrade(fixture.port, "/ws", {
    host: `127.0.0.1:${fixture.port}`,
    origin: `http://127.0.0.1:${fixture.port}`,
  });
  assert.equal(sameOrigin.upgraded, true);
});

test("open 档：跨源 Origin 与非回环 Host 的升级被拒（CSWSH / rebinding 防线）", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  onTestFinished(() => fixture.handle.stop());
  const crossOrigin = await rawUpgrade(fixture.port, "/ws", {
    host: `127.0.0.1:${fixture.port}`,
    origin: "http://evil.com",
  });
  assert.equal(crossOrigin.status, 403);
  // 本机另一端口的页面也不得桥接（端口参与同源判定）。
  const otherPort = await rawUpgrade(fixture.port, "/ws", {
    host: `127.0.0.1:${fixture.port}`,
    origin: "http://127.0.0.1:9999",
  });
  assert.equal(otherPort.status, 403);
  // DNS rebinding：Host 指向非回环域名。
  const rebound = await rawUpgrade(fixture.port, "/ws", { host: "evil.com" });
  assert.equal(rebound.status, 403);
});

test("token 档：无 token 401，带 token 升级成功，token + 跨源 Origin 仍被拒", async () => {
  const generated = generateWebAccessToken();
  const fixture = await startFixture(makeConfig({ mode: "token", tokenHash: generated.tokenHash }));
  onTestFinished(() => fixture.handle.stop());
  const noToken = await rawUpgrade(fixture.port, "/ws", {});
  assert.equal(noToken.status, 401);
  // 只有 token、缺设备标识：token 档同样拒绝（访问链接必须带 #device=）。
  const noDevice = await rawUpgrade(fixture.port, `/ws?token=${generated.token}`, {
    host: `127.0.0.1:${fixture.port}`,
  });
  assert.equal(noDevice.status, 401);
  const withToken = await rawUpgrade(fixture.port, wsPath(generated.token), {
    host: `127.0.0.1:${fixture.port}`,
  });
  assert.equal(withToken.upgraded, true);
  // 设备标识不匹配：token 有效也拒绝（403），链接不能跨机器直接复用。
  const wrongDevice = await rawUpgrade(
    fixture.port,
    `/ws?token=${generated.token}&device=another-host`,
    { host: `127.0.0.1:${fixture.port}` },
  );
  assert.equal(wrongDevice.status, 403);
  // token 不豁免来源校验：浏览器侧防线独立于凭据。
  const tokenCrossOrigin = await rawUpgrade(fixture.port, wsPath(generated.token), {
    host: `127.0.0.1:${fixture.port}`,
    origin: "http://evil.com",
  });
  assert.equal(tokenCrossOrigin.status, 403);
  // HTTP 侧：无 token 的 /api/* 请求 401。
  const apiNoToken = await httpGet(fixture.port, "/api/anything");
  assert.equal(apiNoToken.status, 401);
});

test("单会话：后登录以 4001 关闭前一个连接，新连接保持可用", async () => {
  const generated = generateWebAccessToken();
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: generated.tokenHash }),
  );
  onTestFinished(() => fixture.handle.stop());

  const openWs = (): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}${wsPath(generated.token)}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  const first = await openWs();
  const firstClosed = new Promise<number>((resolve) => {
    first.once("close", (code) => resolve(code));
  });
  const second = await openWs();
  assert.equal(await firstClosed, 4001);

  const secondClosed = new Promise<number>((resolve) => {
    second.once("close", (code) => resolve(code));
  });
  const third = await openWs();
  assert.equal(await secondClosed, 4001);
  assert.equal(third.readyState, WebSocket.OPEN);
  third.close();
});

test("CF 档：HTTP 缺 JWT 头 401 且走异步验签分支（detail 证明分支可达）", async () => {
  const fixture = await startFixture(
    makeConfig({ mode: "cloudflare-access", cfTeamDomain: "team.example.com", cfAud: "aud" }),
  );
  onTestFinished(() => fixture.handle.stop());
  const api = await httpGet(fixture.port, "/api/anything");
  assert.equal(api.status, 401);
  // 旧实现此处是同步分支的 "cloudflare-access requires async verification"（死代码不可达）。
  assert.match(api.body, /missing Cf-Access-Jwt-Assertion header/);
  const upgrade = await rawUpgrade(fixture.port, "/ws", {});
  assert.equal(upgrade.status, 401);
});

test("CF 档：跨源 Origin 在 JWT 验签之前被拒（403，无需出网）", async () => {
  const fixture = await startFixture(
    makeConfig({ mode: "cloudflare-access", cfTeamDomain: "team.example.com", cfAud: "aud" }),
  );
  onTestFinished(() => fixture.handle.stop());
  const result = await rawUpgrade(fixture.port, "/ws", {
    host: `127.0.0.1:${fixture.port}`,
    origin: "http://evil.com",
  });
  assert.equal(result.status, 403);
});

test("静态资源：nosniff 安全头、SPA fallback、路径穿越不外泄", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  onTestFinished(async () => {
    await fixture.handle.stop();
    await rm(fixture.baseDir, { recursive: true, force: true });
  });
  // 秘密文件放在静态根之外（静态根的同级目录）：穿越成功才可能读到它。
  // 注意 /../secret 会被 WHATWG URL 规范化为 /secret，真正的穿越要在单个
  // 路径段里携带点段（%2e%2e）或编码分隔符（%2f），服务端解码后必须被 relative 判定拦下。
  const secretPath = join(fixture.baseDir, "zcode-ra-secret.txt");
  await writeFile(secretPath, "TOPSECRET");
  const index = await httpGet(fixture.port, "/");
  assert.equal(index.status, 200);
  assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.match(index.body, /index/);
  const spa = await httpGet(fixture.port, "/some/spa/route");
  assert.equal(spa.status, 200);
  assert.match(spa.body, /index/);
  for (const attempt of [
    "/%2e%2e/zcode-ra-secret.txt",
    "/..%2fzcode-ra-secret.txt",
    "/..%5czcode-ra-secret.txt",
    "/x/../../zcode-ra-secret.txt",
  ]) {
    const result = await httpGet(fixture.port, attempt);
    assert.ok(!result.body.includes("TOPSECRET"), `穿越尝试不应读到静态根之外的文件: ${attempt}`);
  }
});

test("stop 在有在线客户端时必须在有限时间内 resolve（回归：保存/停用挂死）", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });
  const client = new WebSocket(`ws://127.0.0.1:${fixture.port}/ws`);
  const opened = new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  await opened;
  // terminate 可能以 error 事件收尾（时序因平台而异）：open 之后再到的 error
  // 不允许变成未处理异常炸掉测试进程。
  client.on("error", () => {});
  const stopDone = fixture.handle.stop();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("stop() 超时：存在在线客户端时未 resolve")), 3000),
  );
  await Promise.race([stopDone, timeout]);
  client.terminate();
});

/** PUT JSON 请求（本机设置页保存路径）。 */
function httpPut(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status?: number; headers: ServerResponse["headers"]; body: string }> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
    });
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", () => resolve({ headers: {}, body: "" }));
    req.end(body);
  });
}

/** PUT 测试要写 web-access.json：把数据根指到临时目录，测试结束后还原全局状态。 */
function isolateConfigDir(baseDir: string): void {
  setDataBaseDir(baseDir);
  onTestFinished(() => setDataBaseDir(null));
}

/** GET 从磁盘读配置（与生产一致：controller 落盘后才启动 server）；测试需要先种子文件。 */
async function seedConfigFile(baseDir: string, config: WebAccessConfig): Promise<void> {
  const configDir = join(baseDir, ".zcode", "v2");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "web-access.json"), JSON.stringify(config));
}

test("open 档：GET config/interfaces 返回 JSON 视图，未挂载 /api 回 404 JSON 而非 SPA fallback", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });
  const config = await httpGet(fixture.port, "/api/web-access/config");
  assert.equal(config.status, 200);
  assert.match(config.headers["content-type"] ?? "", /application\/json/);
  const configBody = JSON.parse(config.body) as Record<string, unknown>;
  assert.equal(configBody.mode, "open");
  assert.equal(configBody.port, fixture.port);
  assert.equal(configBody.hasToken, false);

  const interfaces = await httpGet(fixture.port, "/api/web-access/interfaces");
  assert.equal(interfaces.status, 200);
  const interfacesBody = JSON.parse(interfaces.body) as { interfaces: unknown[]; port: number };
  assert.ok(Array.isArray(interfacesBody.interfaces));
  assert.equal(interfacesBody.port, fixture.port);

  const unknownApi = await httpGet(fixture.port, "/api/unknown");
  assert.equal(unknownApi.status, 404);
  assert.match(unknownApi.headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(unknownApi.body), { error: "not found" });

  const unknownWebAccessApi = await httpGet(fixture.port, "/api/web-access/whatever");
  assert.equal(unknownWebAccessApi.status, 404);
  assert.match(unknownWebAccessApi.headers["content-type"] ?? "", /application\/json/);

  // SPA fallback 只服务非 /api 路径，行为不回退。
  const spa = await httpGet(fixture.port, "/settings/remote-access");
  assert.equal(spa.status, 200);
  assert.match(spa.headers["content-type"] ?? "", /text\/html/);
  assert.ok(spa.body.includes("index"));
});

test("open 档：本机浏览器 PUT 保存落盘（用户场景），非法入参 400", async () => {
  const fixture = await startFixture(makeConfig({ mode: "open" }));
  isolateConfigDir(fixture.baseDir);
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });

  const saved = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({
      mode: "open",
      cfTeamDomain: "",
      cfAud: "",
      cfAllowedEmails: [],
      externalBaseUrl: "http://192.168.1.5:30330",
      regenerate: false,
    }),
  );
  assert.equal(saved.status, 200);
  const savedBody = JSON.parse(saved.body) as { externalBaseUrl: string; mode: string };
  assert.equal(savedBody.mode, "open");
  assert.equal(savedBody.externalBaseUrl, "http://192.168.1.5:30330");

  // 落盘事实经 GET 读回（loadWebAccessConfig 走同一磁盘文件）。
  const readBack = await httpGet(fixture.port, "/api/web-access/config");
  assert.equal(readBack.status, 200);
  assert.equal(JSON.parse(readBack.body).externalBaseUrl, "http://192.168.1.5:30330");

  const badUrl = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({ mode: "open", externalBaseUrl: "ftp://example.com" }),
  );
  assert.equal(badUrl.status, 400);

  const badJson = await httpPut(fixture.port, "/api/web-access/config", "{not-json");
  assert.equal(badJson.status, 400);
});

test("token 档：GET 需凭据，PUT regenerate 返回一次性 token 并触发 onConfigUpdated", async () => {
  const initial = generateWebAccessToken();
  let configUpdatedCount = 0;
  const updatedTokens: Array<string | undefined> = [];
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: initial.tokenHash, tokenPrefix: initial.tokenPrefix }),
    () => {},
    (generatedToken) => {
      configUpdatedCount += 1;
      updatedTokens.push(generatedToken);
    },
  );
  isolateConfigDir(fixture.baseDir);
  await seedConfigFile(
    fixture.baseDir,
    makeConfig({
      mode: "token",
      tokenHash: initial.tokenHash,
      tokenPrefix: initial.tokenPrefix,
    }),
  );
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });

  const unauthorized = await httpGet(fixture.port, "/api/web-access/config");
  assert.equal(unauthorized.status, 401);

  const readView = await httpGet(
    fixture.port,
    "/api/web-access/config",
    authHeaders(initial.token),
  );
  assert.equal(readView.status, 200);
  assert.equal(JSON.parse(readView.body).tokenPrefix, initial.tokenPrefix);

  const saved = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({
      mode: "token",
      cfTeamDomain: "",
      cfAud: "",
      cfAllowedEmails: [],
      externalBaseUrl: "http://192.168.1.9:30330",
      regenerate: true,
    }),
    { Authorization: `Bearer ${initial.token}`, "X-Zcode-Device": TEST_DEVICE },
  );
  assert.equal(saved.status, 200);
  const savedBody = JSON.parse(saved.body) as {
    token?: string;
    accessUrl?: string;
    tokenPrefix: string;
  };
  assert.ok(savedBody.token && savedBody.token !== initial.token);
  assert.equal(
    savedBody.accessUrl,
    `http://192.168.1.9:30330/#token=${savedBody.token}&device=${TEST_DEVICE}`,
  );

  // 鉴权快照按「启动时快照；改动重启生效」语义仍认旧 token；磁盘 hash 已更新——
  // GET 视图（读磁盘）回新前缀。旧 token 真正失效发生在 controller restartFromDisk
  // 用新配置重建监听之后（controller 层职责，不在本层断言）。
  const diskView = await httpGet(
    fixture.port,
    "/api/web-access/config",
    authHeaders(initial.token),
  );
  assert.equal(diskView.status, 200);
  assert.equal(JSON.parse(diskView.body).tokenPrefix, savedBody.tokenPrefix);

  // 回包完成后才触发重建回调（controller 在真实链路里据此停旧起新）。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(configUpdatedCount, 1);
  // 明文必须随回调交给 controller：磁盘只有 hash，否则手机弹窗无法复用这条一次性链接。
  assert.equal(updatedTokens[0], savedBody.token);

  const unauthorizedPut = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({ mode: "token" }),
  );
  assert.equal(unauthorizedPut.status, 401);
});

test("token 档：基址留空时 PUT regenerate 仍返回回退链接（弹窗可直接出二维码）", async () => {
  const initial = generateWebAccessToken();
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: initial.tokenHash, tokenPrefix: initial.tokenPrefix }),
  );
  isolateConfigDir(fixture.baseDir);
  await seedConfigFile(
    fixture.baseDir,
    makeConfig({
      mode: "token",
      tokenHash: initial.tokenHash,
      tokenPrefix: initial.tokenPrefix,
    }),
  );
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });

  const saved = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({ mode: "token", externalBaseUrl: "", regenerate: true }),
    { Authorization: `Bearer ${initial.token}`, "X-Zcode-Device": TEST_DEVICE },
  );
  assert.equal(saved.status, 200);
  const savedBody = JSON.parse(saved.body) as { token?: string; accessUrl?: string };
  // 回退链（建议网卡 > 回环）必须兜住：没有基址也要给出可扫的链接，
  // 否则手机弹窗只能反复要求「重新生成」。
  assert.match(savedBody.accessUrl ?? "", /^http:\/\/.+\/#token=.+&device=test-host$/);
  assert.ok(savedBody.accessUrl?.includes(`#token=${savedBody.token}&device=test-host`));
});

test("代理识别：携带 CF 头的请求不能当作 loopback（写接口防绕过）", () => {
  assert.equal(isProxiedRequest({ "cf-connecting-ip": "203.0.113.9" }), true);
  assert.equal(isProxiedRequest({ "cf-ray": "abc-ARN" }), true);
  assert.equal(isProxiedRequest({ "x-forwarded-for": "198.51.100.7" }), true);
  assert.equal(isProxiedRequest({ host: "127.0.0.1:30330" }), false);
  assert.equal(
    resolveAuthFailureKey({ "cf-connecting-ip": "203.0.113.9" }, "127.0.0.1"),
    "203.0.113.9",
  );
  assert.equal(resolveAuthFailureKey({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }, "127.0.0.1"), "198.51.100.7");
  assert.equal(resolveAuthFailureKey({}, "192.168.1.5"), "192.168.1.5");
});

test("token 档：经 Cloudflare/反代转发的写接口一律 403（remoteAddress 是回环也不能放行）", async () => {
  const initial = generateWebAccessToken();
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: initial.tokenHash, tokenPrefix: initial.tokenPrefix }),
  );
  isolateConfigDir(fixture.baseDir);
  await seedConfigFile(
    fixture.baseDir,
    makeConfig({ mode: "token", tokenHash: initial.tokenHash, tokenPrefix: initial.tokenPrefix }),
  );
  onTestFinished(async () => {
    await rm(fixture.baseDir, { recursive: true, force: true });
  });

  const proxiedWrite = await httpPut(
    fixture.port,
    "/api/web-access/config",
    JSON.stringify({ mode: "token", externalBaseUrl: "" }),
    {
      Authorization: `Bearer ${initial.token}`,
      "X-Zcode-Device": TEST_DEVICE,
      "CF-Connecting-IP": "203.0.113.9",
    },
  );
  assert.equal(proxiedWrite.status, 403);

  // 读接口仍允许远程凭据访问（token 档远程只读语义不因隧道改变）。
  const proxiedRead = await httpGet(fixture.port, "/api/web-access/config", {
    Authorization: `Bearer ${initial.token}`,
    "X-Zcode-Device": TEST_DEVICE,
    "CF-Connecting-IP": "203.0.113.9",
  });
  assert.equal(proxiedRead.status, 200);
});

test("失败限流：同一客户端 10 次 401 后返回 429，其他客户端不受影响", async () => {
  const initial = generateWebAccessToken();
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: initial.tokenHash, tokenPrefix: initial.tokenPrefix }),
  );
  const statuses: Array<number | undefined> = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await httpGet(fixture.port, "/api/web-access/config", {
      "CF-Connecting-IP": "203.0.113.9",
    });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);

  const otherClient = await httpGet(fixture.port, "/api/web-access/config", {
    "CF-Connecting-IP": "198.51.100.7",
  });
  assert.equal(otherClient.status, 401);
});

test("AuthFailureLimiter：窗口滑动后解除封禁，reset 立即解除", () => {
  let now = 0;
  const limiter = new AuthFailureLimiter({ maxFailures: 2, windowMs: 1_000, now: () => now });
  limiter.noteFailure("k");
  assert.equal(limiter.isBlocked("k"), false);
  limiter.noteFailure("k");
  assert.equal(limiter.isBlocked("k"), true);
  now += 1_001;
  assert.equal(limiter.isBlocked("k"), false);

  limiter.noteFailure("k");
  limiter.noteFailure("k");
  limiter.reset("k");
  assert.equal(limiter.isBlocked("k"), false);
});
