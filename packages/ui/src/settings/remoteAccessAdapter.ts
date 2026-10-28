/* BYOK P3/A2：「远程访问」设置区块的数据源 adapter。
 * 同一份 load/save 语义，两套实现：
 * - web：server 形态 HTTP API（fetchWithWebAccessToken + /api/web-access/*）；
 * - desktop：main 内嵌远程访问入口的 IPC（IPlatformService.webRemoteAccess）。
 * 组件内部状态机只面向 adapter，不感知 IPC 与 HTTP 的差异。 */
import { fetchWithWebAccessToken } from "@/lib/webAccessToken.js";
import type { IPlatformService, QuickTunnelStatus } from "@zcode/shared";

export type WebAccessMode = "open" | "cloudflare-access" | "token";

export interface WebAccessConfigView {
  mode: WebAccessMode;
  tokenPrefix: string;
  hasToken: boolean;
  cfTeamDomain: string;
  cfAud: string;
  cfAllowedEmails: string[];
  externalBaseUrl: string;
  port: number;
  /** 临时公网通道开关（desktop-only；web 形态恒 false）。 */
  quickTunnelEnabled: boolean;
}

export interface WebAccessInterfaceItem {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  isTailscale: boolean;
  suggested: boolean;
}

interface WebAccessSaveResponse extends WebAccessConfigView {
  token?: string;
  accessUrl?: string | null;
}

export interface RemoteAccessLoadResult {
  config: WebAccessConfigView;
  interfaces: WebAccessInterfaceItem[];
  /** 仅桌面 adapter 返回：desktopEnabled 开关当前值。 */
  desktopEnabled?: boolean;
  /** 仅桌面 adapter 返回：web 前端静态资源是否已随包就绪。 */
  webStaticConfigured?: boolean;
  /** 仅桌面 adapter 返回：临时公网通道状态（URL 仅本进程内存，不落盘）。 */
  tunnel?: QuickTunnelStatus;
  /**
   * 仅桌面 adapter 返回：token 档的完整访问链接（含明文 token + device，回退链已按
   * 当前通道地址取基）。只经 IPC：不落盘、不出任何 HTTP 响应；应用重启后为空。
   */
  accessUrl?: string;
}

export interface RemoteAccessSavePayload {
  mode: WebAccessMode;
  cfTeamDomain: string;
  cfAud: string;
  cfAllowedEmails: string[];
  externalBaseUrl: string;
  regenerate: boolean;
  /** 仅桌面 adapter 携带。 */
  desktopEnabled?: boolean;
  /** 仅桌面 adapter 携带；open/CF 档由 main 归一化为 false。 */
  quickTunnelEnabled?: boolean;
}

export interface RemoteAccessSaveResult {
  tokenPrefix: string;
  hasToken: boolean;
  token?: string;
  accessUrl?: string;
  /** 保存后内嵌入口的实际监听端口（desktop 保存即时重建监听后非 0；web 形态沿用 load 值）。 */
  port?: number;
  /** 仅桌面 adapter 返回：保存后的通道状态。 */
  tunnel?: QuickTunnelStatus;
  /** 保存后生效的通道开关（main 会把 open/CF 档下的请求归一化为 false）。 */
  quickTunnelEnabled?: boolean;
}

export interface RemoteAccessAdapter {
  load(): Promise<RemoteAccessLoadResult>;
  save(payload: RemoteAccessSavePayload): Promise<RemoteAccessSaveResult>;
}

/** 通道重启后只换域名：保留原链接的 #token=&device= 片段，避免展示已失效的旧公网地址。 */
export function rebaseAccessUrl(accessUrl: string, baseUrl: string): string {
  const hashIndex = accessUrl.indexOf("#");
  return hashIndex >= 0 ? `${baseUrl}${accessUrl.slice(hashIndex)}` : accessUrl;
}

export function createWebRemoteAccessAdapter(): RemoteAccessAdapter {
  return {
    async load() {
      const [configResponse, interfacesResponse] = await Promise.all([
        fetchWithWebAccessToken("/api/web-access/config", { cache: "no-store" }),
        fetchWithWebAccessToken("/api/web-access/interfaces", { cache: "no-store" }),
      ]);
      if (!configResponse.ok || !interfacesResponse.ok) {
        throw new Error(`HTTP ${configResponse.status}/${interfacesResponse.status}`);
      }
      const config = (await configResponse.json()) as WebAccessConfigView;
      const interfacesPayload = (await interfacesResponse.json()) as {
        interfaces: WebAccessInterfaceItem[];
        port: number;
      };
      return {
        config: {
          ...config,
          port: interfacesPayload.port || config.port,
          quickTunnelEnabled: config.quickTunnelEnabled ?? false,
        },
        interfaces: interfacesPayload.interfaces ?? [],
        tunnel: { state: "disabled" },
      };
    },
    async save(payload) {
      const response = await fetchWithWebAccessToken("/api/web-access/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as WebAccessSaveResponse & { error?: string };
      if (!response.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      return {
        tokenPrefix: result.tokenPrefix,
        hasToken: result.hasToken,
        ...(result.token ? { token: result.token } : {}),
        ...(result.accessUrl ? { accessUrl: result.accessUrl } : {}),
        ...(result.port ? { port: result.port } : {}),
        quickTunnelEnabled: result.quickTunnelEnabled,
      };
    },
  };
}

type DesktopWebRemoteAccessBridge = NonNullable<IPlatformService["webRemoteAccess"]>;

export function createDesktopRemoteAccessAdapter(
  bridge: DesktopWebRemoteAccessBridge,
): RemoteAccessAdapter {
  return {
    async load() {
      const snapshot = await bridge.getConfig();
      const { status } = snapshot;
      return {
        config: {
          mode: status.mode,
          tokenPrefix: status.tokenPrefix,
          hasToken: status.hasToken,
          cfTeamDomain: status.cfTeamDomain,
          cfAud: status.cfAud,
          cfAllowedEmails: status.cfAllowedEmails,
          externalBaseUrl: status.externalBaseUrl,
          port: status.port ?? 0,
          quickTunnelEnabled: status.quickTunnelEnabled,
        },
        interfaces: snapshot.interfaces,
        desktopEnabled: status.enabled,
        webStaticConfigured: snapshot.webStaticConfigured,
        tunnel: status.tunnel,
        ...(snapshot.accessUrl ? { accessUrl: snapshot.accessUrl } : {}),
      };
    },
    async save(payload) {
      const result = await bridge.saveConfig({
        mode: payload.mode,
        cfTeamDomain: payload.cfTeamDomain,
        cfAud: payload.cfAud,
        cfAllowedEmails: payload.cfAllowedEmails,
        externalBaseUrl: payload.externalBaseUrl,
        regenerate: payload.regenerate,
        desktopEnabled: payload.desktopEnabled,
        ...(payload.quickTunnelEnabled !== undefined
          ? { quickTunnelEnabled: payload.quickTunnelEnabled }
          : {}),
      });
      return {
        tokenPrefix: result.status.tokenPrefix,
        hasToken: result.status.hasToken,
        // 保存即时重建监听后的实际端口回传 UI（未运行时 status.port 为 undefined）。
        ...(result.status.port ? { port: result.status.port } : {}),
        ...(result.token ? { token: result.token } : {}),
        ...(result.accessUrl ? { accessUrl: result.accessUrl } : {}),
        tunnel: result.status.tunnel,
        quickTunnelEnabled: result.status.quickTunnelEnabled,
      };
    },
  };
}
