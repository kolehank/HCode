import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";

/**
 * 凭据主密钥解析（BYOK P2）：
 *
 * 优先级 1：环境变量 ZCODE_CREDENTIAL_SECRET（trim 非空则采用，SHA256 派生 32B AES key）。
 * 优先级 2：OS 凭据设施中的随机主密钥（首次生成 crypto.randomBytes(32) 的 base64 并持久化）：
 *   - Windows：DPAPI（CurrentUser）密文存数据配置目录 credential-master-key.bin，
 *     经 powershell.exe [System.Security.Cryptography.ProtectedData] 读写；
 *   - macOS：security generic password（service: ZCode Credential Master Key）；
 *   - Linux：secret-tool（libsecret），不存在则直接抛错。
 * 优先级 3：无 fallback——keychain 不可用直接抛 credential_master_key_unavailable，
 *   绝不回退到本机信息（platform/homedir/username）推导，避免弱密钥。
 *
 * 注意：本模块属于 @zcode/shared，禁止 import @zcode/services 或 desktop 代码。
 */

const execFileAsync = promisify(execFile);

const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";
const DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
export const CREDENTIAL_MASTER_KEY_UNAVAILABLE_CODE = "credential_master_key_unavailable" as const;

const MASTER_KEY_SEED_BYTES = 32;
const MASTER_KEY_BLOB_FILE_NAME = "credential-master-key.bin";
const MACOS_KEYCHAIN_SERVICE_NAME = "ZCode Credential Master Key";
const EXEC_TIMEOUT_MS = 15_000;

type EnvRecord = Record<string, string | undefined>;

interface KeychainResolutionContext {
  cacheKey: string;
  resolve: () => Promise<Buffer>;
}

const keychainKeyCache = new Map<string, Buffer>();
const pendingKeychainResolutions = new Map<string, Promise<Buffer>>();

export async function resolveCredentialMasterKey(env: EnvRecord = process.env): Promise<Buffer> {
  // 优先级 1：显式 secret 每次直接派生（SHA256 开销可忽略），保证 env 变更立即生效。
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return createHash("sha256").update(configuredSecret).digest();
  }

  // 优先级 2：OS keychain 随机主密钥，进程内缓存避免每条凭据读写都起子进程。
  const context = createKeychainResolutionContext(env);
  const cached = keychainKeyCache.get(context.cacheKey);
  if (cached) {
    return cached;
  }

  const pending = pendingKeychainResolutions.get(context.cacheKey);
  if (pending) {
    return pending;
  }

  const resolution = context
    .resolve()
    .then((key) => {
      keychainKeyCache.set(context.cacheKey, key);
      return key;
    })
    .finally(() => {
      pendingKeychainResolutions.delete(context.cacheKey);
    });
  pendingKeychainResolutions.set(context.cacheKey, resolution);
  return resolution;
}

function createKeychainResolutionContext(env: EnvRecord): KeychainResolutionContext {
  switch (process.platform) {
    case "win32": {
      const blobPath = join(resolveDataConfigDir(env), MASTER_KEY_BLOB_FILE_NAME);
      return { cacheKey: `win32:${blobPath}`, resolve: () => resolveWindowsMasterKey(blobPath) };
    }
    case "darwin":
      return {
        cacheKey: `darwin:${MACOS_KEYCHAIN_SERVICE_NAME}`,
        resolve: () => resolveMacosMasterKey(env),
      };
    case "linux":
      return {
        cacheKey: `linux:secret-tool:master-key:1`,
        resolve: () => resolveLinuxMasterKey(),
      };
    default:
      return {
        cacheKey: `unsupported:${process.platform}`,
        resolve: () =>
          Promise.reject(
            createMasterKeyUnavailableError(
              `unsupported platform "${process.platform}" has no OS keychain integration`,
            ),
          ),
      };
  }
}

// ---------------------------------------------------------------------------
// Windows：DPAPI（PowerShell ProtectedData，CurrentUser scope）
// ---------------------------------------------------------------------------

// blob 文件内容是 DPAPI 密文的 base64 文本，可复用 privateFilePersistence 的原子写 + 0600。
async function resolveWindowsMasterKey(blobPath: string): Promise<Buffer> {
  let existing: string | undefined;
  try {
    existing = (await readFile(blobPath, "utf-8")).trim();
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw createMasterKeyUnavailableError(
        `failed to read master key blob: ${describeError(error)}`,
      );
    }
  }

  if (existing) {
    return seedToAesKey(await dpapiUnprotect(existing));
  }
  return generateWindowsMasterKey(blobPath);
}

