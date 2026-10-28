import { recordArmsCustomEventForE2E } from "@zcode/ui";
import {
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  type CloudflaredDetection,
  type CreateTempTextAttachmentRequest,
  type IPlatformService,
  type LoadCliMcpFromUserDirectoryRequest,
  type LocalTtftBatch,
  type MigrateLegacyCommonMcpRequest,
  type QuickTunnelStatus,
  type SaveCliMcpToUserDirectoryRequest,
  type WebRemoteAccessSaveRequest,
  type WebRemoteAccessSaveResponse,
  type WebRemoteAccessStatus,
  type WebRemoteAccessConfigSnapshot,
  type WebAccessInterfaceOption,
} from "@zcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

/** preload `webRemoteAccess` 桥的窄化视图：旧 preload（升级后的旧窗口）可能未暴露该桥。 */
type ZCodeWebRemoteAccessBridge = {
  getConfig(): Promise<WebRemoteAccessConfigSnapshot>;
  saveConfig(payload: WebRemoteAccessSaveRequest): Promise<WebRemoteAccessSaveResponse>;
  getInterfaces(): Promise<WebAccessInterfaceOption[]>;
  /** 以下三个为临时通道（Cloudflare Quick Tunnel）新增方法：旧 preload 未暴露，需可选探测。 */
  detectCloudflared?(): Promise<CloudflaredDetection>;
  restartTunnel?(): Promise<WebRemoteAccessStatus>;
  onTunnelStatusChanged?(listener: (status: QuickTunnelStatus) => void): () => void;
};

function resolveWebRemoteAccessBridge(): ZCodeWebRemoteAccessBridge | undefined {
  const zcode = (window as Window & { zcode?: { webRemoteAccess?: ZCodeWebRemoteAccessBridge } })
    .zcode;
  return zcode?.webRemoteAccess;
}

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.zcode.selectDirectory(),
    selectDirectories: () => window.zcode.selectDirectories(),
    selectFile: () => window.zcode.selectFile(),
    selectFiles: () => window.zcode.selectFiles?.() ?? Promise.resolve([]),
    // 以下四个能力在 IPlatformService 中可选（旧 preload 未暴露）：条件定义，
    // UI 靠方法是否存在做能力检测，不得用恒存在的降级实现谎报能力。
    ...(window.zcode.createTempTextAttachment
      ? {
          createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
            window.zcode.createTempTextAttachment!(payload),
        }
      : {}),
    ...(window.zcode.loadMcpFromUserDirectory
      ? {
          loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
            window.zcode.loadMcpFromUserDirectory!(payload),
        }
      : {}),
    ...(window.zcode.saveMcpToUserDirectory
      ? {
          saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
            window.zcode.saveMcpToUserDirectory!(payload),
        }
      : {}),
    ...(window.zcode.migrateLegacyCommonMcp
      ? {
          migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
            window.zcode.migrateLegacyCommonMcp!(payload),
        }
      : {}),
    materializeWorkflowArtifactFile: (payload) =>
      window.zcode.materializeWorkflowArtifactFile(payload),
    onRemoteConnectionLog: (handler) => window.zcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.zcode.onRemoteSessionClosed(handler),
    // Source 自动重连会替换 logical session；统一由 preload bridge 转发换代事件。
    onRemoteSessionReconnected: (handler) =>
      window.zcode.onRemoteSessionReconnected?.(handler) ?? (() => {}),
    activateOrSetWorkspace: (path) =>
      window.zcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.zcode.connectRemote(remoteOptions, requestId, context),
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.zcode.requestSourceSettingsAttachment?.(sourceServerId) ??
      Promise.reject(new Error("Source settings attachment bridge unavailable")),
    cancelPendingRemoteConnection: (requestId) =>
      window.zcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.zcode.bindRemoteWorkspaceSessionContext?.(context) ??
      Promise.reject(new Error("Desktop bindRemoteWorkspaceSessionContext bridge unavailable")),
    disposeRemoteSession: (sessionId) => window.zcode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.zcode.isDockerAvailable(),
    listWSLDistros: () => window.zcode.listWSLDistros(),
    listDockerContainers: () => window.zcode.listDockerContainers(),
    listSSHConfigAliases: () => window.zcode.listSSHConfigAliases(),
    openExternal: (url) => window.zcode.openExternal(url),
    openFeedback: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.zcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.zcode.openInFileManager(path),
    openExternalFile: (path) => window.zcode.openExternalFile(path),
    openCuaPermissionOnboarding: window.zcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.zcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.zcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.zcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.zcode.startCuaHelperPermissionDrag
      ? () => window.zcode.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyWebRemoteControlAuthStateChanged: (change) =>
      window.zcode.notifyWebRemoteControlAuthStateChanged(change),
    registerOAuthState: (payload) => window.zcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.zcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.zcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.zcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.zcode.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.zcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.zcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.zcode.getRendererActionTraceConfig
      ? () => window.zcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.zcode.onRendererActionTraceConfigChanged
      ? (callback) => window.zcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: window.zcode.reportLocalTtftBatch
      ? (batch: LocalTtftBatch) => window.zcode.reportLocalTtftBatch!(batch)
      : undefined,
    reportRendererActionTraceBatch: window.zcode.reportRendererActionTraceBatch
      ? (batch) => window.zcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.zcode.reportRendererHeapSample
      ? (sample) => window.zcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.zcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.zcode.syncWindowTabs(paths),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.zcode.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.zcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.zcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.zcode.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.zcode.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.zcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.zcode.onFocusTab(handler),
    onNewTab: (handler) => window.zcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.zcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.zcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.zcode.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.zcode.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.zcode.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.zcode.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.zcode.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.zcode.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.zcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.zcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.zcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.zcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.zcode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.zcode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.zcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.zcode.getDesktopWindowChromeState
      ? () => window.zcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.zcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.zcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.zcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.zcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.zcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.zcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.zcode.onTaskNotificationClick(handler),
    exportLogs: () => window.zcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.zcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.zcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.zcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.zcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.zcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.zcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.zcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.zcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.zcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.zcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.zcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.zcode.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.zcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.zcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.zcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.zcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.zcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.zcode.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.zcode.getInstalledEditors(filePath),
    getApplicationIcon: (bundleId) =>
      window.zcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.zcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.zcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.zcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.zcode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.zcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ZCODE_DEVICE_ID__?: string }).__ZCODE_DEVICE_ID__ ?? "",
    webRemoteAccess: resolveWebRemoteAccessBridge()
      ? {
          getConfig: () => resolveWebRemoteAccessBridge()!.getConfig(),
          saveConfig: (payload) => resolveWebRemoteAccessBridge()!.saveConfig(payload),
          getInterfaces: () => resolveWebRemoteAccessBridge()!.getInterfaces(),
          // 临时通道三方法：旧 preload 未暴露时按「能力不可用」降级，不崩区域——
          // 检测返回不可用、重启以明确错误 reject（UI 已有 try/catch + toast）、
          // 订阅返回空取消函数。
          detectCloudflared: () =>
            resolveWebRemoteAccessBridge()!.detectCloudflared?.() ??
            Promise.resolve({ available: false }),
          restartTunnel: () =>
            resolveWebRemoteAccessBridge()!.restartTunnel?.() ??
            Promise.reject(new Error("tunnel control requires an updated app")),
          onTunnelStatusChanged: (listener) =>
            resolveWebRemoteAccessBridge()!.onTunnelStatusChanged?.(listener) ?? (() => {}),
        }
      : undefined,
  };
}
