// BYOK A2：临时公网通道子进程托管（Cloudflare Quick Tunnel）。
// 纯 node 实现（electron 仅由调用方注入），便于用假 spawn 做状态机与退避单测。
// 语义见 docs/specs/web-remote-access.md「公网临时通道」节：
//   - 参数固定带 --no-autoupdate（自动更新会重启进程、换掉 URL）；
//   - 首次用默认传输（QUIC，auto），失败后强制 --protocol http2 重试（国内 UDP 质量差时必需）；
//   - URL 从 stderr 的 https://<随机>.trycloudflare.com 解析，仅存内存；
//   - URL 出现后做后台可达性探测（DNS/边缘传播有延迟，探测失败不改变 running 状态）；
//   - 崩溃按 1/2/4/8/16s 退避，5 分钟窗口最多 5 次，超限进入 error(crashed)；
//   - pid 文件只用于清理上次异常退出残留的 cloudflared（单实例应用，避免 PID 复用误杀）。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { terminateProcessTreeAndWait } from "@zcode/services/process/processTreeTerminator";
import type { QuickTunnelStatus } from "@zcode/shared";

const DEFAULT_STARTUP_TIMEOUT_MS = 25_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const DEFAULT_PROBE_DELAYS_MS = [3_000, 5_000] as const;
const DEFAULT_CRASH_WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const DIAGNOSTIC_TAIL_LINES = 3;
const DIAGNOSTIC_MAX_LENGTH = 400;
const PROBE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 2_000;

export type QuickTunnelTransport = "auto" | "http2";

const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function buildQuickTunnelArgs(
  port: number,
  transport: QuickTunnelTransport = "auto",
): string[] {
  return [
    "tunnel",
    "--url",
    `http://127.0.0.1:${port}`,
    "--no-autoupdate",
    ...(transport === "http2" ? ["--protocol", "http2"] : []),
  ];
}

/** 从一行日志中提取 quick tunnel URL；大小写不敏感，带尾部标点时截到域名结尾。 */
export function extractQuickTunnelUrl(line: string): string | undefined {
  const match = line.match(QUICK_TUNNEL_URL_PATTERN);
  return match?.[0];
}

/** 错误摘要只保留可读片段：URL 与 token 一律脱敏，避免把公开地址写进日志/UI 错误。 */
export function redactTunnelDiagnostic(line: string): string {
  return line
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DIAGNOSTIC_MAX_LENGTH);
}

export interface QuickTunnelLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// 孤儿进程清理（上次 app 崩溃时 cloudflared 可能仍存活）
// ---------------------------------------------------------------------------

export interface OrphanTunnelDeps {
  readTextFile?: (path: string) => Promise<string | undefined>;
  writeTextFile?: (path: string, data: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  isCloudflaredProcess?: (pid: number) => Promise<boolean>;
  terminatePid?: (pid: number) => Promise<void>;
  logger?: QuickTunnelLogger;
}

async function defaultReadTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function defaultWriteTextFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: "utf-8", mode: 0o600 });
}

async function defaultRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function runCommand(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : String(stdout).trim()),
    );
  });
}

/** 只认 cloudflared：PID 可能被系统复用，命令名不匹配时绝不杀进程。 */
async function defaultIsCloudflaredProcess(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    const output = await runCommand("tasklist", [
      "/FI",
      `PID eq ${pid}`,
      "/FO",
      "CSV",
      "/NH",
    ]);
    return Boolean(output && /cloudflared/i.test(output));
  }
  const output = await runCommand("ps", ["-p", String(pid), "-o", "comm="]);
  return Boolean(output && /cloudflared/i.test(output));
}

async function defaultTerminatePid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 进程已退出（ESRCH）或权限不足：交给下一次退避/用户手动处理。
  }
}

/**
 * 读取上次写入的 pid 文件，确认目标仍是 cloudflared 后终止并清理文件。
 * 返回是否真的杀掉了进程；文件损坏/进程已退出也会删除文件。
 */
