/* BYOK P3：web 远程访问三档配置的持久化。文件是配置唯一所有者，运行时鉴权只读启动快照。 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
} from "@zcode/shared/node";
import { getAppConfigDir } from "@zcode/services/node";
import { formatZodError } from "@zcode/shared";
import { createServiceLogger } from "@zcode/services/node";
import { z } from "zod";

const logger = createServiceLogger("webAccessConfig");

export const WEB_ACCESS_MODES = ["open", "cloudflare-access", "token"] as const;
export type WebAccessMode = (typeof WEB_ACCESS_MODES)[number];

export interface WebAccessConfig {
  schemaVersion: number;
  mode: WebAccessMode;
  /** BYOK A2：桌面内嵌远程访问入口的启用开关（默认关闭；server 形态不读取此字段）。 */
  desktopEnabled: boolean;
  /** SHA-256 hex；明文 token 永不落盘。 */
  tokenHash: string;
  tokenPrefix: string;
  cfTeamDomain: string;
  cfAud: string;
  cfAllowedEmails: string[];
  externalBaseUrl: string;
}

const webAccessFileSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(WEB_ACCESS_MODES),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/).or(z.literal("")).default(""),
  tokenPrefix: z.string().max(32).default(""),
  cfTeamDomain: z.string().max(253).default(""),
  cfAud: z.string().max(256).default(""),
  cfAllowedEmails: z.array(z.string().max(320)).max(1000).default([]),
  externalBaseUrl: z.string().max(2048).default(""),
  desktopEnabled: z.boolean().default(false),
});

/** 宽松的 PUT 入参 schema：允许省略的字段落到默认值，再由路由层做跨字段校验。 */
export const webAccessUpdateSchema = z.object({
  mode: z.enum(WEB_ACCESS_MODES),
  cfTeamDomain: z.string().max(253).default(""),
  cfAud: z.string().max(256).default(""),
  cfAllowedEmails: z.array(z.string().max(320)).max(1000).default([]),
  externalBaseUrl: z.string().max(2048).default(""),
  desktopEnabled: z.boolean().optional(),
  regenerate: z.boolean().default(false),
});
export type WebAccessUpdateInput = z.infer<typeof webAccessUpdateSchema>;

export function getDefaultWebAccessConfig(): WebAccessConfig {
  return {
    schemaVersion: 1,
    mode: "open",
    tokenHash: "",
    tokenPrefix: "",
    cfTeamDomain: "",
    cfAud: "",
    cfAllowedEmails: [],
    externalBaseUrl: "",
    desktopEnabled: false,
  };
}

function getWebAccessFilePath(): string {
  return join(getAppConfigDir(), "web-access.json");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

/** token 明文只在生成时刻返回给调用方一次；文件里只保留 hash 与前缀。 */
export function generateWebAccessToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256Hex(token), tokenPrefix: token.slice(0, 8) };
}

export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  if (!tokenHash) {
    return false;
  }
  const expected = Buffer.from(tokenHash, "hex");
  const actual = createHash("sha256").update(token, "utf-8").digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

export interface WebBindResolution {
  host?: string;
  /** true 表示用户配置了非回环 bind，被 open 档安全约束覆盖。 */
  forcedLoopback: boolean;
}

/**
 * bind 解析：默认 127.0.0.1；open 档（且未配置 legacy env token 兜底）不允许非回环 bind，
 * 覆盖为 127.0.0.1 并由调用方告警——固化「无鉴权 + 非回环」不可组合的约束。
 */
export function resolveWebBindHost(
  config: WebAccessConfig,
  configuredHost: string,
  legacyAuthTokenConfigured: boolean,
): WebBindResolution {
  const trimmed = configuredHost.trim();
  if (!trimmed || isLoopbackHost(trimmed)) {
    return { host: trimmed || "127.0.0.1", forcedLoopback: false };
  }
  if (config.mode === "open" && !legacyAuthTokenConfigured) {
    return { host: "127.0.0.1", forcedLoopback: true };
  }
  return { host: trimmed, forcedLoopback: false };
}

async function readWebAccessFile(filePath: string): Promise<WebAccessConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return getDefaultWebAccessConfig();
    }
    throw new Error(`Unable to read web access config: ${filePath}`, { cause: error });
  }

  try {
    const parsed = webAccessFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(formatZodError(parsed.error));
    }
    return parsed.data;
  } catch (error) {
    // 与 credentialService.readAll 相同语义：损坏文件先备份留证，再拒绝继续，
    // 绝不静默覆盖（否则一次坏写就可能把远程访问门户大开或永久锁死）。
    const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
    logger.warn(undefined, "read failed; refusing to overwrite corrupt web access config", {
      backupPath,
      filePath,
    });
    throw new Error(`Web access config is corrupt: ${filePath}`, { cause: error });
  }
}

export async function loadWebAccessConfig(): Promise<WebAccessConfig> {
  return readWebAccessFile(getWebAccessFilePath());
}

export async function updateWebAccessConfig(
  apply: (current: WebAccessConfig) => WebAccessConfig,
): Promise<WebAccessConfig> {
  const filePath = getWebAccessFilePath();
  return withFileLock(filePath, async () => {
    const current = await readWebAccessFile(filePath);
    const next = webAccessFileSchema.parse(apply(current));
    await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

/** GET 响应视图：tokenHash 永不出 API，只回前缀与存在性。 */
export function sanitizeWebAccessConfig(config: WebAccessConfig): {
  schemaVersion: number;
  mode: WebAccessMode;
  tokenPrefix: string;
  hasToken: boolean;
  cfTeamDomain: string;
  cfAud: string;
  cfAllowedEmails: string[];
  externalBaseUrl: string;
  desktopEnabled: boolean;
} {
  return {
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    tokenPrefix: config.tokenPrefix,
    hasToken: Boolean(config.tokenHash),
    cfTeamDomain: config.cfTeamDomain,
    cfAud: config.cfAud,
    cfAllowedEmails: config.cfAllowedEmails,
    externalBaseUrl: config.externalBaseUrl,
    desktopEnabled: config.desktopEnabled,
  };
}
