import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isAllowedWsOrigin,
  isEmailAllowlisted,
  isLoopbackWsHostHeader,
} from "@zcode/server";

test("isLoopbackWsHostHeader：open 档 Host 必须是回环 hostname（端口任意，IPv6 带括号）", () => {
  assert.equal(isLoopbackWsHostHeader("127.0.0.1:30330"), true);
  assert.equal(isLoopbackWsHostHeader("localhost:8080"), true);
  assert.equal(isLoopbackWsHostHeader("127.0.0.1"), true);
  assert.equal(isLoopbackWsHostHeader("[::1]:30330"), true);
  assert.equal(isLoopbackWsHostHeader("[::1]"), true);
  // DNS rebinding 特征：非回环域名/IP 一律拒绝。
  assert.equal(isLoopbackWsHostHeader("evil.com"), false);
  assert.equal(isLoopbackWsHostHeader("192.168.1.5:30330"), false);
  assert.equal(isLoopbackWsHostHeader("[::2]:1"), false);
  assert.equal(isLoopbackWsHostHeader(undefined), false);
  assert.equal(isLoopbackWsHostHeader(""), false);
  // 畸形括号不崩溃、不误放。
  assert.equal(isLoopbackWsHostHeader("[::1"), false);
});

test("isAllowedWsOrigin：Origin 缺失放行（非浏览器），同源与 externalBaseUrl 放行", () => {
  // curl/脚本等非浏览器客户端不带 Origin：放行（token/CF 档仍需凭据）。
  assert.equal(isAllowedWsOrigin(undefined, "127.0.0.1:30330", undefined), true);
  // 同源：与请求 Host 一致。
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:30330", "127.0.0.1:30330", undefined), true);
  assert.equal(
    isAllowedWsOrigin("https://remote.example.com", "remote.example.com", undefined),
    true,
  );
  // externalBaseUrl 源（CF 档 / 托管形态的合法页面源）。
  assert.equal(
    isAllowedWsOrigin(
      "https://team.cloudflareaccess.com",
      "127.0.0.1:30330",
      "https://team.cloudflareaccess.com/ui",
    ),
    true,
  );
});

test("isAllowedWsOrigin：跨源、伪造源、畸形源拒绝", () => {
  // 恶意网页的 Origin 与请求 Host 不同源 → 拒绝（CSWSH 主防线）。
  assert.equal(isAllowedWsOrigin("http://evil.com", "127.0.0.1:30330", undefined), false);
  // 端口不同也不同源：本机另一端口上的页面不得桥接。
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:9999", "127.0.0.1:30330", undefined), false);
  // file:// 页面的 Origin 是 "null"。
  assert.equal(isAllowedWsOrigin("null", "127.0.0.1:30330", undefined), false);
  // 非 http(s) 协议。
  assert.equal(isAllowedWsOrigin("chrome-extension://abc", "127.0.0.1:30330", undefined), false);
  // 畸形 Origin。
  assert.equal(isAllowedWsOrigin("not-a-url", "127.0.0.1:30330", undefined), false);
  // Host 缺失时无法做同源判定，带 Origin 一律拒绝。
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:30330", undefined, undefined), false);
  // externalBaseUrl 配置损坏时不放行外部源。
  assert.equal(
    isAllowedWsOrigin("http://evil.com", "127.0.0.1:30330", "::not a url::"),
    false,
  );
});

test("isEmailAllowlisted：空候选跳过，空 email claim 不因空串候选被放行", () => {
  // 回归：allowlist 混入 "" 曾把「无 email claim 的合法 JWT」（email 视为 ""）放行。
  assert.equal(isEmailAllowlisted(undefined, [""]), false);
  assert.equal(isEmailAllowlisted("", [""]), false);
  assert.equal(isEmailAllowlisted(undefined, ["a@b.com"]), false);
  assert.equal(isEmailAllowlisted("a@B.com", [" A@b.com ", ""]), true);
  assert.equal(isEmailAllowlisted("c@d.com", ["a@b.com", ""]), false);
});