async function generateWindowsMasterKey(blobPath: string): Promise<Buffer> {
  // 首次生成存在跨进程竞争（desktop host 与 CLI 同时首启）：文件锁内复查，
  // 避免两个进程各自生成不同主密钥互相覆盖。
  return withFileLock(blobPath, async () => {
    try {
      const existing = (await readFile(blobPath, "utf-8")).trim();
      if (existing) {
        return seedToAesKey(await dpapiUnprotect(existing));
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw createMasterKeyUnavailableError(
          `failed to read master key blob: ${describeError(error)}`,
        );
      }
    }

    const seed = generateMasterKeySeed();
    const protectedText = (await dpapiProtect(seed)).toString("base64");
    await atomicWritePrivateTextFile(blobPath, protectedText);
    return seedToAesKey(seed);
  });
}

function createEncodedPowerShellArgs(script: string, values: readonly string[]): string[] {
  // 与 desktop/scripts/powershell-command.mjs 同思路（shared 包不能 import desktop 代码）：
  // 动态值先 base64(UTF8) 绑定到 $zcodeArgN，再整体 -EncodedCommand(base64 UTF16LE)，
  // 避免空格/引号被 PowerShell 二次解析。
  const valueBindings = values
    .map((value, index) => {
      const encoded = Buffer.from(value, "utf8").toString("base64");
      return `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));`;
    })
    .join("");
  const encodedCommand = Buffer.from(`${valueBindings}${script}`, "utf16le").toString("base64");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand];
}

const POWERSHELL_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "Add-Type -AssemblyName System.Security;",
  "$plain=[Text.Encoding]::UTF8.GetBytes($zcodeArg0);",
  "$protected=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Convert]::ToBase64String($protected));",
].join("");

const POWERSHELL_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "Add-Type -AssemblyName System.Security;",
  "$bytes=[Convert]::FromBase64String($zcodeArg0);",
  "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Console]::Out.Write([Convert]::ToBase64String($plain));",
].join("");

async function runPowerShell(script: string, values: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      createEncodedPowerShellArgs(script, values),
      {
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return stdout.trim();
  } catch (error) {
    throw createMasterKeyUnavailableError(
      `DPAPI PowerShell invocation failed: ${describeError(error)}`,
    );
  }
}

async function dpapiProtect(seed: string): Promise<Buffer> {
  const stdout = await runPowerShell(POWERSHELL_PROTECT_SCRIPT, [seed]);
  const protectedBytes = Buffer.from(stdout, "base64");
  if (protectedBytes.length === 0) {
    throw createMasterKeyUnavailableError("DPAPI protect returned empty output");
  }
  return protectedBytes;
}

async function dpapiUnprotect(protectedText: string): Promise<string> {
  const stdout = await runPowerShell(POWERSHELL_UNPROTECT_SCRIPT, [protectedText]);
  // stdout 是 seed 的 base64；任何错误信息不得包含 seed 本身。
  const seed = Buffer.from(stdout, "base64").toString("utf-8");
  if (!seed) {
    throw createMasterKeyUnavailableError("DPAPI unprotect returned empty output");
  }
  return seed;
}

// ---------------------------------------------------------------------------
// macOS：security generic password
// ---------------------------------------------------------------------------

async function resolveMacosMasterKey(env: EnvRecord): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-w", "-s", MACOS_KEYCHAIN_SERVICE_NAME],
      { encoding: "utf8", timeout: EXEC_TIMEOUT_MS },
    );
    return seedToAesKey(stdout.trim());
  } catch (error) {
    if (!isMacosKeychainItemNotFound(error)) {
      throw createMasterKeyUnavailableError(
        `macOS keychain lookup failed: ${describeError(error)}`,
      );
    }
  }

  const seed = generateMasterKeySeed();
  const account = resolveMacosAccountName(env);
  try {
    // -U：已存在同 service/account 条目时更新，保证幂等。
    await execFileAsync(
      "security",
      ["add-generic-password", "-U", "-a", account, "-s", MACOS_KEYCHAIN_SERVICE_NAME, "-w", seed],
      { encoding: "utf8", timeout: EXEC_TIMEOUT_MS },
    );
  } catch (error) {
    throw createMasterKeyUnavailableError(`macOS keychain store failed: ${describeError(error)}`);
  }
  return seedToAesKey(seed);
}

function isMacosKeychainItemNotFound(error: unknown): boolean {
  // security 退出码 44 = errSecItemNotFound；兼容 stderr 文本判断。
  if (getErrorCode(error) === "44") {
    return true;
  }
  const stderr = getExecStderr(error);
  return /could not be found|was not found/i.test(stderr);
}

