// Broker wire protocol, socket-path helpers, and health probing.
// The wire client and shared contracts live in the vendored runtime
// (vendor/dist-index.js); this module adds the thin helpers around it.
import { randomBytes } from "node:crypto";
import net from "node:net";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  PermissionBrokerClient,
  PermissionBrokerError,
  CuaHelperError,
  resolveBrokerSocketPath,
  isWindowsNamedPipePath,
  brokerRuntimeDir,
  BROKER_SOCKET_ENV,
  BROKER_SOCKET_FILENAME,
  BROKER_METHODS,
  BROKER_METHOD_SET,
  BROKER_PRESENTED_RESULT,
  CUA_BROKER_IPC_VERSION,
  ALLOW_ANY_PEER_ENV,
  ALLOW_DEV_BROKER_ENV,
  DEV_BROKER_TRUTHY,
  CUA_NOT_READY_KIND,
} from "./vendor/dist-index.js";

export {
  PermissionBrokerClient,
  PermissionBrokerError,
  CuaHelperError,
  resolveBrokerSocketPath,
  isWindowsNamedPipePath,
  brokerRuntimeDir,
  BROKER_SOCKET_ENV,
  BROKER_SOCKET_FILENAME,
  BROKER_METHODS,
  BROKER_METHOD_SET,
  BROKER_PRESENTED_RESULT,
  CUA_BROKER_IPC_VERSION,
  ALLOW_ANY_PEER_ENV,
  ALLOW_DEV_BROKER_ENV,
  DEV_BROKER_TRUTHY,
  CUA_NOT_READY_KIND,
};

// Marker env key written into runtimes when the broker could not be started.
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

// Server-side error. Distinct from the client-side
// PermissionBrokerError: this one is code-first.
export class BrokerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.details = { ...details };
  }
}

export const permissionDenied = (message, details) =>
  new BrokerError("permission_denied", message, details);
export const notAuthorized = (message, details) =>
  new BrokerError("not_authorized", message, details);
export const elementUnavailable = (message, details) =>
  new BrokerError("element_unavailable", message, details);
export const notSettable = (message, details) =>
  new BrokerError("not_settable", message, details);
export const notSelectable = (message, details) =>
  new BrokerError("not_selectable", message, details);
export const actionUnavailable = (message, details) =>
  new BrokerError("action_unavailable", message, details);
export const foregroundRequired = (message, details) =>
  new BrokerError("foreground_required", message, details);
export const launchFailed = (message, details) =>
  new BrokerError("launch_failed", message, details);

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

export function isBrokerMethod(method) {
  return BROKER_METHOD_SET.has(method);
}

// Helper src/broker/types.ts: methods admitted without a controller lease.
const READ_ONLY_BROKER_METHODS = new Set([
  "broker_info",
  "controller_status",
  "request_access",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  "permission_status",
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "is_focus_steal_prevented",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
]);
export function isReadOnlyBrokerMethod(method) {
  return READ_ONLY_BROKER_METHODS.has(method);
}

const PIP_SESSION_BROKER_METHODS = new Set(["pip_session_handshake", "pip_session_event"]);
export function isPipSessionBrokerMethod(method) {
  return PIP_SESSION_BROKER_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// Wire protocol (src/broker/brokerProtocol.ts)
// ---------------------------------------------------------------------------

function validRequestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseRequestLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, id: 0, code: "invalid_request", message: "request is not valid JSON" };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, id: 0, code: "invalid_request", message: "request must be a JSON object" };
  }
  const record = value;
  const rawId = record.id;
  const id = validRequestId(rawId) ? rawId : 0;
  if (!validRequestId(rawId)) {
    return {
      ok: false,
      id,
      code: "invalid_request",
      message: "request.id must be a non-negative safe integer",
    };
  }
  if (typeof record.method !== "string" || record.method.length === 0) {
    return { ok: false, id, code: "invalid_request", message: "request.method must be a non-empty string" };
  }
  const params = record.params;
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return { ok: false, id, code: "invalid_request", message: "request.params must be an object" };
  }
  return { ok: true, request: { id, method: record.method, params: params ?? {} } };
}

export function okResponse(id, result, presentation) {
  return {
    id,
    ok: true,
    result: result ?? null,
    ...(presentation === undefined ? {} : { presentation }),
  };
}

export function errorResponse(id, code, message, details) {
  const error = { code, message };
  if (details !== undefined && Object.keys(details).length > 0) {
    error.details = { ...details };
  }
  return { id, ok: false, error };
}

