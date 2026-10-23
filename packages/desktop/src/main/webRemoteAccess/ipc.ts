// BYOK A2：桌面内嵌远程访问入口的设置页 IPC。
// 数据面唯一所有者是 WebRemoteAccessController（web-access.json 经 @zcode/server 读写）；
// 网卡枚举复用 @zcode/server 的 listWebAccessInterfaces，与 web 形态共用同一过滤/建议规则。
// 入参校验与错误包装在 saveRequest.ts（纯逻辑层，可脱离 electron 单测）。
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type {
  WebRemoteAccessConfigSnapshot,
  WebRemoteAccessSaveResponse,
} from "@zcode/shared";
import { listWebAccessInterfaces } from "@zcode/server";
import { parseSaveRequest, wrapHandler } from "./saveRequest.js";
import type { WebRemoteAccessController } from "./controller.js";

export function registerWebRemoteAccessIpc(options: {
  controller: WebRemoteAccessController;
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** web 前端静态资源目录解析器；与 server 启动用同一个（决定 webStaticConfigured）。 */
  getWebStaticDir: () => string | undefined;
}): void {
  const { controller, logger } = options;

  ipcMain.handle(
    PlatformChannels.WebAccessGetConfig,
    wrapHandler(
      PlatformChannels.WebAccessGetConfig,
      async (): Promise<WebRemoteAccessConfigSnapshot> => ({
        status: controller.getStatus(),
        interfaces: listWebAccessInterfaces(),
        webStaticConfigured: Boolean(options.getWebStaticDir()),
      }),
      logger.error,
    ),
  );

  ipcMain.handle(
    PlatformChannels.WebAccessSaveConfig,
    wrapHandler(
      PlatformChannels.WebAccessSaveConfig,
      async (payload: unknown): Promise<WebRemoteAccessSaveResponse> => {
        const request = parseSaveRequest(payload);
        if (!request) {
          throw new Error("invalid web access config payload");
        }
        // CF 档跨字段约束与 web 形态的 PUT 路由一致：域名/AUD 必填且域名为裸主机名。
        if (request.mode === "cloudflare-access") {
          const status = controller.getStatus();
          const teamDomain = request.cfTeamDomain ?? status.cfTeamDomain;
          const aud = request.cfAud ?? status.cfAud;
          if (!teamDomain || !aud) {
            throw new Error("cloudflare-access requires cfTeamDomain and cfAud");
          }
          if (/\/|^https?:/i.test(teamDomain)) {
            throw new Error("cfTeamDomain must be a bare hostname");
          }
        }
        const externalBaseUrl =
          request.externalBaseUrl ?? controller.getStatus().externalBaseUrl;
        if (externalBaseUrl && !/^https?:\/\//i.test(externalBaseUrl)) {
          throw new Error("externalBaseUrl must start with http:// or https://");
        }
        return controller.applyUpdate(request);
      },
      logger.error,
    ),
  );

  ipcMain.handle(
    PlatformChannels.WebAccessGetInterfaces,
    wrapHandler(
      PlatformChannels.WebAccessGetInterfaces,
      async () => ({
        interfaces: listWebAccessInterfaces(),
      }),
      logger.error,
    ),
  );
}