export async function cleanupOrphanQuickTunnel(
  pidFilePath: string,
  deps: OrphanTunnelDeps = {},
): Promise<boolean> {
  const read = deps.readTextFile ?? defaultReadTextFile;
  const remove = deps.removeFile ?? defaultRemoveFile;
  const raw = await read(pidFilePath);
  if (!raw) {
    return false;
  }
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      pid = parsed.pid;
    }
  } catch {
    // 损坏的 pid 文件只清理，不据此杀任何进程。
  }
  let killed = false;
  if (pid !== undefined) {
    const isCloudflared = deps.isCloudflaredProcess ?? defaultIsCloudflaredProcess;
    const terminate = deps.terminatePid ?? defaultTerminatePid;
    if (await isCloudflared(pid).catch(() => false)) {
      await terminate(pid).catch(() => undefined);
      killed = true;
      deps.logger?.warn("[quick-tunnel] terminated orphan cloudflared from previous session");
    }
  }
  await remove(pidFilePath).catch(() => undefined);
  return killed;
}

// ---------------------------------------------------------------------------
// 子进程状态机
// ---------------------------------------------------------------------------

export interface QuickTunnelSupervisorOptions {
  onStatus?: (status: QuickTunnelStatus) => void;
  logger?: QuickTunnelLogger;
  /** 注入点（单测）：默认 spawn + 进程树终止。 */
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  terminateProcess?: (child: ChildProcess) => Promise<void>;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  now?: () => number;
  startupTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  crashWindowMs?: number;
  /** pid 文件路径：提供后用于记录当前进程并在下次启动时清理孤儿。 */
  pidFilePath?: string;
  orphanDeps?: OrphanTunnelDeps;
  /** 可达性探测注入点（单测）。 */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  probeDelaysMs?: readonly number[];
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, {
    // POSIX 独立进程组便于整组终止；Windows 交给 taskkill /T。
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function defaultTerminate(child: ChildProcess): Promise<void> {
  await terminateProcessTreeAndWait(child, {
    forceAfterMs: 1_000,
    waitAfterForceMs: 250,
    windowsTaskkillTimeoutMs: 1_500,
  }).catch(() => undefined);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单实例托管：start 只负责拉起（不等待 URL），URL/失败/退避/可达性都通过 onStatus 通知；
 * stop 必须先于 listener 停止调用，保证进程树被清理。
 */
export class QuickTunnelSupervisor {
  readonly #onStatus: ((status: QuickTunnelStatus) => void) | undefined;
  readonly #logger: QuickTunnelLogger | undefined;
  readonly #spawnProcess: (command: string, args: string[]) => ChildProcess;
  readonly #terminateProcess: (child: ChildProcess) => Promise<void>;
  readonly #setTimeout: (callback: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #now: () => number;
  readonly #startupTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #crashWindowMs: number;
  readonly #pidFilePath: string | undefined;
  readonly #orphanDeps: OrphanTunnelDeps;
  readonly #fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #probeDelaysMs: readonly number[];

  #binaryPath = "";
  #port = 0;
  #child: ChildProcess | null = null;
  #status: QuickTunnelStatus = { state: "disabled" };
  #stopping = false;
  #transport: QuickTunnelTransport = "auto";
  #lineBuffer = "";
  #recentDiagnostics: string[] = [];
  #startupTimer: unknown = null;
  #retryTimer: unknown = null;
  #attemptTimestamps: number[] = [];
  #generation = 0;

  constructor(options: QuickTunnelSupervisorOptions = {}) {
    this.#onStatus = options.onStatus;
    this.#logger = options.logger;
    this.#spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.#terminateProcess = options.terminateProcess ?? defaultTerminate;
    this.#setTimeout = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
    this.#now = options.now ?? Date.now;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.#pidFilePath = options.pidFilePath;
    this.#orphanDeps = options.orphanDeps ?? {};
    this.#fetchFn =
      options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    this.#sleep = options.sleep ?? defaultSleep;
    this.#probeDelaysMs = options.probeDelaysMs ?? DEFAULT_PROBE_DELAYS_MS;
  }

  get port(): number {
    return this.#port;
  }

  getStatus(): QuickTunnelStatus {
    return { ...this.#status };
  }

  /** 拉起通道（不等待 URL）；重复调用会先停止旧进程。 */
  async start(binaryPath: string, port: number): Promise<void> {
    // 只有「没有活着的子进程」时才可能是上个会话的残留：先清理再 stop，
    // 否则 stop 会先删掉 pid 文件，孤儿进程就永远清不掉了。
    // 同会话内重启时 #child 非空，交给 stop 正常终止，绝不能按 pid 文件再杀一遍。
    if (!this.#child && this.#pidFilePath) {
      await cleanupOrphanQuickTunnel(this.#pidFilePath, {
        ...this.#orphanDeps,
        ...(this.#logger ? { logger: this.#logger } : {}),
      }).catch(() => false);
    }
    await this.stop();
    this.#stopping = false;
    this.#binaryPath = binaryPath;
    this.#port = port;
    this.#transport = "auto";
    this.#attemptTimestamps = [];
    this.#launch();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#generation += 1;
    if (this.#startupTimer !== null) {
      this.#clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
    }
    if (this.#retryTimer !== null) {
      this.#clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const child = this.#child;
    this.#child = null;
    this.#lineBuffer = "";
    if (child) {
      await this.#terminateProcess(child).catch(() => undefined);
    }
    this.#clearPidFile();
    if (this.#status.state !== "disabled") {
      this.#emit({ state: "idle" });
    }
  }

  /** 仅用于异常恢复：清空退避预算后重新拉起。 */
  async restart(): Promise<void> {
    if (!this.#binaryPath) {
      return;
    }
    await this.start(this.#binaryPath, this.#port);
  }

  #launch(): void {
    const generation = ++this.#generation;
    this.#recentDiagnostics = [];
    this.#emit({ state: "starting", transport: this.#transport });
    let child: ChildProcess;
    try {
      child = this.#spawnProcess(
        this.#binaryPath,
        buildQuickTunnelArgs(this.#port, this.#transport),
      );
    } catch (error) {
      this.#failAttempt(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#child = child;
    this.#writePidFile(child.pid);
    child.stdout?.on("data", (chunk: Buffer) => this.#consume(chunk, generation));
    child.stderr?.on("data", (chunk: Buffer) => this.#consume(chunk, generation));
    child.once("error", (error) => {
      if (generation !== this.#generation || this.#stopping) {
        return;
      }
      this.#failAttempt(error.message);
    });
    child.once("exit", (code, signal) => {
      if (generation !== this.#generation || this.#stopping) {
        return;
      }
      const wasRunning = this.#status.state === "running";
      this.#failAttempt(
        wasRunning
          ? `通道进程退出 (code=${code ?? "null"}, signal=${signal ?? "null"})`
          : this.#diagnosticSummary() || `通道进程退出 (code=${code ?? "null"})`,
        // 曾经成功运行说明 QUIC 可用：崩溃重试沿用 auto，不无谓降级到 http2。
        { escalateTransport: !wasRunning },
      );
    });
    this.#startupTimer = this.#setTimeout(() => {
      this.#startupTimer = null;
      if (generation !== this.#generation || this.#stopping) {
        return;
      }
      const detail = this.#diagnosticSummary() || "启动超时，未获取到公网地址";
      // 先作废 generation 再终止：terminate 可能同步触发 exit，
      // 不能让同一次超时被 exit 处理重复计入退避预算。
      this.#generation += 1;
      this.#child = null;
      void this.#terminateProcess(child).catch(() => undefined);
      this.#failAttempt(detail);
    }, this.#startupTimeoutMs);
  }

  #consume(chunk: Buffer, generation: number): void {
    if (generation !== this.#generation) {
      return;
    }
    this.#lineBuffer += chunk.toString("utf-8");
    const lines = this.#lineBuffer.split(/\r?\n/);
    this.#lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const diagnostic = redactTunnelDiagnostic(trimmed);
    if (diagnostic) {
      this.#recentDiagnostics.push(diagnostic);
      this.#recentDiagnostics = this.#recentDiagnostics.slice(-DIAGNOSTIC_TAIL_LINES);
    }
    if (this.#status.state === "running") {
      return;
    }
    const url = extractQuickTunnelUrl(trimmed);
    if (!url) {
      return;
    }
    if (this.#startupTimer !== null) {
      this.#clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
    }
    // 成功运行后清空失败预算：下次异常崩溃重新从 1s 退避开始。
    this.#attemptTimestamps = [];
    this.#logger?.info(`[quick-tunnel] tunnel established transport=${this.#transport}`);
    const generation = this.#generation;
    this.#emit({ state: "running", publicUrl: url, transport: this.#transport });
    this.#startReachabilityProbe(url, generation);
  }

  /**
   * 后台探测公网地址是否已生效。Cloudflare 明确提示「打印的地址可能过几秒才可达」，
   * 所以探测失败只标记 reachable=false，不把 running 改成 error，避免误杀正常启动。
   */
  #startReachabilityProbe(url: string, generation: number): void {
    void (async () => {
      const attempts = this.#probeDelaysMs.length + 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!this.#probeStillCurrent(generation)) {
          return;
        }
        try {
          const response = await this.#fetchFn(url, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          void response.body?.cancel().catch(() => undefined);
          if (this.#probeStillCurrent(generation)) {
            this.#emit({ ...this.#status, reachable: true });
          }
          return;
        } catch {
          if (attempt < attempts - 1) {
            await this.#sleep(this.#probeDelaysMs[attempt] ?? 3_000);
          }
        }
      }
      if (this.#probeStillCurrent(generation)) {
        this.#logger?.warn("[quick-tunnel] public url not reachable yet");
        this.#emit({ ...this.#status, reachable: false });
      }
    })();
  }

  #probeStillCurrent(generation: number): boolean {
    return (
      !this.#stopping && generation === this.#generation && this.#status.state === "running"
    );
  }

  #diagnosticSummary(): string {
    return this.#recentDiagnostics.join(" | ");
  }

