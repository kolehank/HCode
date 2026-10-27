import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { test } from "vitest";
import type { QuickTunnelStatus } from "@zcode/shared";
import {
  buildQuickTunnelArgs,
  cleanupOrphanQuickTunnel,
  extractQuickTunnelUrl,
  QuickTunnelSupervisor,
  redactTunnelDiagnostic,
} from "../src/main/webRemoteAccess/quickTunnelProcess.js";

interface FakeTimers {
  setTimeoutFn: (callback: () => void, ms: number) => number;
  clearTimeoutFn: (handle: number) => void;
  pendingDelays: () => number[];
  runNext: () => number | undefined;
}

function createFakeTimers(): FakeTimers {
  let nextId = 1;
  let tasks: Array<{ id: number; callback: () => void; delay: number }> = [];
  return {
    setTimeoutFn: (callback, delay) => {
      const id = nextId++;
      tasks.push({ id, callback, delay });
      return id;
    },
    clearTimeoutFn: (handle) => {
      tasks = tasks.filter((task) => task.id !== handle);
    },
    pendingDelays: () => tasks.map((task) => task.delay),
    runNext: () => {
      const task = tasks.shift();
      task?.callback();
      return task?.delay;
    },
  };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}

function createHarness(
  options: {
    retryDelaysMs?: number[];
    startupTimeoutMs?: number;
    pidFilePath?: string;
    orphanDeps?: Parameters<typeof cleanupOrphanQuickTunnel>[1];
    fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
) {
  const timers = createFakeTimers();
  const children: FakeChild[] = [];
  const spawnArgs: string[][] = [];
  const statuses: QuickTunnelStatus[] = [];
  const terminated: FakeChild[] = [];
  let now = 0;
  const supervisor = new QuickTunnelSupervisor({
    spawnProcess: (_command, args) => {
      spawnArgs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    terminateProcess: async (child) => {
      terminated.push(child as unknown as FakeChild);
      child.kill();
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => now,
    startupTimeoutMs: options.startupTimeoutMs ?? 25_000,
    retryDelaysMs: options.retryDelaysMs ?? [1_000, 2_000],
    onStatus: (status) => statuses.push(status),
    // 探测不触网：状态机的可达性分支由独立用例覆盖。
    fetchFn: options.fetchFn ?? (async () => new Response("ok", { status: 200 })),
    sleep: async () => {},
    probeDelaysMs: [0, 0],
    ...(options.pidFilePath
      ? { pidFilePath: options.pidFilePath, orphanDeps: options.orphanDeps }
      : {}),
  });
  return {
    supervisor,
    timers,
    children,
    spawnArgs,
    statuses,
    terminated,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("参数固定带 --no-autoupdate；http2 回退时追加 --protocol http2", () => {
  assert.deepEqual(buildQuickTunnelArgs(30330), [
    "tunnel",
    "--url",
    "http://127.0.0.1:30330",
    "--no-autoupdate",
  ]);
  assert.deepEqual(buildQuickTunnelArgs(30330, "http2"), [
    "tunnel",
    "--url",
    "http://127.0.0.1:30330",
    "--no-autoupdate",
    "--protocol",
    "http2",
  ]);
});

test("从 stderr 行提取 quick tunnel URL（大小写不敏感、跨 chunk 拼接）", () => {
  assert.equal(
    extractQuickTunnelUrl("https://brave-river-1234.trycloudflare.com"),
    "https://brave-river-1234.trycloudflare.com",
  );
  assert.equal(
    extractQuickTunnelUrl("Your quick Tunnel has been created! Visit it at:"),
    undefined,
  );
  assert.equal(extractQuickTunnelUrl("https://example.com"), undefined);
});

test("错误摘要脱敏 URL 并截断", () => {
  const detail = redactTunnelDiagnostic(
    "failed to dial https://brave-river-1234.trycloudflare.com   please retry",
  );
  assert.equal(detail, "failed to dial <url> please retry");
  assert.ok(redactTunnelDiagnostic("x".repeat(1_000)).length <= 400);
});

test("启动后解析到 URL：starting → running，进程参数与端口正确", async () => {
  const harness = createHarness();
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  assert.equal(harness.statuses[0]?.state, "starting");
  assert.equal(harness.children.length, 1);
  assert.deepEqual(harness.spawnArgs[0], [
    "tunnel",
    "--url",
    "http://127.0.0.1:30330",
    "--no-autoupdate",
  ]);

  harness.children[0]!.stderr.write(
    "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\n",
  );
  harness.children[0]!.stderr.write("https://brave-river-1234.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));

  const running = harness.statuses.find((status) => status.state === "running");
  assert.equal(running?.publicUrl, "https://brave-river-1234.trycloudflare.com");
  assert.equal(running?.transport, "auto");
  assert.deepEqual(harness.timers.pendingDelays(), []);
});

test("URL 解析后后台探测：可达时标记 reachable=true", async () => {
  let probed: string | undefined;
  const harness = createHarness({
    fetchFn: async (url) => {
      probed = url;
      return new Response("ok", { status: 200 });
    },
  });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.children[0]!.stderr.write("https://probe-me.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(probed, "https://probe-me.trycloudflare.com");
  assert.equal(harness.statuses.at(-1)?.state, "running");
  assert.equal(harness.statuses.at(-1)?.reachable, true);
});

test("URL 解析后后台探测：持续失败只标记 reachable=false，状态保持 running", async () => {
  const harness = createHarness({
    fetchFn: async () => {
      throw new Error("dns not ready");
    },
  });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.children[0]!.stderr.write("https://not-ready.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.statuses.at(-1)?.state, "running");
  assert.equal(harness.statuses.at(-1)?.reachable, false);
});

test("首次启动失败后强制 http2 重试", async () => {
  const harness = createHarness({ startupTimeoutMs: 50, retryDelaysMs: [10] });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.timers.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  harness.timers.runNext();

  assert.equal(harness.spawnArgs.length, 2);
  assert.deepEqual(harness.spawnArgs[1], [
    "tunnel",
    "--url",
    "http://127.0.0.1:30330",
    "--no-autoupdate",
    "--protocol",
    "http2",
  ]);
  assert.equal(harness.statuses.at(-1)?.transport, "http2");
});

test("运行中进程退出：按退避重试并重新拉起，URL 变化后以新地址为准", async () => {
  const harness = createHarness({ retryDelaysMs: [1_000, 2_000] });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.children[0]!.stderr.write("https://first-abc.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));

  harness.children[0]!.emit("exit", 1, null);
  assert.equal(harness.statuses.at(-1)?.state, "starting");
  assert.deepEqual(harness.timers.pendingDelays(), [1_000]);

  harness.timers.runNext();
  assert.equal(harness.children.length, 2);
  // 曾经成功运行说明 QUIC 可用：崩溃重试不降级到 http2。
  assert.ok(!harness.spawnArgs[1]!.includes("--protocol"));
  harness.children[1]!.stderr.write("https://second-xyz.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.statuses.filter((status) => status.state === "running").at(-1)?.publicUrl,
    "https://second-xyz.trycloudflare.com",
  );
});

test("连续失败 5 次进入 error(crashed)，不再安排重试", async () => {
  const harness = createHarness({ retryDelaysMs: [1] });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    harness.children[attempt]!.emit("exit", 1, null);
    if (attempt < 4) {
      harness.timers.runNext();
    }
  }
  assert.equal(harness.statuses.at(-1)?.state, "error");
  assert.equal(harness.statuses.at(-1)?.errorCode, "crashed");
  assert.deepEqual(harness.timers.pendingDelays(), []);
});

test("启动超时：终止本次进程并按退避重试，不重复计数", async () => {
  const harness = createHarness({ startupTimeoutMs: 50, retryDelaysMs: [10] });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.timers.runNext();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.terminated.length, 1);
  assert.equal(harness.statuses.at(-1)?.state, "starting");
  assert.deepEqual(harness.timers.pendingDelays(), [10]);

  harness.timers.runNext();
  assert.equal(harness.children.length, 2);
});

test("stop 终止运行中的进程并回到 idle", async () => {
  const harness = createHarness();
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.children[0]!.stderr.write("https://alive-abc.trycloudflare.com\n");
  await new Promise((resolve) => setImmediate(resolve));
  await harness.supervisor.stop();

  assert.equal(harness.terminated.length, 1);
  assert.equal(harness.supervisor.getStatus().state, "idle");
  assert.deepEqual(harness.timers.pendingDelays(), []);
});

test("stop 清理未执行的退避重试，不再拉起新进程", async () => {
  const harness = createHarness({ retryDelaysMs: [1_000] });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  harness.children[0]!.emit("exit", 1, null);
  assert.deepEqual(harness.timers.pendingDelays(), [1_000]);

  await harness.supervisor.stop();
  assert.equal(harness.supervisor.getStatus().state, "idle");
  assert.deepEqual(harness.timers.pendingDelays(), []);
  assert.equal(harness.children.length, 1);
});

test("pid 文件：启动写入、停止删除，并在下次启动前清理孤儿进程", async () => {
  const files = new Map<string, string>();
  const terminatedPids: number[] = [];
  const orphanDeps = {
    readTextFile: async (path: string) => files.get(path),
    writeTextFile: async (path: string, data: string) => {
      files.set(path, data);
    },
    removeFile: async (path: string) => {
      files.delete(path);
    },
    isCloudflaredProcess: async () => true,
    terminatePid: async (pid: number) => {
      terminatedPids.push(pid);
    },
  };
  const pidFilePath = "/tmp/zcode-quick-tunnel.json";
  files.set(pidFilePath, JSON.stringify({ pid: 999, startedAt: 1 }));

  const harness = createHarness({ pidFilePath, orphanDeps });
  await harness.supervisor.start("/usr/bin/cloudflared", 30330);
  await new Promise((resolve) => setImmediate(resolve));

  // 上次残留的 999 被清理；新进程 pid 写入文件。
  assert.deepEqual(terminatedPids, [999]);
  assert.equal(JSON.parse(files.get(pidFilePath) ?? "{}").pid, 4242);

  await harness.supervisor.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(files.has(pidFilePath), false);
});

test("孤儿清理：进程名不匹配（PID 复用）时不杀进程，只删除文件", async () => {
  const removed: string[] = [];
  const terminatedPids: number[] = [];
  const killed = await cleanupOrphanQuickTunnel("/tmp/pid.json", {
    readTextFile: async () => JSON.stringify({ pid: 123 }),
    removeFile: async (path) => {
      removed.push(path);
    },
    isCloudflaredProcess: async () => false,
    terminatePid: async (pid) => {
      terminatedPids.push(pid);
    },
  });
  assert.equal(killed, false);
  assert.deepEqual(terminatedPids, []);
  assert.deepEqual(removed, ["/tmp/pid.json"]);
});

test("孤儿清理：损坏文件只删除、不杀任何进程", async () => {
  let terminated = false;
  const killed = await cleanupOrphanQuickTunnel("/tmp/pid.json", {
    readTextFile: async () => "not-json",
    removeFile: async () => {},
    isCloudflaredProcess: async () => true,
    terminatePid: async () => {
      terminated = true;
    },
  });
  assert.equal(killed, false);
  assert.equal(terminated, false);
});

test("孤儿清理：文件不存在时直接返回 false", async () => {
  const killed = await cleanupOrphanQuickTunnel("/tmp/missing.json", {
    readTextFile: async () => undefined,
    removeFile: async () => {
      throw new Error("should not remove");
    },
  });
  assert.equal(killed, false);
});
