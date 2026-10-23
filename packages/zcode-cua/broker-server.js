/* oxlint-disable eslint(max-lines) -- Helper 安装/启动/生命周期/refresh-marker 共享同一套传输与代际状态，刻意保持单文件内聚。 */
// Host-side broker surface: Helper constants, launcher/installer plumbing,
// lifecycle manager, permission-refresh marker, and the product MCP server
// resolver that injects broker credentials into Agent-visible MCP entries.
//
// Sources:
//   * vendor/dist-index.js — bundled runtime surface
//   * Helper-side broker server contracts (macOS LaunchServices path)
//   * Host-side helper host/resolver internals
import { existsSync, realpathSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

import {
  CuaHelperError,
  BrokerError,
  probeHelperHealth,
  callBrokerMethod,
  mintBrokerSocketPath,
  isWindowsNamedPipePath,
  brokerRuntimeDir,
} from "./broker.js";
import {
  HELPER_APP_NAME,
  DEV_HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_TEAM_ID,
  LAUNCHER_PID_ENV,
  CUA_HELPER_INSTALL_VARIANT_ENV,
  CUA_HELPER_INSTALL_VARIANTS,
  isCuaDevModeRequested,
  isCuaLocalDevelopmentRuntime,
  COMPILED_LOCAL_DEVELOPMENT_RUNTIME,
  buildHelperOpenArgs,
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  verifyCuaHelperBundle,
  resolveCuaHelperInstallPlan,
  resolveCuaHelperInstallRoot,
  resolveExpectedCuaHelperBundleId,
  resolveExpectedCuaHelperBuildId,
  resolveCuaHelperRuntimeVersion,
  standaloneHelperCandidatePaths,
  resolveStandaloneInstallRoot,
  resolveZcodeHome,
  ensureStandaloneHelperLaunched,
  launchHelperApp,
  promoteHelperApp,
  acquireMacOSCuaHelperInstallLease,
  ensureCuaHelperInstalledUnderLease,
  ensureCuaHelperInstalledSingleFlight,
  isExpectedHelperVersion,
  describeHelperVersionMismatch,
  normalizeHelperBuildId,
  normalizeHelperArch,
  normalizeHelperPlatform,
  helperLogDirectory,
  helperLogLines,
  pruneHelperLogs,
  helperExitLogPathFor,
  isExplicitLocalDevOptIn,
  isUnsignedHelperLocalDevRequested,
  devBrokerOptIn,
  shouldRefreshLocalDevBundledHelper,
  localDevPayloadTreeChanged,
  stageBundledHelperApp,
  stageDownloadedHelperApp,
  findHelperAppRecursively,
  HelperInstallLockContendedError,
  isLockContendedError,
  installLeaseAbortedError,
  prepareHelperInstallLockFile,
  writeInstallMeta,
  LOCAL_DEV_RUNTIME_PAYLOAD_PATHS,
} from "./vendor/dist-index.js";

export {
  HELPER_APP_NAME,
  DEV_HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_TEAM_ID,
  LAUNCHER_PID_ENV,
  CUA_HELPER_INSTALL_VARIANT_ENV,
  CUA_HELPER_INSTALL_VARIANTS,
  isCuaDevModeRequested,
  isCuaLocalDevelopmentRuntime,
  COMPILED_LOCAL_DEVELOPMENT_RUNTIME,
  buildHelperOpenArgs,
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  verifyCuaHelperBundle,
  resolveCuaHelperInstallPlan,
  resolveCuaHelperInstallRoot,
  resolveExpectedCuaHelperBundleId,
  resolveExpectedCuaHelperBuildId,
  resolveCuaHelperRuntimeVersion,
  standaloneHelperCandidatePaths,
  resolveStandaloneInstallRoot,
  resolveZcodeHome,
  ensureStandaloneHelperLaunched,
  launchHelperApp,
  promoteHelperApp,
  acquireMacOSCuaHelperInstallLease,
  ensureCuaHelperInstalledUnderLease,
  ensureCuaHelperInstalledSingleFlight,
  isExpectedHelperVersion,
  describeHelperVersionMismatch,
  normalizeHelperBuildId,
  normalizeHelperArch,
  normalizeHelperPlatform,
  helperLogDirectory,
  helperLogLines,
  pruneHelperLogs,
  helperExitLogPathFor,
  isExplicitLocalDevOptIn,
  isUnsignedHelperLocalDevRequested,
  devBrokerOptIn,
  shouldRefreshLocalDevBundledHelper,
  localDevPayloadTreeChanged,
  stageBundledHelperApp,
  stageDownloadedHelperApp,
  findHelperAppRecursively,
  HelperInstallLockContendedError,
  isLockContendedError,
  installLeaseAbortedError,
  prepareHelperInstallLockFile,
  writeInstallMeta,
  LOCAL_DEV_RUNTIME_PAYLOAD_PATHS,
};

// Display name constant lives in the Helper build's helperConstants.
export const HELPER_DISPLAY_NAME = "ZCode Computer Use";

// The following four helpers are host-side launcher plumbing (not part of
// the vendored client slice).

// env: ZCODE_CUA_DISABLE_CPS_ACTIVATION
export function cpsActivationDisableRequested(env = process.env) {
  const v = env.ZCODE_CUA_DISABLE_CPS_ACTIVATION?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// env: LAUNCHER_PID_ENV carries the launcher pid; fall back to own pid.
export function resolveLauncherPid(env = process.env) {
  const raw = env[LAUNCHER_PID_ENV];
  if (typeof raw === "string") {
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return process.pid;
}

// Dev runtime resolves to the dev-named Helper app; otherwise the stable name.
export function resolveHelperAppName(env = process.env) {
  return isCuaDevModeRequested(env) ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
}

const LAUNCH_CANCEL_DIR_NAME = ".launch-cancel";
const LAUNCH_CANCEL_SENTINEL_RE =
  /^\.broker-launch-cancel-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sentinel$/u;

function guardAnchorDirectory(socketPath) {
  return isWindowsNamedPipePath(socketPath)
    ? brokerRuntimeDir(process.env)
    : dirname(resolvePath(socketPath));
}

function canonicalGuardDirectoryForSocket(socketPath) {
  if (!isWindowsNamedPipePath(socketPath) && !isAbsolute(socketPath)) return null;
  try {
    return join(realpathSync(guardAnchorDirectory(socketPath)), LAUNCH_CANCEL_DIR_NAME);
  } catch {
    return null;
  }
}

// A broker launch guard is only honored when its cancel sentinel is a UUID-named
// file inside the canonical .launch-cancel dir anchored to the socket path —
// prevents an attacker-controlled path from cancelling a real Helper launch.
export function isSafeCuaHelperBrokerLaunchGuard(socketPath, guard) {
  if (
    !Number.isSafeInteger(guard.deadlineEpochMs) ||
    guard.deadlineEpochMs <= 0 ||
    !isAbsolute(guard.cancelFilePath) ||
    !LAUNCH_CANCEL_SENTINEL_RE.test(basename(guard.cancelFilePath))
  ) {
    return false;
  }
  const canonical = canonicalGuardDirectoryForSocket(socketPath);
  if (!canonical) return false;
  try {
    return realpathSync(dirname(resolvePath(guard.cancelFilePath))) === canonical;
  } catch {
    return false;
  }
}

// Env override for the packaged native addon path (Helper src/native loader).
export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";

// Control protocol spoken over the fork IPC channel between the host and the
// Windows dev Helper child process.
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

// ---------------------------------------------------------------------------
// Native addon loader (Helper src/broker/server/nativeAddon.ts)
// ---------------------------------------------------------------------------

const PACKAGED_ADDON_BASENAME = "ax_native.node";
const IN_TREE_ADDON_REL = join("build", "Release", "ax_native.node");

function loaderModuleBase(moduleUrl) {
  if (moduleUrl) return moduleUrl;
  const argvEntry = process.argv[1];
  return typeof argvEntry === "string" && isAbsolute(argvEntry) ? argvEntry : process.execPath;
}

export function resolvePackagedNativeAddonPath(options = {}) {
  const env = options.env ?? process.env;
  const explicitAddonPath = env[HELPER_ADDON_ENV]?.trim();
  if (explicitAddonPath) return explicitAddonPath;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return undefined;
  }
  const execPath = options.execPath ?? process.execPath;
  const candidate = join(dirname(execPath), "..", "Resources", PACKAGED_ADDON_BASENAME);
  const normalizedExecPath = execPath.replaceAll("\\", "/");
  if (
    (options.fileExists ?? existsSync)(candidate) ||
    normalizedExecPath.includes(`/${HELPER_APP_NAME}/Contents/`)
  ) {
    return candidate;
  }
  return undefined;
}

export function resolveInTreeAddonPath(options = {}) {
  const fileExists = options.fileExists ?? existsSync;
  const startDir = dirname(
    options.moduleUrl ? fileURLToPath(new URL(".", options.moduleUrl)) : loaderModuleBase(),
  );
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, IN_TREE_ADDON_REL);
    if (fileExists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function loadRealNativeAddon(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new CuaHelperError(
      "unsupported_platform",
      `Unsupported platform for CUA native addon: ${platform} (expected darwin, linux, or win32).`,
    );
  }
  const req = options.require ?? createRequire(loaderModuleBase(options.moduleUrl));
  const packagedPath = resolvePackagedNativeAddonPath({
    platform,
    env: options.env,
    execPath: options.execPath,
    fileExists: options.fileExists,
  });
  if (packagedPath) return req(packagedPath);
  const inTreePath = resolveInTreeAddonPath({
    fileExists: options.fileExists,
    moduleUrl: options.moduleUrl,
  });
  if (inTreePath) return req(inTreePath);
  throw new CuaHelperError(
    "unavailable",
    `CUA native addon (ax_native.node) not found for ${platform}. Run \`node-gyp rebuild\` in the @zcode/zcode-cua package, or set ${HELPER_ADDON_ENV} to the .node path.`,
  );
}

// ---------------------------------------------------------------------------
// Helper permission subject identity (consumer-side; darwin uses PlistBuddy +
// codesign, other platforms report the path-based identity).
// ---------------------------------------------------------------------------

function execFileText(command, args, timeout) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1024, timeout }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

export async function resolveHelperPermissionSubjectIdentity(appPath) {
  if (typeof appPath !== "string" || appPath.trim().length === 0) {
    throw new CuaHelperError("invalid_argument", "helper app path must be non-empty");
  }
  const resolvedPath = appPath.trim();
  if (process.platform === "darwin") {
    const plist = join(resolvedPath, "Contents", "Info.plist");
    const [executableName, bundleId, displayName] = await Promise.all([
      execFileText("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist], 1e3),
      execFileText("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], 1e3),
      execFileText("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", plist], 1e3),
    ]);
    if (!executableName?.trim()) {
      throw new CuaHelperError(
        "verification_failed",
        `ZCode Computer Use bundle at ${resolvedPath} has no readable CFBundleExecutable`,
      );
    }
    return {
      appPath: resolvedPath,
      executablePath: join(resolvedPath, "Contents", "MacOS", executableName.trim()),
      displayName: displayName?.trim() || basename(resolvedPath, ".app"),
      bundleId: bundleId?.trim() ?? "",
    };
  }
  return {
    appPath: resolvedPath,
    executablePath: resolvedPath,
    displayName: basename(resolvedPath).replace(/\.(app|exe)$/i, "") || HELPER_DISPLAY_NAME,
    bundleId: "",
  };
}

// ---------------------------------------------------------------------------
// Broker permission-refresh marker (host bundle)
// ---------------------------------------------------------------------------

const REFRESH_MARKER_SUFFIX = ".permission-refresh.json";
const REFRESH_MARKER_DEFAULT_DEADLINE_MS = 30_000;
const REFRESH_MARKER_MAX_DEADLINE_MS = 120_000;
const refreshMarkerInFlight = new Map();

export function cuaBrokerRefreshMarkerPath(socketPath) {
  const trimmed = socketPath?.trim();
  if (!trimmed) {
    throw new CuaHelperError(
      "invalid_argument",
      "CUA broker refresh marker requires a non-empty socket path",
    );
  }
  return `${trimmed}${REFRESH_MARKER_SUFFIX}`;
}

export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? REFRESH_MARKER_DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > REFRESH_MARKER_MAX_DEADLINE_MS) {
    throw new CuaHelperError(
      "invalid_argument",
      `CUA broker refresh marker deadline must be within 1-${REFRESH_MARKER_MAX_DEADLINE_MS}ms, got ${deadlineMs}`,
    );
  }
  const path = cuaBrokerRefreshMarkerPath(socketPath);
  if (refreshMarkerInFlight.has(path)) {
    throw new CuaHelperError(
      "controller_busy",
      "CUA broker permission refresh is already active for this transport",
    );
  }
  const id = Symbol("cua-broker-refresh-marker");
  refreshMarkerInFlight.set(path, { id });
  const started = now();
  const deadlineEpochMs = started + deadlineMs;
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= started) {
    refreshMarkerInFlight.delete(path);
    throw new CuaHelperError(
      "internal",
      "CUA broker refresh marker clock produced an invalid deadline",
    );
  }
  const body = `${JSON.stringify({ schema: 1, kind: "permission_refresh", deadlineEpochMs })}\n`;
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    if (refreshMarkerInFlight.get(path)?.id === id) refreshMarkerInFlight.delete(path);
    throw error;
  }
  return {
    path,
    deadlineEpochMs,
    complete: async () => {
      if (refreshMarkerInFlight.get(path)?.id !== id) return;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(path, { force: true });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (lastError) throw lastError;
      if (refreshMarkerInFlight.get(path)?.id === id) refreshMarkerInFlight.delete(path);
    },
  };
}

