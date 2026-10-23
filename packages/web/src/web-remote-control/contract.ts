import type { WebRemoteControlFailure, WebRemoteControlV2QrParams } from "@zcode/shared";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";

// BYOK fork P1b：OAuth 登录体系（src/auth/）已删除。手机远控的门禁契约保留，
// 由入口注入实现；P3 三档鉴权落地前装配层恒为未登录态。
export type WebOAuthProviderId = "zai" | "bigmodel";

/** 设备页账号行的只读展示资料；不是登录事实，登录门禁仍以 JWT 为准。 */
export interface WebRemoteControlDeviceGroup {
  deviceMid: string;
  name?: string;
  /** relay meta.platform（darwin / win32 / linux 等），离线时回退到本机记住的平台。 */
  platform?: string;
  onlineConnections: WebRemoteControlRelayV2Device[];
}

/** 本机见过的在线设备展示信息；name / platform 至少一项非空。 */
export interface KnownDevice {
  name?: string;
  platform?: string;
}

export interface WebRemoteControlDeviceListAccount {
  displayName: string;
  avatarUrl?: string;
  provider: WebOAuthProviderId;
}

export type WebRemoteControlDeviceListView = {
  kind: "devices";
  devices: WebRemoteControlDeviceGroup[];
  loading: boolean;
  error: boolean;
  account?: WebRemoteControlDeviceListAccount;
};

export type WebRemoteControlEntryView =
  | { kind: "callback" | "login" }
  | WebRemoteControlDeviceListView
  | { kind: "failure"; failure: WebRemoteControlFailure };

export interface WebRemoteControlEntryConnection {
  params: WebRemoteControlV2QrParams & { deviceSid: string };
  signal: AbortSignal;
  getToken(signal: AbortSignal): Promise<string>;
  onPaired(): void;
  onFailure(failure: WebRemoteControlFailure): void;
}

export interface WebRemoteControlEntryOptions {
  // 浏览器 location/history/storage 经现有边界注入，不另存一份登录事实。
  // BYOK fork P1b：原 Pick<WebAuthService, ...> 改为内联契约；P3 三档鉴权替换实现。
  auth: {
    getZCodeJwtToken(): string | null;
    getActiveAccount(): { displayName: string; avatarUrl?: string; provider: WebOAuthProviderId } | null;
    startLogin(options?: { appReturnTo?: string; provider?: WebOAuthProviderId }): void;
    logout(): Promise<void>;
  };
  getHref(): string;
  replaceHref(href: string): void;
  storage: Pick<Storage, "getItem" | "setItem">;
  locale: "zh-CN" | "en-US";
  devices(jwt: string, signal: AbortSignal): Promise<WebRemoteControlRelayV2Device[]>;
  subscribeVisible(listener: () => void): () => void;
  loginOptions?: { appReturnTo?: string; provider?: WebOAuthProviderId };
  token(jwt: string, signal: AbortSignal): Promise<string>;
  connect(connection: WebRemoteControlEntryConnection): void;
  onView(view: WebRemoteControlEntryView): void;
}

export type * from "#src/web-remote-control/contracts/transport.js";
