/* BYOK P3：三档 web 远程访问鉴权。open 无应用层鉴权、cloudflare-access 验 CF JWT、token 验静态 Bearer。
   鉴权纯函数单一来源是 webAccessAuthBridge：这里只保留 hono Context 适配（取头/写响应），
   不复制 JWT 验签、JWKS 缓存、token 比对等实现——两份实现已出现过 trim 行为漂移。 */
import type { Context, MiddlewareHandler } from "hono";
import { createServiceLogger } from "@zcode/services/node";
import { tokenMatchesHash, type WebAccessConfig } from "./webAccessConfig.js";
import {
  isAllowedWsOrigin,
  isLoopbackWsHostHeader,
  isLoopbackRemoteAddress,
  isTokenProtectedPath,
  verifyCloudflareAccessJwt,
} from "./webAccessAuthBridge.js";

// 兼容既有内部引用（http.ts / webAccessRoutes.ts 自本模块导入）；实现已收敛到 authBridge。
export { isTokenProtectedPath, isLoopbackRemoteAddress } from "./webAccessAuthBridge.js";

const logger = createServiceLogger("webAccess");

export function getRequestRemoteAddress(c: Context): string | undefined {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress;
}
/** token 档取值：HTTP API 用 Authorization Bearer；浏览器 WS 无法自定义头，`/ws*` 允许 query `?token=`。 */
function extractAccessToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const value = header.slice("Bearer ".length).trim();
    if (value) {
      return value;
    }
  }
  const url = new URL(c.req.url);
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
    const queryToken = url.searchParams.get("token");
    if (queryToken) {
      return queryToken;
    }
  }
  return null;
}

/**
 * 浏览器来源校验（CSWSH / DNS rebinding 防线），语义见 docs/specs/web-remote-access.md：
 * - Origin 头存在时必须与 Host 同源或等于 externalBaseUrl 的 origin（三档生效）；
 * - Host 校验仅 open 档（监听器强制回环，Host 指向其它域名即 rebinding 特征）；
 *   token/CF 档 Host 可为 LAN IP / 自有域名，是合法访问形态。
 * 返回 null 表示通过，否则为拒绝原因（用于 warn 日志）。
 */
function rejectBrowserGuardReason(c: Context, config: WebAccessConfig): string | null {
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  if (config.mode === "open" && !isLoopbackWsHostHeader(host)) {
    return `host header is not loopback in open mode: ${host ?? "(missing)"}`;
  }
  if (!isAllowedWsOrigin(origin ?? undefined, host ?? undefined, config.externalBaseUrl)) {
    return `cross-origin browser request rejected: origin=${origin} host=${host}`;
  }
  return null;
}

/**
 * 启动时快照生效：运行中改动配置文件不改变当前鉴权行为，重启 server 后生效（v1 语义，热轮换后置）。
 * token 档未配置 tokenHash 时全部拒绝，避免「以为有鉴权其实裸奔」。
 */
export function createWebAccessMiddleware(config: WebAccessConfig): MiddlewareHandler {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (!isTokenProtectedPath(pathname)) {
      await next();
      return;
    }
    const guardReason = rejectBrowserGuardReason(c, config);
    if (guardReason) {
      logger.warn(undefined, "web access browser guard rejected request", {
        detail: guardReason,
        pathname,
      });
      return c.json({ error: "Forbidden" }, 403);
    }
    switch (config.mode) {
      case "open": {
        await next();
        return;
      }
      case "token": {
        const token = extractAccessToken(c);
        if (token && tokenMatchesHash(token, config.tokenHash)) {
          await next();
          return;
        }
        return c.json({ error: "Unauthorized" }, 401);
      }
      case "cloudflare-access": {
        const result = await verifyCloudflareAccessJwt(
          c.req.header("Cf-Access-Jwt-Assertion"),
          config,
        );
        if (result.ok) {
          await next();
          return;
        }
        logger.warn(undefined, "cloudflare access rejected request", {
          status: result.status,
          detail: result.detail,
          pathname,
        });
        return c.json({ error: "Unauthorized" }, result.status);
      }
    }
  };
}