// ---------------------------------------------------------------------------
// AX role table (Windows UIA control types; Helper src/native/win.ts)
// ---------------------------------------------------------------------------

export const ROLE_TO_KIND = Object.freeze({
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXTextField: "textfield",
  AXTextArea: "textarea",
  AXSecureTextField: "securefield",
  AXComboBox: "combobox",
  AXPopUpButton: "combobox",
  AXMenuButton: "button",
  AXLink: "link",
  AXStaticText: "text",
  AXImage: "image",
  AXGroup: "group",
  AXWindow: "window",
  AXScrollArea: "scrollarea",
  AXList: "list",
  AXRow: "row",
  AXCell: "cell",
  AXOutline: "outline",
  AXTable: "table",
  AXSlider: "slider",
  AXStepper: "stepper",
  AXTabGroup: "tabgroup",
  AXToolbar: "toolbar",
  AXMenu: "menu",
  AXMenuItem: "menuitem",
  AXMenuBar: "menubar",
  AXMenuBarItem: "menubaritem",
  AXSplitter: "splitter",
  AXSplitGroup: "splitgroup",
  AXProgressIndicator: "progressbar",
  AXBusyIndicator: "progressbar",
  AXValueIndicator: "progressbar",
  AXWebArea: "webarea",
  AXHeading: "heading",
  AXApplication: "application",
  AXDialog: "dialog",
  AXSheet: "sheet",
  AXDrawer: "drawer",
  AXGrowArea: "growarea",
  AXLayoutArea: "layoutarea",
  AXLayoutItem: "layoutitem",
  AXHandle: "handle",
  AXColorWell: "colorwell",
  AXHelpTag: "helptag",
  AXMatte: "matte",
  AXRuler: "ruler",
  AXScrollBar: "scrollbar",
  AXDisclosureTriangle: "disclosuretriangle",
});

