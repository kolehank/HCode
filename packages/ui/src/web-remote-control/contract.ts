import type { IPlatformService } from "@zcode/shared";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

// BYOK fork P1b：OAuth 登录体系已删除。远控认证同步的取数源（onDidChangeSession）
// 不复存在，投影只保留一次性 signed-out 初值；P3 三档鉴权落地时重接事件源。
export type WebRemoteControlDeviceNavigation = NonNullable<
  WebRemoteControlWorkspaceSwitcherApi["deviceNavigation"]
>;
export type WebRemoteControlAuthPlatform = Pick<
  IPlatformService,
  "notifyWebRemoteControlAuthStateChanged"
>;
export type { WebRemoteControlMobileTaskView } from "@zcode/shared";
export type WebRemoteControlTaskViewSwitcher = Pick<
  WebRemoteControlWorkspaceSwitcherApi,
  "updateMobileTaskView" | "updateMobileViewState"
>;