function resolveMacosAccountName(env: EnvRecord): string {
  const fromEnv = env.USER?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return userInfo().username || "zcode";
  } catch {
    return "zcode";
  }
}

// ---------------------------------------------------------------------------
// Linux：secret-tool（libsecret）
// ---------------------------------------------------------------------------

// 说明：secret-tool 没有 --clear 选项（设计稿中的 `--clear=zk` 参数无效），
// 这里按合法语法使用属性对 master-key=1 存取。
const LINUX_SECRET_TOOL_ATTRS = ["master-key", "1"] as const;

async function resolveLinuxMasterKey(): Promise<Buffer> {
  let lookupOutput: string;
  try {
    const { stdout } = await execFileAsync("secret-tool", ["lookup", ...LINUX_SECRET_TOOL_ATTRS], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
    });
    lookupOutput = stdout.trim();
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createMasterKeyUnavailableError(
        "secret-tool (libsecret) is not installed; install libsecret-tools to store credential master key",
      );
    }
    // 部分版本未命中时以非零退出；输出为空则按未存储处理，交给 store 兜底。
    const stderr = getExecStderr(error);
    if (!stderr) {
      lookupOutput = "";
    } else {
      throw createMasterKeyUnavailableError(
        `Linux secret-tool lookup failed: ${describeError(error)}`,
      );
    }
  }

  if (lookupOutput) {
    return seedToAesKey(lookupOutput);
  }

  const seed = generateMasterKeySeed();
  try {
    // secret-tool 从 stdin 读取密码；不带换行，避免把换行存进 secret。
    await runCommandWithStdin(
      "secret-tool",
      ["store", "--label=ZCode Credential Master Key", ...LINUX_SECRET_TOOL_ATTRS],
      seed,
    );
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createMasterKeyUnavailableError(
        "secret-tool (libsecret) is not installed; install libsecret-tools to store credential master key",
      );
    }
    throw createMasterKeyUnavailableError(
      `Linux secret-tool store failed: ${describeError(error)}`,
    );
  }
  return seedToAesKey(seed);
}

// ---------------------------------------------------------------------------
// 公共 helper
// ---------------------------------------------------------------------------

function generateMasterKeySeed(): string {
  const raw = randomBytes(MASTER_KEY_SEED_BYTES);
  const seed = raw.toString("base64");
  raw.fill(0);
  return seed;
}

function seedToAesKey(seed: string): Buffer {
  const key = Buffer.from(seed, "base64");
  if (key.length !== MASTER_KEY_SEED_BYTES) {
    throw createMasterKeyUnavailableError("stored credential master key seed is corrupt");
  }
  return key;
}

function resolveDataConfigDir(env: EnvRecord): string {
  return join(resolveBaseDir(env), ".zcode", "v2");
}

function resolveBaseDir(env: EnvRecord): string {
  // 与 credentials.json 的目录解析保持同一规则：ZCODE_DATA_BASE_DIR 优先（兼容 ~ 展开），否则 homedir。
  const raw = env[DATA_BASE_DIR_ENV_KEY]?.trim();
  if (!raw) {
    return homedir();
  }
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

/**
 * 带 stdin 输入的子进程执行（secret-tool store 需要）。错误形状与 execFile 一致：
 * 退出码放 code、诊断放 stderr；stdout 可能包含查询到的 seed，不进错误信息。
 */
function runCommandWithStdin(
  file: string,
  args: readonly string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      reject(
        Object.assign(new Error(`${file} exited with ${exitCode ?? "signal"}`), {
          code: exitCode,
          stderr,
        }),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return code === undefined || code === null ? undefined : String(code);
}

function getExecStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return "";
  }
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr.trim() : "";
}

/**
 * 汇总子进程错误为可展示文本。
 * 红线：stdout 可能包含查询到的主密钥 seed，一律不进入错误信息；stderr 截断防刷屏。
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  const code = getErrorCode(error);
  if (code !== undefined) {
    parts.push(`exit=${code}`);
  }
  const stderr = getExecStderr(error);
  if (stderr) {
    parts.push(stderr.replace(/\s+/g, " ").slice(0, 200));
  }
  if (parts.length === 0) {
    parts.push(
      error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "unknown error",
    );
  }
  return parts.join(" ");
}

function createMasterKeyUnavailableError(reason: string): Error {
  return Object.assign(new Error(`credential master key unavailable: ${reason}`), {
    code: CREDENTIAL_MASTER_KEY_UNAVAILABLE_CODE,
  });
}