export function roleToKind(role) {
  return typeof role === "string" ? ROLE_TO_KIND[role] : undefined;
}

// Read-only AX observation methods the host can expose straight from a native
// source (Helper keeps the authoritative set; this is the same shape).
export function createAxReadOnlyMethods(source, _registry, _options) {
  const readOnly = {};
  for (const name of [
    "list_applications",
    "application_info",
    "list_windows",
    "capture_app",
    "element_at_point",
    "read_element",
    "permission_status",
    "input_permission_status",
    "screen_capture_status",
    "screen_capture_probe",
    "supports_accessibility",
  ]) {
    const fn = source?.[name];
    if (typeof fn === "function") {
      readOnly[name] = (params) => fn.call(source, params);
    }
  }
  return readOnly;
}

// ---------------------------------------------------------------------------
// Helper lifecycle manager (host bundle CuaHelperLifecycleManager)
// ---------------------------------------------------------------------------

export class CuaHelperLifecycleManager {
  #stopInstance;
  #current;
  #retiring;
  #terminal = false;
  #transitionTail = Promise.resolve();
  #disposePromise;

  constructor(stopInstance) {
    this.#stopInstance = stopInstance;
  }

  get disposed() {
    return this.#terminal;
  }

  isCurrent(candidate) {
    return !this.#terminal && this.#current === candidate;
  }

  peek() {
    return this.#terminal ? undefined : this.#current;
  }

  acquire(options) {
    return this.#enqueue(async () => {
      if (this.#terminal) return undefined;
      await this.#finishRetiringInstance();
      if (this.#terminal) return undefined;
      if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
        await this.#stopCurrentIfNeeded(options.shouldRetainCurrent);
        return undefined;
      }
      if (!this.#current) this.#current = options.create();
      return this.#current;
    });
  }

  reconcile(options) {
    return this.#enqueue(async () => {
      if (this.#terminal) return;
      await this.#finishRetiringInstance();
      if (!this.#terminal) {
        await this.#stopCurrentIfNeeded(options?.shouldRetainCurrent ?? (() => false));
      }
    });
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#terminal = true;
    this.#disposePromise = this.#enqueue(async () => {
      const current = this.#current;
      const retiring = this.#retiring;
      this.#current = undefined;
      this.#retiring = undefined;
      const instances = [retiring, current].filter(
        (item, index, all) => item !== undefined && all.indexOf(item) === index,
      );
      const failures = [];
      for (const instance of instances) {
        try {
          await this.#stopInstance?.(instance);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Failed to stop Computer Use Helper instances");
      }
    });
    return this.#disposePromise;
  }

  async #stopCurrentIfNeeded(shouldRetainCurrent) {
    const current = this.#current;
    if (!current) return;
    if (shouldRetainCurrent?.(current)) return;
    this.#current = undefined;
    this.#retiring = current;
    await this.#finishRetiringInstance();
  }

  async #finishRetiringInstance() {
    const retiring = this.#retiring;
    if (!retiring) return;
    await this.#stopInstance?.(retiring);
    if (this.#retiring === retiring) this.#retiring = undefined;
  }

  #enqueue(operation) {
    const queued = this.#transitionTail.then(operation, operation);
    this.#transitionTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