export function errorResponseFromException(id, error) {
  // Accept either the server-side BrokerError or the client-side
  // PermissionBrokerError: both carry a string .code and .details.
  if (error instanceof Error && typeof error.code === "string" && error.code.length > 0) {
    return errorResponse(id, error.code, error.message, error.details);
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(id, "internal", message);
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

function isBrokerPresentedResult(value) {
  return typeof value === "object" && value !== null && value[BROKER_PRESENTED_RESULT] === true;
}

export async function dispatchRequest(backend, request) {
  if (!isBrokerMethod(request.method)) {
    return errorResponse(request.id, "method_not_found", `unknown broker method: ${request.method}`);
  }
  const handler = backend[request.method];
  if (typeof handler !== "function") {
    return errorResponse(request.id, "method_not_found", `broker backend does not implement: ${request.method}`);
  }
  try {
    const result = await handler(request.params);
    return isBrokerPresentedResult(result)
      ? okResponse(request.id, result.result, result.presentation)
      : okResponse(request.id, result);
  } catch (error) {
    return errorResponseFromException(request.id, error);
  }
}

export async function handleRequestLine(backend, line) {
  const parsed = parseRequestLine(line);
  if (!parsed.ok) {
    return errorResponse(parsed.id, parsed.code, parsed.message);
  }
  return dispatchRequest(backend, parsed.request);
}

// ---------------------------------------------------------------------------
// Socket-path minting / resolution
// ---------------------------------------------------------------------------

// win32: named pipe; other platforms: per-runtime-dir
// broker-<16hex>.sock, pruning stale broker-*.sock older than 24h.
const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\zcode-cua-helper-";
const STALE_SOCKET_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
// 探活超时：本机 unix socket 连接是微秒级，250ms 足够且不至于拖慢 mint。
const SOCKET_LIVENESS_PROBE_TIMEOUT_MS = 250;

/** unix socket 是否仍可连接（活 broker 的 socket 探测必然成功）。 */
function isSocketPathAlive(path) {
  return new Promise((resolveAlive) => {
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveAlive(alive);
    };
    const socket = net.connect({ path });
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(SOCKET_LIVENESS_PROBE_TIMEOUT_MS, () => done(false));
  });
}

// mtime 只是 bind 时刻：运行超 24h 的活 broker 的 socket 也会「过期」。
// 直接 unlink 会把活 socket 删掉——旧路径上所有新连接 ENOENT，对端 host 健康探测
// 失败触发无谓重启。unlink 前必须探活；探活与 unlink 之间 broker 恰好 bind 的窗口
// 极窄且后果仅是一次自愈性重启，可接受。
async function pruneStaleBrokerSockets(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_SOCKET_MAX_AGE_MS;
  for (const name of names) {
    if (!/^broker-[0-9a-f]{16}\.sock$/u.test(name)) continue;
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      if (await isSocketPathAlive(path)) continue;
      await unlink(path);
    } catch {}
  }
}

export function mintBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  if (process.platform === "win32") {
    return WINDOWS_NAMED_PIPE_PREFIX + randomBytes(8).toString("hex");
  }
  const dir = options.dir ?? brokerRuntimeDir(env);
  // 签名保持同步（broker-server 与 services 的 socketPathFactory 都按同步消费）；
  // prune 只是清理，与本次铸造结果无关，后台执行即可。
  void pruneStaleBrokerSockets(dir);
  return join(dir, `broker-${randomBytes(8).toString("hex")}.sock`);
}

// ---------------------------------------------------------------------------
// Client-side call / health probe
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export async function callBrokerMethod(args) {
  const client = new PermissionBrokerClient(args.socketPath, {
    timeoutMs: args.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  });
  return await client.call(args.method, args.params ?? {});
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_POLL_MS = 100;
const DEFAULT_PROBE_PER_TRY_MS = 1_000;

export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROBE_POLL_MS;
  const perTryTimeoutMs = options.perTryTimeoutMs ?? DEFAULT_PROBE_PER_TRY_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const info = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        params: {},
        timeoutMs: perTryTimeoutMs,
      });
      const record = typeof info === "object" && info !== null ? info : {};
      return {
        bundleId: typeof record.bundle_id === "string" ? record.bundle_id : null,
        pid: typeof record.pid === "number" ? record.pid : null,
      };
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  throw lastError ?? new Error("Computer Use Helper health probe timed out");
}
