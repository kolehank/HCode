import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createWebAccessMiddleware } from "../src/webAccess/webAccessMiddleware.js";
import {
  getDefaultWebAccessConfig,
  sha256Hex,
  tokenMatchesHash,
} from "../src/webAccess/webAccessConfig.js";

function appWith(config: ReturnType<typeof getDefaultWebAccessConfig>): Hono {
  const app = new Hono();
  app.use("*", createWebAccessMiddleware(config));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.text("root"));
  return app;
}

const loopbackEnv = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("BYOK P3 web access tiers", () => {
  it("open 档：本机 host 放行，Origin 指向非本机 host 被拒（rebinding 防线）", async () => {
    const app = appWith(getDefaultWebAccessConfig());
    // open 档 Host 必须回环；不带 host 头时 Hono 从 URL 推导 localhost。
    const ok = await app.request(
      "/api/ping",
      { headers: { host: "localhost:3030", origin: "http://localhost:3030" } },
      loopbackEnv,
    );
    expect(ok.status).toBe(200);
    const rebinding = await app.request(
      "/api/ping",
      { headers: { origin: "http://evil.example", host: "evil.example" } },
      loopbackEnv,
    );
    expect(rebinding.status).toBe(403);
  });

  it("token 档：Bearer 匹配 SHA-256 哈希放行；缺失/错误 token 拒 401", async () => {
    const token = "test-token-0123456789abcdef";
    const config = {
      ...getDefaultWebAccessConfig(),
      mode: "token" as const,
      tokenHash: sha256Hex(token),
      tokenPrefix: token.slice(0, 8),
    };
    expect(tokenMatchesHash(token, config.tokenHash)).toBe(true);
    const app = appWith(config);
    const ok = await app.request("/api/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const missing = await app.request("/api/ping", {});
    expect(missing.status).toBe(401);
    const wrong = await app.request("/api/ping", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("cloudflare-access 档：无 Cf-Access-Jwt-Assertion 头直接 401", async () => {
    const config = {
      ...getDefaultWebAccessConfig(),
      mode: "cloudflare-access" as const,
      cfTeamDomain: "test.team.cloudflareaccess.com",
      cfAud: "test-aud",
    };
    const app = appWith(config);
    const missing = await app.request("/api/ping", {});
    expect(missing.status).toBe(401);
  });
});