export class CuaProductHelperWorkspaceRegistry {
  targetsByWorkspaceKey = new Map();

  setEnabled(context, enabled) {
    if (!context?.workspaceKey) return;
    if (!enabled) {
      this.targetsByWorkspaceKey.delete(context.workspaceKey);
      return;
    }
    this.targetsByWorkspaceKey.set(context.workspaceKey, {
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    });
  }

  snapshot() {
    return [...this.targetsByWorkspaceKey.values()];
  }

  pruneDisabled(keep) {
    for (const [key, target] of this.targetsByWorkspaceKey) {
      if (!keep(target)) this.targetsByWorkspaceKey.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent-env unavailable generation markers (host bundle WeakMap)
// ---------------------------------------------------------------------------

const recoveryStateByHost = new WeakMap();

function recoveryStateFor(host) {
  let state = recoveryStateByHost.get(host);
  if (!state) {
    state = { generation: 0, pendingGeneration: null };
    recoveryStateByHost.set(host, state);
  }
  return state;
}

export function markCuaProductHelperAgentEnvUnavailable(host) {
  const state = recoveryStateFor(host);
  state.generation += 1;
  state.pendingGeneration = state.generation;
  return state.generation;
}

function pendingCuaProductHelperRecoveryGeneration(host) {
  return recoveryStateByHost.get(host)?.pendingGeneration ?? null;
}

function commitCuaProductHelperRecoveryGeneration(host, generation) {
  const state = recoveryStateByHost.get(host);
  if (!state || state.pendingGeneration !== generation) return false;
  state.pendingGeneration = null;
  return true;
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return pendingCuaProductHelperRecoveryGeneration(host) !== null;
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  const state = recoveryStateByHost.get(host);
  if (state) state.pendingGeneration = null;
}

// ---------------------------------------------------------------------------
// Startup wait (host bundle waitForCuaHelperStartup)
// ---------------------------------------------------------------------------

const DEFAULT_STARTUP_DEADLINE_MS = 10_000;

export async function waitForCuaHelperStartup(startup, deadlineMs = DEFAULT_STARTUP_DEADLINE_MS) {
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new BrokerError(
              "caller_timeout",
              `ZCode Computer Use is still starting after ${deadlineMs}ms; retry the task shortly`,
            ),
          );
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Official CUA plugin MCP-server detection (host bundle)
// ---------------------------------------------------------------------------

const PLUGIN_ID_ENV = "ZCODE_PLUGIN_ID";
const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const PLUGIN_AUTHORITY_ENV = "ZCODE_CUA_PLUGIN_AUTHORITY";
const CUA_MCP_SERVER_NAME = "computer-use";
const CUA_MCP_NAMESPACED_NAME = "plugin:computer-use:computer-use";
const CUA_PACKAGE_SPEC_ENV = "ZCODE_CUA_PACKAGE_SPEC";
const BROKER_SOCKET_ARG = "--permission-broker-socket";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";
const BROKER_SOCKET_ENV_NAME = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";

function zcodeCuaArgLeaf(value) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? value;
}

function matchesZCodeCuaSpec(value) {
  const normalized = value.replace(/_/g, "-");
  return (
    normalized === "zcode-cua" ||
    normalized.startsWith("zcode-cua[") ||
    normalized.startsWith("zcode-cua@") ||
    normalized.startsWith("zcode-cua==") ||
    normalized.startsWith("zcode-cua.")
  );
}

function hasZCodeCuaPackageBoundary(value) {
  return matchesZCodeCuaSpec(value);
}

function matchesZCodeCuaSpecBroad(value) {
  const lowered = value.toLowerCase().replace(/_/g, "-");
  if (hasZCodeCuaPackageBoundary(lowered)) return true;
  const dotNormalized = lowered.replace(/([a-z0-9])\.(?=[a-z0-9])/g, "$1-");
  return hasZCodeCuaPackageBoundary(dotNormalized);
}

function isZCodeCuaMcpServerName(name, pluginId) {
  const normalized = name.trim().toLowerCase();
  if (normalized === CUA_MCP_SERVER_NAME) return true;
  return normalized === CUA_MCP_NAMESPACED_NAME && pluginId?.trim().toLowerCase() === OFFICIAL_CUA_PLUGIN_ID;
}

function isZCodeCuaMcpCommand(command) {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

function isZCodeCuaMcpPackageArg(arg) {
  return matchesZCodeCuaSpec(arg) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(arg));
}

function resolvesToZCodeCuaPackage({ command, args, packageSpec }) {
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    candidates.push(value);
    const leaf = zcodeCuaArgLeaf(value);
    if (leaf !== value) candidates.push(leaf);
  };
  push(command);
  if (args) for (const arg of args) push(arg);
  push(packageSpec);
  return candidates.some(matchesZCodeCuaSpecBroad);
}

function asCommandServer(server) {
  return typeof server === "object" && server !== null && "command" in server && typeof server.command === "string"
    ? server
    : null;
}

function normalizeAgentMcpArgs(args) {
  return Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : [];
}

function normalizeAgentMcpEnv(env) {
  return Array.isArray(env)
    ? env.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          typeof entry.value === "string",
      )
    : [];
}

function upsertEnv(env, name, value) {
  const filtered = env.filter((entry) => entry.name !== name).map((entry) => ({ ...entry }));
  filtered.push({ name, value });
  return filtered;
}

