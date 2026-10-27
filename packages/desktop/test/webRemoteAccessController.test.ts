import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test, vi } from "vitest";
import type { QuickTunnelStatus } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";

// controller 会导入 electron 适配层：只保留构造期用到的导出，避免真实 electron 运行时。
vi.mock("electron", () => ({ MessageChannelMain: class {} }));
vi.mock("../src/main/webRemoteAccess/server.js", () => ({
  startWebRemoteAccessServer: vi.fn(async () => ({
    port: 30330,
    stop: async () => {},
  })),
}));
// 通道二进制固定为「未安装」，用于断言 binary-missing 状态与 token 档强制规则。
vi.mock("../src/main/webRemoteAccess/cloudflaredDiscovery.js", () => ({
  detectCloudflared: vi.fn(async () => ({ available: false })),
}));

const { WebRemoteAccessController } = await import(
  "../src/main/webRemoteAccess/controller.js"
);

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function createController() {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-controller-test-"));
  setDataBaseDir(baseDir);
  onTestFinished(() => setDataBaseDir(null));
  const statuses: QuickTunnelStatus[] = [];
  const controller = new WebRemoteAccessController({
    logger: noopLogger,
    getHostChild: () => undefined,
    getWebStaticDir: () => undefined,
    onTunnelStatusChanged: (status) => statuses.push(status),
  });
  onTestFinished(async () => {
    await controller.stop();
    await rm(baseDir, { recursive: true, force: true });
  });
  return { controller, statuses, baseDir };
}

test("quickTunnel 与 open 档组合被归一化为 false（不允许无 token 的公网暴露）", async () => {
  const { controller } = await createController();
  const result = await controller.applyUpdate({
    mode: "open",
    desktopEnabled: true,
    quickTunnelEnabled: true,
  });
  assert.equal(result.status.quickTunnelEnabled, false);
  assert.equal(result.status.tunnel.state, "disabled");

  const { loadWebAccessConfig } = await import("@zcode/server");
  const persisted = await loadWebAccessConfig();
  assert.equal(persisted.quickTunnelEnabled, false);
});

test("token 档开启通道：缺少 cloudflared 时进入 binary-missing 并推送状态", async () => {
  const { controller, statuses } = await createController();
  const result = await controller.applyUpdate({
    mode: "token",
    desktopEnabled: true,
    quickTunnelEnabled: true,
  });

  assert.equal(result.status.quickTunnelEnabled, true);
  assert.equal(result.status.mode, "token");
  assert.equal(result.status.tunnel.state, "error");
  assert.equal(result.status.tunnel.errorCode, "binary-missing");
  assert.ok(statuses.some((status) => status.errorCode === "binary-missing"));
  // 明文 token 与通道状态分离：save 响应仍能给出一次性 token 与设备标识。
  assert.ok(result.token);
  assert.match(result.accessUrl ?? "", /#token=.+&device=/);
});

test("关闭通道后状态回到 disabled/idle，不再尝试启动", async () => {
  const { controller } = await createController();
  await controller.applyUpdate({ mode: "token", desktopEnabled: true, quickTunnelEnabled: true });
  const result = await controller.applyUpdate({
    mode: "token",
    desktopEnabled: true,
    quickTunnelEnabled: false,
  });
  assert.equal(result.status.quickTunnelEnabled, false);
  assert.equal(result.status.tunnel.state, "disabled");
});
