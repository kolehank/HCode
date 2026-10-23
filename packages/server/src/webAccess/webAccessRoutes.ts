/* BYOK P3：web 远程访问配置与网卡枚举 API。写接口受当前档位鉴权保护；open 档仅允许 loopback 来源。 */
import { networkInterfaces } from "node:os";
import { Hono } from "hono";
import { createServiceLogger } from "@zcode/services/node";
import { formatZodError } from "@zcode/shared";
import {
  generateWebAccessToken,
  loadWebAccessConfig,
  sanitizeWebAccessConfig,
  updateWebAccessConfig,
  webAccessUpdateSchema,
  type WebAccessConfig,
} from "./webAccessConfig.js";
import { getRequestRemoteAddress, isLoopbackRemoteAddress } from "./webAccessMiddleware.js";

const logger = createServiceLogger("webAccessRoutes");

export interface WebAccessRouteOptions {
  /** server 启动时快照：决定写接口在 open 档是否强制 loopback。 */
  startupConfig: WebAccessConfig;
  /** 供 UI 拼接 `http://<ip>:<port>` 建议链接。 */
  port: number;
}

export interface WebAccessInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  isTailscale: boolean;
  suggested: boolean;
}

// docker0 / veth* / vEthernet(WSL) / Hyper-V / VMware / VirtualBox / ve- 等虚拟网卡不进入候选。
const VIRTUAL_INTERFACE_NAME_PATTERN = /^(docker|br-|veth|vethernet|wsl|hyper-v|vmware|virtualbox|ve-)/i;

function isTailscaleIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  return (
    parts.length === 4 &&
    parts[0] === 100 &&
    (parts[1] ?? -1) >= 64 &&
    (parts[1] ?? -1) <= 127 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }
  const [first, second] = parts;
  if (first === 10) return true;
  if (first === 172 && (second ?? -1) >= 16 && (second ?? -1) <= 31) return true;
  return first === 192 && second === 168;
}

/**
 * 枚举可直连的网卡地址。默认路由优先级没有跨平台免依赖做法，这里用
 * tailscale（100.64/10）> 私网 IPv4 > 全局 IPv6 的确定性排序代替，并把建议值
 * 回显给 UI 让用户可见可编辑，猜错不会静默生效。
 */
export function listWebAccessInterfaces(): WebAccessInterfaceInfo[] {
  const candidates: WebAccessInterfaceInfo[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE_NAME_PATTERN.test(name)) {
      continue;
    }
    for (const info of addresses ?? []) {
      // Node 25 类型里 family 已是 "IPv4" | "IPv6" 字符串。
      const family = info.family === "IPv4" ? "IPv4" : "IPv6";
      if (info.internal) {
        continue;
      }
      if (family === "IPv4" && info.address.startsWith("169.254.")) {
        continue;
      }
      if (family === "IPv6" && info.address.toLowerCase().startsWith("fe80")) {
        continue;
      }
      candidates.push({
        name,
        address: info.address,
        family,
        isTailscale: isTailscaleIpv4(info.address),
        suggested: false,
      });
    }
  }

  const suggested =
    candidates.find((candidate) => candidate.isTailscale) ??
    candidates.find((candidate) => candidate.family === "IPv4" && isPrivateIpv4(candidate.address)) ??
    candidates.find((candidate) => candidate.family === "IPv4") ??
    candidates[0];
  if (suggested) {
    suggested.suggested = true;
  }
  return candidates;
}

function isRequestBodyAllowed(options: WebAccessRouteOptions, remoteAddress: string | undefined): boolean {
  // token / cloudflare-access 档已由全局中间件鉴权；open 档（含 legacy env token 未配置时）
  // 配置写接口与网卡探测只允许本机回环访问，防止未认证请求改配置或扫内网拓扑。
  if (options.startupConfig.mode !== "open") {
    return true;
  }
  return isLoopbackRemoteAddress(remoteAddress);
}

function buildAccessUrl(externalBaseUrl: string, token: string): string | undefined {
  const trimmed = externalBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return undefined;
  }
  return `${trimmed}/#token=${token}`;
}

export function registerWebAccessRoutes(app: Hono, options: WebAccessRouteOptions): void {
  const requireLoopbackInOpenMode = async (
    remoteAddress: string | undefined,
  ): Promise<boolean> => isRequestBodyAllowed(options, remoteAddress);

  app.get("/api/web-access/config", async (c) => {
    if (!(await requireLoopbackInOpenMode(getRequestRemoteAddress(c)))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const config = await loadWebAccessConfig();
    return c.json({ ...sanitizeWebAccessConfig(config), port: options.port });
  });

  app.put("/api/web-access/config", async (c) => {
    if (!(await requireLoopbackInOpenMode(getRequestRemoteAddress(c)))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = webAccessUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsed.error)}` }, 400);
    }
    const body = parsed.data;

    if (body.mode === "cloudflare-access") {
      if (!body.cfTeamDomain.trim() || !body.cfAud.trim()) {
        return c.json({ error: "cloudflare-access requires cfTeamDomain and cfAud" }, 400);
      }
      if (/\/|^https?:/i.test(body.cfTeamDomain.trim())) {
        return c.json({ error: "cfTeamDomain must be a bare hostname" }, 400);
      }
    }
    if (body.externalBaseUrl.trim() && !/^https?:\/\//i.test(body.externalBaseUrl.trim())) {
      return c.json({ error: "externalBaseUrl must start with http:// or https://" }, 400);
    }

    // token 档没有可用 token，或显式 regenerate：生成新 token（旧 token 在重启后失效），
    // 明文只在本次响应返回一次，文件与日志只保留 hash/前缀。
    let generated: { token: string; tokenHash: string; tokenPrefix: string } | undefined;
    if (body.mode === "token") {
      let existing: WebAccessConfig;
      try {
        existing = await loadWebAccessConfig();
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
      if (body.regenerate || !existing.tokenHash) {
        generated = generateWebAccessToken();
      }
    }

    try {
      const next = await updateWebAccessConfig((current) => ({
        ...current,
        mode: body.mode,
        cfTeamDomain: body.cfTeamDomain.trim(),
        cfAud: body.cfAud.trim(),
        cfAllowedEmails: body.cfAllowedEmails.map((email) => email.trim()).filter(Boolean),
        externalBaseUrl: body.externalBaseUrl.trim(),
        ...(generated
          ? { tokenHash: generated.tokenHash, tokenPrefix: generated.tokenPrefix }
          : {}),
      }));
      logger.info(undefined, "web access config updated", {
        mode: next.mode,
        tokenPrefix: next.tokenPrefix,
        tokenRegenerated: Boolean(generated),
      });
      return c.json({
        ...sanitizeWebAccessConfig(next),
        port: options.port,
        ...(generated
          ? {
              token: generated.token,
              accessUrl: buildAccessUrl(next.externalBaseUrl, generated.token),
            }
          : {}),
      });
    } catch (error) {
      logger.error(undefined, "failed to persist web access config", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/web-access/interfaces", async (c) => {
    if (!(await requireLoopbackInOpenMode(getRequestRemoteAddress(c)))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json({ interfaces: listWebAccessInterfaces(), port: options.port });
  });
}
