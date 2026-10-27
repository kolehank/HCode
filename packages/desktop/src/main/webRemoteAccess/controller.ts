// BYOK A2：桌面内嵌远程访问入口的生命周期与配置管理（main 进程）。
// 启用状态存 web-access.json 的 desktopEnabled；server 随桌面 app 生命周期启停。
// 配置文件的唯一所有者是 @zcode/server 的 load/updateWebAccessConfig（server 形态共用），
// 这里只做 desktopEnabled 驱动的启停编排，不复制第二份持久化逻辑。
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import type {
  CloudflaredDetection,
  QuickTunnelStatus,
  WebRemoteAccessSaveRequest,
  WebRemoteAccessStatus,
} from "@zcode/shared";
import { resolveWebAccessDisplayBaseUrl } from "@zcode/shared";
import type { WebAccessConfig, WebBindResolution } from "@zcode/server";
import {
  buildAccessUrl,
  generateWebAccessToken,
  getDefaultWebAccessConfig,
  listWebAccessInterfaces,
  loadWebAccessConfig,
  resolveWebBindHost,
  updateWebAccessConfig,
} from "@zcode/server";
import { startWebRemoteAccessServer, type WebRemoteAccessServerHandle } from "./server.js";
import { LifecycleQueue } from "./lifecycleQueue.js";
import { ActiveAccessToken } from "./activeAccessToken.js";
import { detectCloudflared as detectCloudflaredBinary } from "./cloudflaredDiscovery.js";
import { QuickTunnelSupervisor } from "./quickTunnelProcess.js";

/** 内嵌入口默认端口；ZCODE_WEB_REMOTE_PORT 可覆盖（与 #syncServerLifecycle 同一来源语义）。 */
const DEFAULT_WEB_REMOTE_PORT = 30330;

export interface WebRemoteAccessSaveResult {
  status: WebRemoteAccessStatus;
  /** 明文 token 仅在生成时刻返回一次。 */
  token?: string;
  /** 拼好的访问链接（externalBaseUrl + /#token=…），仅在生成时刻返回。 */
  accessUrl?: string;
}

export class WebRemoteAccessController {
  readonly #logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  #getHostChild: () => ElectronUtilityProcess | undefined;
  #getWebStaticDir: () => string | undefined;
  #handle: WebRemoteAccessServerHandle | null = null;
  #config: WebAccessConfig = getDefaultWebAccessConfig();
  #bindHost: string | undefined;
  /** 本机设备标识：写进 token 访问链接（#device=），Web 端回传后由鉴权层比对。 */
  readonly #deviceName = hostname() || "localhost";
  // token 明文只在内存保留（磁盘仅 hash），供设置页/手机弹窗在本次运行内重复展示。
  #activeToken = new ActiveAccessToken();
  // 临时公网通道（Cloudflare Quick Tunnel）：与 listener 同属本 controller，
  // 端口变化时随 listener 重建；状态经 IPC 推送刷新 UI。
  readonly #tunnel: QuickTunnelSupervisor;
  #tunnelStatus: QuickTunnelStatus = { state: "disabled" };
  #cloudflaredDetection: CloudflaredDetection | null = null;
  readonly #onTunnelStatusChanged: ((status: QuickTunnelStatus) => void) | undefined;
  // 生命周期操作串行化：并发 applyUpdate 的 start 在 await 后才赋值 #handle，
  // 交错时后发操作的失败分支会把先发操作刚赋值的存活 handle 置 null（监听器孤儿化）。
  #lifecycle = new LifecycleQueue();

