import assert from "node:assert/strict";
import { test } from "vitest";
import {
  detectCloudflared,
  listCloudflaredCandidates,
  parseCloudflaredVersion,
} from "../src/main/webRemoteAccess/cloudflaredDiscovery.js";

test("候选顺序：ZCODE_CLOUDFLARED_PATH > PATH > 平台常见路径，且去重", () => {
  const candidates = listCloudflaredCandidates({
    platform: "linux",
    env: {
      ZCODE_CLOUDFLARED_PATH: "/custom/cloudflared",
      PATH: "/usr/bin:/custom",
    } as NodeJS.ProcessEnv,
  });
  assert.equal(candidates[0], "/custom/cloudflared");
  assert.ok(candidates.includes("/usr/bin/cloudflared"));
  assert.ok(candidates.includes("/usr/local/bin/cloudflared"));
  assert.equal(new Set(candidates).size, candidates.length);
});

test("Windows 同时尝试 cloudflared.exe 与无扩展名", () => {
  const candidates = listCloudflaredCandidates({
    platform: "win32",
    env: { PATH: "C:\\Tools" } as NodeJS.ProcessEnv,
  });
  assert.ok(candidates.includes("C:\\Tools\\cloudflared.exe"));
  assert.ok(candidates.includes("C:\\Tools\\cloudflared"));
});

test("版本输出解析", () => {
  assert.equal(
    parseCloudflaredVersion("cloudflared version 2025.8.1 (built 2025-08-01)"),
    "2025.8.1",
  );
  assert.equal(parseCloudflaredVersion("garbage"), undefined);
});

test("检测：跳过不可执行候选，返回首个可执行且版本可读的路径", async () => {
  const checked: string[] = [];
  const detection = await detectCloudflared({
    platform: "linux",
    env: { PATH: "/a:/b" } as NodeJS.ProcessEnv,
    isExecutable: async (path) => {
      checked.push(path);
      return path === "/b/cloudflared";
    },
    runVersion: async () => "cloudflared version 2025.2.0",
  });
  assert.equal(detection.available, true);
  assert.equal(detection.path, "/b/cloudflared");
  assert.equal(detection.version, "2025.2.0");
  assert.deepEqual(checked, ["/a/cloudflared", "/b/cloudflared"]);
});

test("检测：文件存在但 --version 失败视为不可用（损坏二进制比缺失更危险）", async () => {
  const detection = await detectCloudflared({
    platform: "linux",
    env: { PATH: "/broken" } as NodeJS.ProcessEnv,
    isExecutable: async () => true,
    runVersion: async () => undefined,
  });
  assert.equal(detection.available, false);
});

test("检测：全部候选不可执行时返回 available:false", async () => {
  const detection = await detectCloudflared({
    platform: "darwin",
    env: { PATH: "" } as NodeJS.ProcessEnv,
    isExecutable: async () => false,
    runVersion: async () => "cloudflared version 1.0.0",
  });
  assert.equal(detection.available, false);
});