export function isPotentialZCodeCuaAgentMcpServer(server) {
  const command = asCommandServer(server);
  if (!command) return false;
  const name = "name" in server && typeof server.name === "string" ? server.name : "";
  if (name.trim().toLowerCase().startsWith("plugin:")) {
    const envEntries = normalizeAgentMcpEnv(command.env);
    const pluginId = envEntries.find((entry) => entry.name === PLUGIN_ID_ENV)?.value;
    if (isZCodeCuaMcpServerName(name, pluginId)) return true;
    const packageSpec = envEntries.find((entry) => entry.name === CUA_PACKAGE_SPEC_ENV)?.value;
    if (packageSpec && isZCodeCuaMcpPackageArg(packageSpec)) return true;
  } else if (name && isZCodeCuaMcpServerName(name, undefined)) {
    return true;
  }
  if (isZCodeCuaMcpCommand(command.command)) return true;
  return normalizeAgentMcpArgs(command.args).some(isZCodeCuaMcpPackageArg);
}

function isOfficialZCodeCuaPluginCandidate(server) {
  const command = asCommandServer(server);
  if (!command) return false;
  const name = "name" in server && typeof server.name === "string" ? server.name : "";
  if (name.trim().toLowerCase() !== CUA_MCP_NAMESPACED_NAME) return false;
  return (
    normalizeAgentMcpEnv(command.env)
      .find((entry) => entry.name === PLUGIN_ID_ENV)
      ?.value.trim()
      .toLowerCase() === OFFICIAL_CUA_PLUGIN_ID
  );
}

function isAuthorizedOfficialZCodeCuaPluginServer(server, pluginAuthority) {
  const authority = pluginAuthority?.trim();
  if (!authority || !isOfficialZCodeCuaPluginCandidate(server)) return false;
  return normalizeAgentMcpEnv(server.env).some(
    (entry) => entry.name === PLUGIN_AUTHORITY_ENV && entry.value === authority,
  );
}

function isUnbrokeredZCodeCuaAgentMcpServer(server) {
  const command = asCommandServer(server);
  if (!command) return false;
  const envEntries = normalizeAgentMcpEnv(command.env);
  const packageSpec = envEntries.find((entry) => entry.name === CUA_PACKAGE_SPEC_ENV)?.value;
  const resolves = resolvesToZCodeCuaPackage({
    command: command.command,
    args: normalizeAgentMcpArgs(command.args),
    packageSpec,
  });
  return resolves ? !envEntries.find((entry) => entry.name === BROKER_SOCKET_ENV_NAME)?.value?.trim() : false;
}

// args/env injection (host bundle injectPermissionBrokerConfig)
function optionArgsBeforeTerminator(args) {
  const index = args.indexOf("--");
  return index === -1 ? args : args.slice(0, index);
}

function hasSeparateOptionValue(value) {
  return value !== undefined && value !== "--" && !value.startsWith("--");
}

function upsertFlag(args, flag, value) {
  const terminatorIndex = args.indexOf("--");
  const before = optionArgsBeforeTerminator(args);
  const after = terminatorIndex === -1 ? [] : args.slice(terminatorIndex);
  const kept = [];
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === flag) {
      if (hasSeparateOptionValue(before[i + 1])) i += 1;
      continue;
    }
    if (!before[i]?.startsWith(`${flag}=`)) kept.push(before[i]);
  }
  args.splice(0, args.length, ...kept, flag, value, ...after);
}

function injectPermissionBrokerAgentMcpServer(server, transport) {
  if (!isAuthorizedOfficialZCodeCuaPluginServer(server, transport.pluginAuthority)) return server;
  if (!transport.socketPath || transport.socketPath.trim().length === 0) {
    throw new CuaHelperError(
      "invalid_argument",
      "injectPermissionBrokerAgentMcpServers requires a non-empty socketPath",
    );
  }
  const args = normalizeAgentMcpArgs(server.args);
  upsertFlag(args, BROKER_SOCKET_ARG, transport.socketPath);
  const markerPath = cuaBrokerRefreshMarkerPath(transport.socketPath);
  let env = upsertEnv(normalizeAgentMcpEnv(server.env), BROKER_SOCKET_ENV_NAME, transport.socketPath);
  env = upsertEnv(env, REFRESH_MARKER_ENV, markerPath);
  return { ...server, args, env };
}

// BYOK fork R5：0.6.5 消费面新增导出（services/cua-permission-broker/index.ts 经 export * 透传）。
export function injectPermissionBrokerAgentMcpServers(servers, transport) {
  if (!servers || servers.length === 0 || !transport.pluginAuthority?.trim()) return servers;
  const injected = servers.map((server) => injectPermissionBrokerAgentMcpServer(server, transport));
  return injected.some((server, index) => server !== servers[index]) ? injected : servers;
}

function omitUnbrokeredZCodeCuaAgentMcpServers(servers) {
  if (!servers || servers.length === 0) return servers;
  const kept = servers.filter((server) => !isUnbrokeredZCodeCuaAgentMcpServer(server));
  return kept.length === servers.length ? servers : kept;
}

// ---------------------------------------------------------------------------
// Permission restart with preserved transport (host bundle)
// ---------------------------------------------------------------------------

