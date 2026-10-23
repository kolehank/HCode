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
  startWebRemoteAccessHttpServer,
  type WebRemoteAccessHttpServerHandle,
} from "../src/main/webRemoteAccess/webRemoteAccessHttpServer.js";

interface TestFixture {
  handle: WebRemoteAccessHttpServerHandle;
  port: number;
  staticDir: string;
  baseDir: string;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeConfig(overrides: Partial<WebAccessConfig>): WebAccessConfig {
  return { ...getDefaultWebAccessConfig(), ...overrides };
}

async function startFixture(
  config: WebAccessConfig,
  onClientConnected: (ws: import("ws").WebSocket) => void = () => {},
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
    onClientConnected,
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

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{
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
  const fixture = await startFixture(
    makeConfig({ mode: "token", tokenHash: generated.tokenHash }),
  );
  onTestFinished(() => fixture.handle.stop());
  const noToken = await rawUpgrade(fixture.port, "/ws", {});
  assert.equal(noToken.status, 401);
  const withToken = await rawUpgrade(fixture.port, `/ws?token=${generated.token}`, {
    host: `127.0.0.1:${fixture.port}`,
  });
  assert.equal(withToken.upgraded, true);
  // token 不豁免来源校验：浏览器侧防线独立于凭据。
  const tokenCrossOrigin = await rawUpgrade(fixture.port, `/ws?token=${generated.token}`, {
    host: `127.0.0.1:${fixture.port}`,
    origin: "http://evil.com",
  });
  assert.equal(tokenCrossOrigin.status, 403);
  // HTTP 侧：无 token 的 /api/* 请求 401。
  const apiNoToken = await httpGet(fixture.port, "/api/anything");
  assert.equal(apiNoToken.status, 401);
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
    assert.ok(
      !result.body.includes("TOPSECRET"),
      `穿越尝试不应读到静态根之外的文件: ${attempt}`,
    );
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