  constructor(options: {
    logger: WebRemoteAccessServerOptionsLogger;
    getHostChild: () => ElectronUtilityProcess | undefined;
    getWebStaticDir: () => string | undefined;
    /** 通道状态变化推送（main → 所有窗口）；不注入时只更新 getStatus 快照。 */
    onTunnelStatusChanged?: (status: QuickTunnelStatus) => void;
  }) {
    this.#logger = options.logger;
    this.#getHostChild = options.getHostChild;
    this.#getWebStaticDir = options.getWebStaticDir;
    this.#onTunnelStatusChanged = options.onTunnelStatusChanged;
    this.#tunnel = new QuickTunnelSupervisor({
      logger: this.#logger,
      // app 崩溃时 cloudflared 可能存活：下次 start 前按 pid 文件清理（校验进程名，防 PID 复用误杀）。
      pidFilePath: join(getAppConfigDir(), "quick-tunnel.json"),
      onStatus: (status) => this.#setTunnelStatus(status),
    });
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  getStatus(): WebRemoteAccessStatus {
    return {
      enabled: this.#config.desktopEnabled,
      running: this.running,
      mode: this.#config.mode,
      port: this.#handle?.port,
      bindHost: this.#bindHost,
      tokenPrefix: this.#config.tokenPrefix,
      hasToken: Boolean(this.#config.tokenHash),
      cfTeamDomain: this.#config.cfTeamDomain,
      cfAud: this.#config.cfAud,
      cfAllowedEmails: this.#config.cfAllowedEmails,
      externalBaseUrl: this.#config.externalBaseUrl,
      quickTunnelEnabled: this.#config.quickTunnelEnabled,
      tunnel: { ...this.#tunnelStatus },
    };
  }

  async reloadFromDisk(): Promise<WebRemoteAccessStatus> {
    return this.#lifecycle.run(async () => {
      this.#config = await loadWebAccessConfig();
      this.#activeToken.noteConfigLoaded(this.#config.mode, this.#config.tokenHash);
      await this.#syncServerLifecycle();
      return this.getStatus();
    });
  }

  /**
   * token 档在本次运行内可复用的完整访问链接（含明文 token）。
   * 仅供 IPC 快照展示：不落盘、不进任何 HTTP 响应。监听未运行或当前非 token 档时无链接。
   */
  getActiveAccessUrl(): string | undefined {
    const token = this.#activeToken.get();
    const port = this.#handle?.port ?? 0;
    if (!token || port <= 0 || this.#config.mode !== "token") {
      return undefined;
    }
    return buildAccessUrl(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: this.#config.externalBaseUrl,
        mode: this.#config.mode,
        port,
        suggestedAddress: listWebAccessInterfaces().find((candidate) => candidate.suggested)
          ?.address,
        tunnelUrl: this.#runningTunnelUrl(),
      }),
      token,
      this.#deviceName,
    );
  }

  /** 运行中的临时公网地址；仅展示用，不落盘、不参与 Origin 校验。 */
  #runningTunnelUrl(): string | undefined {
    return this.#tunnelStatus.state === "running" ? this.#tunnelStatus.publicUrl : undefined;
  }

  /** 检测 cloudflared（设置页「重新检测」入口）；结果缓存到下一次显式检测。 */
  detectCloudflared(): Promise<CloudflaredDetection> {
    return this.#lifecycle.run(async () => {
      this.#cloudflaredDetection = await detectCloudflaredBinary();
      return this.#cloudflaredDetection;
    });
  }

  /** 错误态/未安装后的显式恢复：清空检测缓存并重新拉起通道。 */
  restartTunnel(): Promise<WebRemoteAccessStatus> {
    return this.#lifecycle.run(async () => {
      this.#cloudflaredDetection = null;
      await this.#tunnel.stop();
      await this.#syncTunnelLifecycle();
      return this.getStatus();
    });
  }

  /**
   * HTTP PUT 保存后的重建入口（本机浏览器设置页保存，响应已回包才调用到这里）。
   * 与 reloadFromDisk 的差别：监听器运行中时强制停旧起新——mode/bind/token 变更
   * 必须重建监听才生效（reloadFromDisk 只在未运行时拉起，服务 app ready 恢复场景）。
   * `generatedToken`：本次 PUT 生成的明文；磁盘上只有 hash，必须由调用方回传才能展示。
   */
  async restartFromDisk(generatedToken?: string): Promise<WebRemoteAccessStatus> {
    return this.#lifecycle.run(async () => {
      this.#config = await loadWebAccessConfig();
      // 先按磁盘 hash 对齐（PUT 重新生成时清掉旧明文），再写入本次生成的明文。
      this.#activeToken.noteConfigLoaded(this.#config.mode, this.#config.tokenHash);
      if (generatedToken) {
        this.#activeToken.noteGenerated(generatedToken, this.#config.tokenHash);
      }
      // mode 变化会让通道失去合法性：先停通道再停监听，避免 cloudflared 指向已关闭端口。
      if (!this.#tunnelShouldRun()) {
        await this.#tunnel.stop().catch(() => undefined);
      }
      if (this.#handle) {
        await this.#handle.stop();
        this.#handle = null;
      }
      await this.#syncServerLifecycle();
      return this.getStatus();
    });
  }

  /**
   * app 退出屏障调用：关闭监听与全部 WS 桥。
   * controller 状态以磁盘 web-access.json 为准，stop 不改 enabled，下次启动照常恢复。
   */
  stop(): Promise<void> {
    // 经队列执行：与在途的 applyUpdate「停旧-起新」互斥，避免 stop 掉新拉起的监听。
    return this.#lifecycle.run(async () => {
      // 先停通道再停监听：cloudflared 指向已关闭端口会持续重连并刷日志。
      await this.#tunnel.stop().catch(() => undefined);
      const handle = this.#handle;
      this.#handle = null;
      this.#bindHost = undefined;
      if (!handle) {
        return;
      }
      try {
        await handle.stop();
        this.#logger.info("[web-remote-access] listener stopped (app quit)");
      } catch (error) {
        this.#logger.warn(
          "[web-remote-access] listener stop failed during quit:",
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  /** 保存配置；鉴权档位与 bind 变更即时生效（重建监听），其余字段在下次重建时生效。 */
  applyUpdate(update: WebRemoteAccessSaveRequest): Promise<WebRemoteAccessSaveResult> {
    // 落盘 + 停旧-起新整体串行：两次并发保存按提交顺序生效，不会交错出孤儿监听器。
    return this.#lifecycle.run(async () => {
      let oneTimeToken: string | undefined;
      let accessUrl: string | undefined;
      this.#config = await updateWebAccessConfig((current) => {
        const mode = update.mode ?? current.mode;
        const requestedQuickTunnel = update.quickTunnelEnabled ?? current.quickTunnelEnabled;
        const next: WebAccessConfig = {
          ...current,
          mode,
          cfTeamDomain: update.cfTeamDomain ?? current.cfTeamDomain,
          cfAud: update.cfAud ?? current.cfAud,
          cfAllowedEmails: update.cfAllowedEmails ?? current.cfAllowedEmails,
          externalBaseUrl: update.externalBaseUrl ?? current.externalBaseUrl,
          desktopEnabled: update.desktopEnabled ?? current.desktopEnabled,
          // 公网临时通道只允许 token 档：切到 open/CF 时自动关闭，
          // 避免出现「无身份层 + 无 token」的公网暴露组合（spec 固定规则）。
          quickTunnelEnabled: mode === "token" ? requestedQuickTunnel : false,
        };
        if (mode !== "token" && requestedQuickTunnel) {
          this.#logger.warn(
            "[web-remote-access] quick tunnel requires token mode; disabling tunnel",
          );
        }
        if (next.mode === "token") {
          const shouldGenerate = update.regenerate === true || !next.tokenHash;
          if (shouldGenerate) {
            const generated = generateWebAccessToken();
            next.tokenHash = generated.tokenHash;
            next.tokenPrefix = generated.tokenPrefix;
            oneTimeToken = generated.token;
            // 展示回退链单一来源 resolveWebAccessDisplayBaseUrl（隧道 > 基址 > 建议网卡 > 回环，
            // 仅展示不落盘），与 server 形态及 UI 弹窗同一语义。
            accessUrl = buildAccessUrl(
              resolveWebAccessDisplayBaseUrl({
                externalBaseUrl: next.externalBaseUrl,
                mode: next.mode,
                port: this.#handle?.port ?? DEFAULT_WEB_REMOTE_PORT,
                suggestedAddress: listWebAccessInterfaces().find((candidate) => candidate.suggested)
                  ?.address,
                tunnelUrl: this.#runningTunnelUrl(),
              }),
              generated.token,
              this.#deviceName,
            );
          }
        }
        return next;
      });

      // mode/externalBaseUrl 变化会改变 bind 解析与鉴权语义：先停旧监听再按新配置拉起，
      // 避免「token 档切 open 后旧端口仍按旧快照拒答/放行」的窗口。
      // handle.stop 自身会 terminate 全部活动 WS 桥（server 端保证无条件 resolve）。
      // 通道在仍合法且端口不变时保持运行（URL 不因一次保存而变化）。
      if (!this.#tunnelShouldRun()) {
        await this.#tunnel.stop().catch(() => undefined);
      }
      if (this.#handle) {
        await this.#handle.stop();
        this.#handle = null;
      }
      await this.#syncServerLifecycle();
      // 明文缓存对齐：切离 token 档或 hash 变化时清空；本次生成的新明文覆盖旧值。
      this.#activeToken.noteConfigLoaded(this.#config.mode, this.#config.tokenHash);
      if (oneTimeToken) {
        this.#activeToken.noteGenerated(oneTimeToken, this.#config.tokenHash);
      }
      return { status: this.getStatus(), token: oneTimeToken, accessUrl };
    });
  }

  /**
   * bind 解析复用 server 的 resolveWebBindHost：与 web 形态共用
   * 「open 档强制回环」约束；desktop 无 legacy auth token 兜底，恒传 false。
   * bind 源沿用 FORK.md 的 ZCODE_WEB_BIND_HOST（同一台机器上 server/desktop 语义一致）。
   */
  #resolveBindHost(config: WebAccessConfig): WebBindResolution {
    const configuredHost = process.env.ZCODE_WEB_BIND_HOST?.trim() || "";
    return resolveWebBindHost(config, configuredHost, false);
  }

  async #syncServerLifecycle(): Promise<void> {
    if (!this.#config.desktopEnabled) {
      await this.#tunnel.stop().catch(() => undefined);
      await this.#handle?.stop();
      this.#handle = null;
      this.#bindHost = undefined;
      this.#setTunnelStatus({ state: "disabled" });
      return;
    }
    if (this.#handle) {
      // 监听已在运行：仍要对齐通道（开关/模式可能刚从磁盘变更）。
      await this.#syncTunnelLifecycle();
      return;
    }
    const bind = this.#resolveBindHost(this.#config);
    if (bind.forcedLoopback) {
      // 与 server 形态同一告警语义：open 档 + 非回环 bind 被强制覆盖为 127.0.0.1。
      this.#logger.warn(
        `[web-remote-access] mode "${this.#config.mode}" forbids non-loopback bind; overridden to 127.0.0.1 ` +
          `(set ZCODE_WEB_BIND_HOST together with a protected mode)`,
      );
    }
    this.#bindHost = bind.host;
    try {
      this.#handle = await startWebRemoteAccessServer({
        config: this.#config,
        // WebBindResolution.host 类型可选，但 resolveWebBindHost 的三条分支都返回非空值。
        bindHost: bind.host ?? "127.0.0.1",
        port: Number(process.env.ZCODE_WEB_REMOTE_PORT) || DEFAULT_WEB_REMOTE_PORT,
        webStaticDir: this.#getWebStaticDir(),
        deviceName: this.#deviceName,
        getHostChild: this.#getHostChild,
        // 本机浏览器设置页经 HTTP PUT 保存：落盘与回包已在 httpServer 完成，
        // 这里停旧起新使 mode/bind/token 即时生效。经 LifecycleQueue 与 IPC 保存互斥。
        // PUT 生成的明文 token 随回调回传，否则明文只存在于那一次响应里，弹窗无法复用。
        onConfigUpdated: (generatedToken) => {
          void this.restartFromDisk(generatedToken).catch((error: unknown) => {
            this.#logger.error(
              "[web-remote-access] restart after http save failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
        },
        logger: this.#logger,
      });
    } catch (error) {
      this.#handle = null;
      this.#bindHost = undefined;
      this.#logger.error(
        "[web-remote-access] failed to start embedded server:",
        error instanceof Error ? error.message : String(error),
      );
      await this.#tunnel.stop().catch(() => undefined);
      this.#setTunnelStatus({ state: this.#config.quickTunnelEnabled ? "idle" : "disabled" });
      return;
    }
    this.#logger.info(
      `[web-remote-access] started mode=${this.#config.mode} bind=${bind.host} port=${this.#handle.port}`,
    );
    await this.#syncTunnelLifecycle();
  }

  /**
   * 通道与监听对齐：必须 token 档 + 已启用 + 监听在跑。
   * 端口未变且已在运行/启动中时保持原进程（避免每次保存都换公网 URL）；
   * 端口变化由 listener 重建后在此重启通道。
   */
  async #syncTunnelLifecycle(): Promise<void> {
    const eligible = this.#tunnelShouldRun() && this.#handle !== null;
    if (!eligible) {
      await this.#tunnel.stop().catch(() => undefined);
      this.#setTunnelStatus({ state: this.#config.quickTunnelEnabled ? "idle" : "disabled" });
      return;
    }
    const port = this.#handle!.port;
    const active = this.#tunnelStatus.state === "running" || this.#tunnelStatus.state === "starting";
    if (this.#tunnel.port === port && active) {
      return;
    }
    await this.#tunnel.stop().catch(() => undefined);
    const detection = await this.#resolveCloudflared();
    if (!detection.available || !detection.path) {
      this.#logger.warn("[web-remote-access] cloudflared not found; quick tunnel unavailable");
      this.#setTunnelStatus({ state: "error", errorCode: "binary-missing" });
      return;
    }
    await this.#tunnel.start(detection.path, port);
  }

  /** 通道是否应处于运行态（不含 listener 是否已启动）。 */
  #tunnelShouldRun(): boolean {
    return (
      this.#config.desktopEnabled &&
      this.#config.quickTunnelEnabled &&
      this.#config.mode === "token"
    );
  }

  async #resolveCloudflared(): Promise<CloudflaredDetection> {
    if (!this.#cloudflaredDetection) {
      this.#cloudflaredDetection = await detectCloudflaredBinary();
    }
    return this.#cloudflaredDetection;
  }

  #setTunnelStatus(status: QuickTunnelStatus): void {
    this.#tunnelStatus = { ...status };
    this.#onTunnelStatusChanged?.({ ...status });
  }
}

type WebRemoteAccessServerOptionsLogger = Parameters<
  typeof startWebRemoteAccessServer
>[0]["logger"];