async function restartCuaHelperPreservingTransport(host, beforeFreshStart) {
  let fired = false;
  const once = () => {
    if (!fired) {
      fired = true;
      beforeFreshStart();
    }
  };
  const outcome = await (host.restartAfterCurrentStartPreservingTransport
    ? host.restartAfterCurrentStartPreservingTransport({ beforeFreshStart: once })
    : (async () => {
        once();
        return { handle: await host.restartAfterCurrentStart(), reused: false };
      })());
  if (!outcome.reused && !fired) {
    throw new BrokerError(
      "launch_failed",
      "Computer Use Helper fresh permission restart launched before the unavailable generation was published",
    );
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Product MCP server resolver (host bundle createCuaProductMcpServerResolver)
// ---------------------------------------------------------------------------

export function createCuaProductMcpServerResolver(host, options = {}) {
  let startInFlight = null;
  let restartInFlight = null;
  let grantRestartInFlight = null;
  let reconcileInFlight = null;
  let anonymousGrantSeq = 0;
  let grantTail = Promise.resolve();
  const grantInFlightBySession = new Map();
  const seenGrantSessions = new Set();

  function startHelper() {
    if (grantRestartInFlight) return grantRestartInFlight.then((result) => result.handle);
    if (startInFlight) return startInFlight;
    const pending = host.start().finally(() => {
      if (startInFlight === pending) startInFlight = null;
    });
    startInFlight = pending;
    return pending;
  }

  function restartHelper() {
    if (restartInFlight) return restartInFlight;
    const prior = grantRestartInFlight;
    const pending = (async () => {
      if (prior) await prior.catch(() => {});
      return (
        await restartCuaHelperPreservingTransport(host, () =>
          markCuaProductHelperAgentEnvUnavailable(host),
        )
      ).handle;
    })().finally(() => {
      if (restartInFlight === pending) restartInFlight = null;
    });
    restartInFlight = pending;
    return pending;
  }

  function restartHelperAfterPermissionGrant() {
    if (grantRestartInFlight) return grantRestartInFlight;
    const prior = restartInFlight;
    const pending = (async () => {
      if (prior) await prior.catch(() => {});
      return restartCuaHelperPreservingTransport(host, () =>
        markCuaProductHelperAgentEnvUnavailable(host),
      );
    })().finally(() => {
      if (grantRestartInFlight === pending) grantRestartInFlight = null;
    });
    grantRestartInFlight = pending;
    return pending;
  }

  function currentLifecyclePromise() {
    return grantRestartInFlight
      ? grantRestartInFlight.then((result) => result.handle)
      : restartInFlight ?? startInFlight;
  }

  async function recoverHelper() {
    await restartHelper();
    await reconcileSpawnAdmissionIfNeeded();
  }

  async function recoverAfterPermissionGrant() {
    await restartHelperAfterPermissionGrant();
    await reconcileSpawnAdmissionIfNeeded();
  }

  function restartAfterPermissionGrant(onboardingSessionId) {
    const sessionKey = onboardingSessionId?.trim() || `anonymous-grant-${++anonymousGrantSeq}`;
    if (seenGrantSessions.has(sessionKey)) return Promise.resolve();
    const inFlight = grantInFlightBySession.get(sessionKey);
    if (inFlight) return inFlight;
    const prior = grantTail;
    const tracked = (async () => {
      await prior.catch(() => {});
      await recoverAfterPermissionGrant();
      seenGrantSessions.add(sessionKey);
      if (seenGrantSessions.size > 64) {
        const oldest = seenGrantSessions.values().next().value;
        if (oldest) seenGrantSessions.delete(oldest);
      }
    })().finally(() => {
      if (grantInFlightBySession.get(sessionKey) === tracked) {
        grantInFlightBySession.delete(sessionKey);
      }
    });
    grantInFlightBySession.set(sessionKey, tracked);
    grantTail = tracked.catch(() => {});
    return tracked;
  }

  function readLiveHelperTuple() {
    const running = host.running;
    const socketPath = host.socketPath;
    const pluginAuthority = host.pluginAuthority;
    if (!running || !socketPath || !pluginAuthority) return null;
    return { socketPath, pluginAuthority };
  }

  function helperTupleChanged(tuple) {
    const live = readLiveHelperTuple();
    return (
      live !== null &&
      (live.socketPath !== tuple.socketPath || live.pluginAuthority !== tuple.pluginAuthority)
    );
  }

  async function reconcileSpawnAdmissionIfNeeded() {
    for (;;) {
      if (!reconcileInFlight) {
        if (!hasCuaProductHelperAgentEnvUnavailable(host)) return;
        reconcileInFlight = (async () => {
          for (;;) {
            const pending = currentLifecyclePromise();
            if (pending) {
              await waitForCuaHelperStartup(pending);
              continue;
            }
            const generation = pendingCuaProductHelperRecoveryGeneration(host);
            if (generation === null) return;
            if (readLiveHelperTuple()) commitCuaProductHelperRecoveryGeneration(host, generation);
            return;
          }
        })().finally(() => {
          reconcileInFlight = null;
        });
      }
      await reconcileInFlight;
      if (!hasCuaProductHelperAgentEnvUnavailable(host)) return;
    }
  }

  async function stabilizeHelperTuple() {
    for (;;) {
      const pending = currentLifecyclePromise();
      if (pending) {
        try {
          await waitForCuaHelperStartup(pending);
        } catch (error) {
          if (!hasCuaProductHelperAgentEnvUnavailable(host)) {
            markCuaProductHelperAgentEnvUnavailable(host);
          }
          throw error;
        }
        continue;
      }
      await reconcileSpawnAdmissionIfNeeded();
      if (currentLifecyclePromise() || hasCuaProductHelperAgentEnvUnavailable(host)) continue;
      const live = readLiveHelperTuple();
      if (live) return live;
      markCuaProductHelperAgentEnvUnavailable(host);
      throw new BrokerError(
        "launch_failed",
        "ZCode Computer Use lifecycle completed without a live broker credential tuple",
      );
    }
  }

  async function ensureHelperReady() {
    const live = readLiveHelperTuple();
    if (!currentLifecyclePromise() && live) {
      try {
        await host.checkHealth(1_000);
      } catch {
        if (options.hasActiveTurn?.()) {
          throw new BrokerError(
            "restart_deferred_active_turn",
            "cua helper is unhealthy but an agent turn is active; deferring restart to the next request boundary",
          );
        }
        if (!currentLifecyclePromise() && !helperTupleChanged(live)) restartHelper();
      }
    } else if (!currentLifecyclePromise() && !live) {
      startHelper();
    }
    return stabilizeHelperTuple();
  }

  function warmHelperForBuiltInPlugin() {
    if (host.running || currentLifecyclePromise()) return;
    startHelper().catch(() => {});
  }

  async function resolveMcpServersImpl(servers) {
    const candidates = servers?.filter(isPotentialZCodeCuaAgentMcpServer);
    if (!servers || !candidates?.length) {
      if (!host.running) {
        warmHelperForBuiltInPlugin();
        return servers;
      }
      try {
        await ensureHelperReady();
      } catch {}
      return servers;
    }
    const authority = host.pluginAuthority ?? undefined;
    if (
      !candidates.some(
        (server) =>
          isOfficialZCodeCuaPluginCandidate(server) &&
          isAuthorizedOfficialZCodeCuaPluginServer(server, authority),
      )
    ) {
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    let tuple;
    try {
      tuple = await ensureHelperReady();
    } catch {
      if (!hasCuaProductHelperAgentEnvUnavailable(host)) {
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    const filtered = servers.filter(
      (server) =>
        !isPotentialZCodeCuaAgentMcpServer(server) ||
        isAuthorizedOfficialZCodeCuaPluginServer(server, tuple.pluginAuthority),
    );
    return injectPermissionBrokerAgentMcpServers(filtered, tuple);
  }

  return {
    async resolveMcpServers(servers) {
      const resolved = await resolveMcpServersImpl(servers);
      return omitUnbrokeredZCodeCuaAgentMcpServers(resolved);
    },
    async restart() {
      await recoverHelper();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      await restartAfterPermissionGrant(onboardingSessionId);
    },
    async reconcileRecoveredHelper() {
      if (!currentLifecyclePromise() && hasCuaProductHelperAgentEnvUnavailable(host) && readLiveHelperTuple()) {
        await reconcileSpawnAdmissionIfNeeded();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Official plugin enablement (host bundle resolveOfficialCuaPluginEnablement)
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const PROJECT_CONFIG_CANDIDATES = ["zcode.json", join(".zcode", "config.json")];
const WORKTREE_MARKER = ".git";

function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasWorktreeMarker(dir) {
  const marker = join(dir, WORKTREE_MARKER);
  try {
    if (!existsSync(marker)) return false;
    const stat = statSync(marker);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function getProjectConfigDirectories(fromDir) {
  const chain = [];
  let current = fromDir;
  for (;;) {
    chain.push(current);
    if (hasWorktreeMarker(current)) return chain.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [fromDir];
}

function discoverZCodeProjectConfigPaths(workingDirectory) {
  const start = resolvePath(workingDirectory ?? process.cwd());
  return getProjectConfigDirectories(start).flatMap((dir) =>
    PROJECT_CONFIG_CANDIDATES.map((name) => join(dir, name)).filter((path) => existsSync(path)),
  );
}

function resolveOfficialCuaPluginEnablementState(options) {
  let mcpEnabled = true;
  let pluginsEnabled = true;
  let pluginEnabled = false;
  let configured = false;
  const configPaths = [
    ...(options.userConfigPath ? [options.userConfigPath] : []),
    ...discoverZCodeProjectConfigPaths(options.workingDirectory),
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
  ];
  for (const path of configPaths) {
    const config = readJsonObject(path);
    if (!config) continue;
    if (hasOwn(config, "features")) {
      const features = readJsonObjectValue(config.features);
      if (features) {
        if (hasOwn(features, "mcp")) mcpEnabled = features.mcp === true;
      } else {
        mcpEnabled = false;
      }
    }
    if (hasOwn(config, "plugins")) {
      const plugins = readJsonObjectValue(config.plugins);
      if (!plugins) {
        pluginsEnabled = false;
        pluginEnabled = false;
        configured = true;
        continue;
      }
      if (hasOwn(plugins, "enabled")) pluginsEnabled = plugins.enabled === true;
      if (hasOwn(plugins, "enabledPlugins")) {
        const enabledPlugins = readJsonObjectValue(plugins.enabledPlugins);
        if (enabledPlugins) {
          if (hasOwn(enabledPlugins, options.pluginId)) {
            pluginEnabled = enabledPlugins[options.pluginId] === true;
          }
          configured = true;
        } else {
          pluginEnabled = false;
          configured = true;
        }
      }
    }
  }
  return { configured, enabled: mcpEnabled && pluginsEnabled && pluginEnabled };
}

function readJsonObjectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME?.trim() || homedir();
  return resolveOfficialCuaPluginEnablementState({
    pluginId: OFFICIAL_CUA_PLUGIN_ID,
    workingDirectory: options.workingDirectory,
    projectConfigPath: options.projectConfigPath,
    userConfigPath: options.userConfigPath ?? join(home, ".zcode", "cli", "config.json"),
  }).enabled;
}

// ---------------------------------------------------------------------------
// Screen-capture probe classification
// ---------------------------------------------------------------------------

export function isScreenCaptureProbeSuccess(probe) {
  return Boolean(probe) && typeof probe === "object" && probe.ok === true;
}

// ---------------------------------------------------------------------------
// Product Helper host (LaunchServices-driven; darwin only — on Windows the
// services layer supplies WindowsCuaHelperHost instead).
// ---------------------------------------------------------------------------

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

function resolveHelperAppPathFromCandidates(candidates, fileExists = existsSync) {
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function createProductCuaHelperHost(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const installer =
    options.helperInstaller === false
      ? undefined
      : (options.helperInstaller ??
        createCuaHelperInstaller({
          logger,
          env,
          bundledAppPath: options.bundledHelperAppPath,
        }));

  let handle = null;
  let startInFlight = null;
  let lifecycleTail = Promise.resolve();
  const pluginAuthority = randomUUID();

  const log = (level, message, fields) => {
    try {
      logger?.[level]?.(undefined, message, fields);
    } catch {}
  };

  const enqueue = (operation) => {
    const queued = lifecycleTail.then(operation, operation);
    lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  async function resolveHelperApp() {
    const candidates = [
      options.bundledHelperAppPath,
      ...standaloneHelperCandidatePaths(env),
    ].filter(Boolean);
    let appPath = resolveHelperAppPathFromCandidates(candidates);
    if (!appPath && installer) {
      appPath = await installer.ensureInstalled();
    }
    if (!appPath) {
      throw new CuaHelperError(
        "unavailable",
        "ZCode Computer Use Helper app bundle was not found in any install candidate",
      );
    }
    return appPath;
  }

  async function startNow() {
    if (process.platform !== "darwin") {
      throw new CuaHelperError(
        "unsupported_platform",
        "createProductCuaHelperHost manages the LaunchServices Helper on darwin; " +
          "on Windows use the dev-host runtime (WindowsCuaHelperHost).",
      );
    }
    const appPath = await resolveHelperApp();
    const socketPath = mintBrokerSocketPath({ env });
    await launchHelperApp(appPath, socketPath, env);
    const health = await probeHelperHealth(socketPath, { timeoutMs: healthTimeoutMs });
    handle = {
      socketPath,
      launchSocketPath: socketPath,
      pluginAuthority,
      helperAppPath: appPath,
      bundleId: health.bundleId,
      pid: health.pid,
    };
    return handle;
  }

  async function stopNow() {
    const current = handle;
    handle = null;
    if (!current?.pid) return;
    try {
      process.kill(current.pid, "SIGTERM");
    } catch (error) {
      log("warn", "Computer Use Helper SIGTERM failed", {
        pid: current.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const host = {
    get running() {
      return handle !== null;
    },
    get socketPath() {
      return handle?.socketPath ?? null;
    },
    get pluginAuthority() {
      return handle ? pluginAuthority : null;
    },
    get reservedTransport() {
      return undefined;
    },
    start() {
      if (handle) return Promise.resolve(handle);
      if (startInFlight) return startInFlight;
      const pending = enqueue(startNow).finally(() => {
        if (startInFlight === pending) startInFlight = null;
      });
      startInFlight = pending;
      return pending;
    },
    stop() {
      return enqueue(stopNow);
    },
    restart() {
      return enqueue(async () => {
        await stopNow();
        return startNow();
      });
    },
    restartAfterCurrentStart() {
      return enqueue(async () => {
        if (startInFlight) await startInFlight.catch(() => {});
        await stopNow();
        return startNow();
      });
    },
    async restartAfterCurrentStartPreservingTransport(restartOptions = {}) {
      const previous = handle;
      return enqueue(async () => {
        await stopNow();
        restartOptions.beforeFreshStart?.();
        return { handle: await startNow(), reused: Boolean(previous) };
      });
    },
    async waitForTransport(timeoutMs = healthTimeoutMs) {
      const pending = startInFlight;
      const live = readTransport();
      if (live) return live;
      if (!pending) {
        throw new BrokerError(
          "launch_failed",
          "ZCode Computer Use Helper has no live transport to wait for",
        );
      }
      const started = await waitForCuaHelperStartup(pending, timeoutMs);
      return {
        socketPath: started.socketPath,
        pluginAuthority: started.pluginAuthority,
      };
      function readTransport() {
        const current = handle;
        return current
          ? { socketPath: current.socketPath, pluginAuthority: current.pluginAuthority }
          : undefined;
      }
    },
    async checkHealth(timeoutMs = 1_000) {
      const current = handle;
      if (!current) {
        throw new BrokerError("broker_unavailable", "ZCode Computer Use Helper is not running");
      }
      return probeHelperHealth(current.socketPath, { timeoutMs });
    },
    async queryScreenCaptureProbe() {
      const current = handle;
      if (!current) return { ok: false, reason: "helper_not_running" };
      try {
        const result = await callBrokerMethod({
          socketPath: current.socketPath,
          method: "screen_capture_probe",
          params: {},
          timeoutMs: 5_000,
        });
        return typeof result === "object" && result !== null ? result : { ok: false };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async queryScreenRecordingPreflight() {
      const current = handle;
      if (!current) return undefined;
      try {
        const result = await callBrokerMethod({
          socketPath: current.socketPath,
          method: "screen_capture_status",
          params: {},
          timeoutMs: 5_000,
        });
        const state =
          typeof result === "object" && result !== null
            ? (result.screen_recording ?? result.screenRecording)
            : undefined;
        return state === "granted" || state === "denied" ? state : "unknown";
      } catch {
        return undefined;
      }
    },
    async queryPermissionStatus() {
      const current = handle;
      if (!current) {
        return {
          grant_owner: null,
          accessibility: "unknown",
          screen_recording: "unknown",
        };
      }
      const result = await callBrokerMethod({
        socketPath: current.socketPath,
        method: "permission_status",
        params: {},
        timeoutMs: 5_000,
      });
      return typeof result === "object" && result !== null
        ? result
        : { grant_owner: null, accessibility: "unknown", screen_recording: "unknown" };
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Orphaned Helper reaping (darwin: kill helpers whose launcher died)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orphaned Helper reaping (darwin: kill helpers whose launcher died)
// ---------------------------------------------------------------------------

export async function reapOrphanedHelpers(options = {}) {
  if (process.platform !== "darwin") return;
  const logger = options.logger;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    // 锚定 helper .app 内的真实可执行路径，而不是 app 名子串：pgrep -f 匹配完整
    // 命令行，日志 tail / 编辑器里出现同名文本的无关进程曾被一并误杀。
    const pattern = `${HELPER_APP_NAME.replace(/\.app$/, "")}.app/Contents/MacOS/`;
    const output = await promisify(execFile)("pgrep", ["-fl", pattern], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of output.split("\n")) {
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0], 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
        logger?.info?.(undefined, "reaped orphaned CUA Helper", { pid });
      } catch {
        // already gone
      }
    }
  } catch {
    // pgrep exit 1 = no matches; nothing to reap
  }
}

// ---------------------------------------------------------------------------
// LaunchServices permission requests (darwin only)
// ---------------------------------------------------------------------------

export async function requestHelperAccessibilityPermissionViaLaunchServices(options = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "LaunchServices permission requests are only available on macOS" };
  }
  const appPath = options.appPath ?? options.helperAppPath;
  if (!appPath) return { ok: false, reason: "missing helper app path" };
  try {
    const { promisify } = await import("node:util");
    await promisify(execFile)("/usr/bin/open", ["-g", appPath, "--args", "--request-accessibility"], {
      timeout: 5_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(options = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "LaunchServices permission requests are only available on macOS" };
  }
  const appPath = options.appPath ?? options.helperAppPath;
  if (!appPath) return { ok: false, reason: "missing helper app path" };
  try {
    const { promisify } = await import("node:util");
    await promisify(execFile)(
      "/usr/bin/open",
      ["-g", appPath, "--args", "--request-screen-recording"],
      { timeout: 5_000 },
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Re-export the health probe pieces the server surface also owns.
export { probeHelperHealth, callBrokerMethod, mintBrokerSocketPath, CuaHelperError };
