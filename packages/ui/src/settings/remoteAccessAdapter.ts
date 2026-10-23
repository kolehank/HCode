/* BYOK P3/A2：「远程访问」设置区块的数据源 adapter。
 * 同一份 load/save 语义，两套实现：
 * - web：server 形态 HTTP API（fetchWithWebAccessToken + /api/web-access/*）；
 * - desktop：main 内嵌远程访问入口的 IPC（IPlatformService.webRemoteAccess）。
 * 组件内部状态机只面向 adapter，不感知 IPC 与 HTTP 的差异。 */
import { fetchWithWebAccessToken } from "@/lib/webAccessToken.js";
import type { IPlatformService } from "@zcode/shared";

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
}

export interface RemoteAccessSaveResult {
  tokenPrefix: string;
  hasToken: boolean;
  token?: string;
  accessUrl?: string;
}

export interface RemoteAccessAdapter {
  load(): Promise<RemoteAccessLoadResult>;
  save(payload: RemoteAccessSavePayload): Promise<RemoteAccessSaveResult>;
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
        config: { ...config, port: interfacesPayload.port || config.port },
        interfaces: interfacesPayload.interfaces ?? [],
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
        },
        interfaces: snapshot.interfaces,
        desktopEnabled: status.enabled,
        webStaticConfigured: snapshot.webStaticConfigured,
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
      });
      return {
        tokenPrefix: result.status.tokenPrefix,
        hasToken: result.status.hasToken,
        ...(result.token ? { token: result.token } : {}),
        ...(result.accessUrl ? { accessUrl: result.accessUrl } : {}),
      };
    },
  };
}