  /**
   * 记录一次失败并安排退避重试。
   * 进入即递增 generation：当前子进程的后续 exit/error 事件全部作废，
   * 避免「超时后 kill」把同一次失败重复计数、提前耗尽预算。
   * 首次失败后把传输协议切到 http2（QUIC/UDP 被限速时的常见解）。
   */
  #failAttempt(detail: string, options: { escalateTransport?: boolean } = {}): void {
    if (this.#stopping) {
      return;
    }
    this.#generation += 1;
    const generation = this.#generation;
    this.#child = null;
    this.#clearPidFile();
    if (this.#startupTimer !== null) {
      this.#clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
    }
    if (options.escalateTransport !== false && this.#transport === "auto") {
      this.#transport = "http2";
      this.#logger?.warn("[quick-tunnel] retrying over http2 (TCP 7844)");
    }
    const now = this.#now();
    this.#attemptTimestamps = this.#attemptTimestamps.filter(
      (timestamp) => now - timestamp <= this.#crashWindowMs,
    );
    this.#attemptTimestamps.push(now);
    const attempts = this.#attemptTimestamps.length;
    const safeDetail = redactTunnelDiagnostic(detail);
    if (attempts >= MAX_ATTEMPTS) {
      this.#logger?.error("[quick-tunnel] crash budget exhausted");
      this.#emit({
        state: "error",
        errorCode: "crashed",
        transport: this.#transport,
        ...(safeDetail ? { errorDetail: safeDetail } : {}),
      });
      return;
    }
    const delay =
      this.#retryDelaysMs[Math.min(attempts - 1, this.#retryDelaysMs.length - 1)] ?? 1_000;
    this.#logger?.warn(`[quick-tunnel] attempt ${attempts} failed; retrying in ${delay}ms`);
    this.#emit({
      state: "starting",
      transport: this.#transport,
      ...(safeDetail ? { errorDetail: safeDetail } : {}),
    });
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = null;
      if (generation !== this.#generation || this.#stopping) {
        return;
      }
      this.#launch();
    }, delay);
  }

  #writePidFile(pid: number | undefined): void {
    if (!this.#pidFilePath || pid === undefined) {
      return;
    }
    const write = this.#orphanDeps.writeTextFile ?? defaultWriteTextFile;
    void write(this.#pidFilePath, JSON.stringify({ pid, startedAt: this.#now() })).catch(
      () => undefined,
    );
  }

  #clearPidFile(): void {
    if (!this.#pidFilePath) {
      return;
    }
    const remove = this.#orphanDeps.removeFile ?? defaultRemoveFile;
    void remove(this.#pidFilePath).catch(() => undefined);
  }

  #emit(status: QuickTunnelStatus): void {
    this.#status = status;
    this.#onStatus?.({ ...status });
  }
}
