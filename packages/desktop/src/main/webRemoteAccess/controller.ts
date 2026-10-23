// BYOK A2：桌面内嵌远程访问入口的生命周期与配置管理（main 进程）。
// 启用状态存 web-access.json 的 desktopEnabled；server 随桌面 app 生命周期启停。
// 配置文件的唯一所有者是 @zcode/server 的 load/updateWebAccessConfig（server 形态共用），
// 这里只做 desktopEnabled 驱动的启停编排，不复制第二份持久化逻辑。
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type { WebRemoteAccessSaveRequest, WebRemoteAccessStatus } from "@zcode/shared";
import type { WebAccessConfig, WebBindResolution } from "@zcode/server";
import {
  generateWebAccessToken,
  getDefaultWebAccessConfig,
  loadWebAccessConfig,
  resolveWebBindHost,
  updateWebAccessConfig,
} from "@zcode/server";
import {
  startWebRemoteAccessServer,
  type WebRemoteAccessServerHandle,
} from "./server.js";
import { LifecycleQueue } from "./lifecycleQueue.js";

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
  // 生命周期操作串行化：并发 applyUpdate 的 start 在 await 后才赋值 #handle，
  // 交错时后发操作的失败分支会把先发操作刚赋值的存活 handle 置 null（监听器孤儿化）。
  #lifecycle = new LifecycleQueue();

  constructor(options: {
    logger: WebRemoteAccessServerOptionsLogger;
    getHostChild: () => ElectronUtilityProcess | undefined;
    getWebStaticDir: () => string | undefined;
  }) {
    this.#logger = options.logger;
    this.#getHostChild = options.getHostChild;
    this.#getWebStaticDir = options.getWebStaticDir;
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
    };
  }

  async reloadFromDisk(): Promise<WebRemoteAccessStatus> {
    return this.#lifecycle.run(async () => {
      this.#config = await loadWebAccessConfig();
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
        const next: WebAccessConfig = {
          ...current,
          mode: update.mode ?? current.mode,
          cfTeamDomain: update.cfTeamDomain ?? current.cfTeamDomain,
          cfAud: update.cfAud ?? current.cfAud,
          cfAllowedEmails: update.cfAllowedEmails ?? current.cfAllowedEmails,
          externalBaseUrl: update.externalBaseUrl ?? current.externalBaseUrl,
          desktopEnabled: update.desktopEnabled ?? current.desktopEnabled,
        };
        if (next.mode === "token") {
          const shouldGenerate = update.regenerate === true || !next.tokenHash;
          if (shouldGenerate) {
            const generated = generateWebAccessToken();
            next.tokenHash = generated.tokenHash;
            next.tokenPrefix = generated.tokenPrefix;
            oneTimeToken = generated.token;
            if (next.externalBaseUrl) {
              accessUrl = `${next.externalBaseUrl.replace(/\/+$/, "")}/#token=${generated.token}`;
            }
          }
        }
        return next;
      });

      // mode/externalBaseUrl 变化会改变 bind 解析与鉴权语义：先停旧监听再按新配置拉起，
      // 避免「token 档切 open 后旧端口仍按旧快照拒答/放行」的窗口。
      // handle.stop 自身会 terminate 全部活动 WS 桥（server 端保证无条件 resolve）。
      if (this.#handle) {
        await this.#handle.stop();
        this.#handle = null;
      }
      await this.#syncServerLifecycle();
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
      await this.#handle?.stop();
      this.#handle = null;
      this.#bindHost = undefined;
      return;
    }
    if (this.#handle) {
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
        port: Number(process.env.ZCODE_WEB_REMOTE_PORT) || 30330,
        webStaticDir: this.#getWebStaticDir(),
        getHostChild: this.#getHostChild,
        logger: this.#logger,
      });
    } catch (error) {
      this.#handle = null;
      this.#bindHost = undefined;
      this.#logger.error(
        "[web-remote-access] failed to start embedded server:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    this.#logger.info(
      `[web-remote-access] started mode=${this.#config.mode} bind=${bind.host} port=${this.#handle.port}`,
    );
  }
}

type WebRemoteAccessServerOptionsLogger = Parameters<
  typeof startWebRemoteAccessServer
>[0]["logger"];
