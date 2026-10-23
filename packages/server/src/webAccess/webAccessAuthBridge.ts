// BYOK：web 远程访问的鉴权核心（server 与 desktop 内嵌入口共用的纯函数层）。
// 三档语义：open（无应用层鉴权）/ cloudflare-access（CF JWT 验签）/ token（常量时间 hash 比较）。
// token 档取值：HTTP 用 Authorization Bearer；浏览器 WS 无法自定义头，`/ws*` 允许 query `?token=`。
import type { WebAccessConfig } from "./webAccessConfig.js";
import { tokenMatchesHash } from "./webAccessConfig.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface WebAccessRequestLike {
  /** 含 query 的路径（如 "/ws?token=..."）；HTTP 侧用 req.url。 */
  url: string;
  headers: Record<string, string | undefined>;
  remoteAddress?: string;
}

export type WebAccessAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 500; detail: string };

/** `/ws*`（含升级）与 `/api/*` 必须鉴权；静态资源（index.html/asset）放行——token 在连接层校验。 */
export function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function extractAccessToken(request: WebAccessRequestLike): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const value = authorization.slice("Bearer ".length).trim();
    if (value) return value;
  }
  if (request.url === "/ws" || request.url.startsWith("/ws?") || request.url.startsWith("/ws/")) {
    const queryToken = new URL(`https://local${request.url}`).searchParams.get("token");
    if (queryToken) return queryToken;
  }
  return null;
}

/**
 * Host 头（"127.0.0.1:30330" / "[::1]:x" / "example.com"）的 hostname 是否 loopback。
 * 仅用于 open 档：open 档监听器被 resolveWebBindHost 强制绑回环，Host 指向其它域名
 * 即 DNS rebinding 特征。token/CF 档不适用——LAN IP、自有域名是合法访问形态。
 */
export function isLoopbackWsHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname = hostHeader;
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end === -1) return false;
    hostname = hostHeader.slice(0, end + 1);
  } else {
    const colon = hostHeader.lastIndexOf(":");
    if (colon !== -1) hostname = hostHeader.slice(0, colon);
  }
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

/**
 * WS 升级 / 浏览器请求的 Origin 校验（浏览器必带且不可伪造 Origin；curl 等非浏览器
 * 客户端通常缺失）。规则：
 * - Origin 缺失 → 非浏览器客户端，放行（token/CF 档仍需凭据，open 档由 Host 校验兜底）；
 * - 与请求 Host 同源（http(s)://<Host>）或与 externalBaseUrl 的 origin 相等 → 放行；
 * - 其余（含 file:// 的 "null"、无法 parse、非 http(s) 协议）→ 拒绝。
 * 与 isLoopbackWsHostHeader 组合封死 CSWSH 与 DNS rebinding：rebinding 页面的
 * Host 已被 open 档 Host 校验拒绝，跨源页面的 Origin 与 Host 不同源。
 */
export function isAllowedWsOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  externalBaseUrl: string | undefined,
): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const external = externalBaseUrl?.trim();
  if (external) {
    try {
      if (parsed.origin === new URL(external).origin) return true;
    } catch {
      // externalBaseUrl 配置损坏时不放行外部源，落回同源判定。
    }
  }
  if (!requestHost) return false;
  return parsed.origin === `http://${requestHost}` || parsed.origin === `https://${requestHost}`;
}

const JWKS_REFRESH_INTERVAL_MS = 3_600_000;

interface CfJwksCache {
  teamDomain: string;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  createdAt: number;
}

const cfJwksCache: CfJwksCache = { teamDomain: "", jwks: null, createdAt: 0 };

function getCfJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  if (
    !cfJwksCache.jwks ||
    cfJwksCache.teamDomain !== teamDomain ||
    now - cfJwksCache.createdAt >= JWKS_REFRESH_INTERVAL_MS
  ) {
    cfJwksCache.jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    cfJwksCache.teamDomain = teamDomain;
    cfJwksCache.createdAt = now;
  }
  return cfJwksCache.jwks;
}

export type CfVerifyResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 500; detail: string };

/**
 * email allowlist 匹配（纯函数，便于单测空串边界）。
 * 空候选跳过：allowlist 混入 "" 会把「无 email claim 的合法 JWT」（email 视为 ""）放行。
 */
export function isEmailAllowlisted(
  payloadEmail: string | undefined,
  allowedEmails: readonly string[],
): boolean {
  const email = (payloadEmail ?? "").toLowerCase();
  return allowedEmails.some((candidate) => {
    const normalized = candidate.trim().toLowerCase();
    return normalized.length > 0 && normalized === email;
  });
}

/** CF Access JWT 验签核心：JWT 原文不进日志，只记结果与原因摘要。 */
export async function verifyCloudflareAccessJwt(
  jwt: string | undefined,
  config: WebAccessConfig,
): Promise<CfVerifyResult> {
  const token = jwt?.trim();
  if (!token) {
    return { ok: false, status: 401, detail: "missing Cf-Access-Jwt-Assertion header" };
  }
  if (!config.cfTeamDomain || !config.cfAud) {
    return {
      ok: false,
      status: 500,
      detail: "cloudflare-access mode requires cfTeamDomain and cfAud",
    };
  }
  try {
    // CF Access 现行文档为 RS256，旧租户/密钥类型存在 ES256；白名单两种，
    // 钉死单一算法会把 RS256 租户 fail-closed 全量拒绝且难以排查。
    const { payload } = await jwtVerify(token, getCfJwks(config.cfTeamDomain), {
      issuer: `https://${config.cfTeamDomain}`,
      audience: config.cfAud,
      algorithms: ["RS256", "ES256"],
    });
    if (config.cfAllowedEmails.length > 0 && !isEmailAllowlisted(
      typeof payload["email"] === "string" ? payload["email"] : undefined,
      config.cfAllowedEmails,
    )) {
      return { ok: false, status: 403, detail: "email not in allowlist" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 401,
      detail: error instanceof Error ? error.message : "invalid access jwt",
    };
  }
}

/** token/CF 两档的同步判定入口；CF 档的异步验签请走 verifyCloudflareAccessJwt。 */
export function authorizeRequest(
  request: WebAccessRequestLike,
  config: WebAccessConfig,
): WebAccessAuthResult {
  switch (config.mode) {
    case "token": {
      const token = extractAccessToken(request);
      if (token && config.tokenHash && tokenMatchesHash(token, config.tokenHash)) {
        return { ok: true };
      }
      return { ok: false, status: 401, detail: "invalid or missing token" };
    }
    case "cloudflare-access":
      // CF 档的验签是异步的，由调用方（server）显式走 verifyCloudflareAccessJwt。
      return { ok: false, status: 401, detail: "cloudflare-access requires async verification" };
    default:
      return { ok: true };
  }
}
