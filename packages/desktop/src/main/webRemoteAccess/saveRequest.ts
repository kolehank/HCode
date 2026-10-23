// BYOK A2：桌面内嵌远程访问入口的设置页 IPC 纯逻辑层。
// 与 electron 运行时解耦（electron 仅以 type 引入），便于在普通 node 测试里回归
// 「ipcMain.handle 监听函数首参是 event 对象」这一签名契约。
import type { IpcMainInvokeEvent } from "electron";
import type { WebRemoteAccessSaveRequest } from "@zcode/shared";
import { WEB_ACCESS_MODES } from "@zcode/server";

const WEB_ACCESS_MODE_SET: ReadonlySet<string> = new Set(WEB_ACCESS_MODES);

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 校验并规整 renderer 的保存请求：renderer（与 web 设置页同一套表单）保证字段完整，
 * 这里只做类型收窄与越界值拒绝；缺省字段交由 controller 与磁盘当前值合并，
 * 与 server PUT 路由「宽松入参 + 跨字段校验」的语义保持一致。
 */
export function parseSaveRequest(payload: unknown): WebRemoteAccessSaveRequest | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const mode = raw.mode;
  if (typeof mode !== "string" || !WEB_ACCESS_MODE_SET.has(mode)) {
    return null;
  }
  const request: WebRemoteAccessSaveRequest = { mode: mode as WebRemoteAccessSaveRequest["mode"] };
  const cfTeamDomain = asTrimmedString(raw.cfTeamDomain);
  const cfAud = asTrimmedString(raw.cfAud);
  const externalBaseUrl = asTrimmedString(raw.externalBaseUrl);
  // 空串候选必须在此过滤：allowlist 混入 "" 会让校验端把「无 email claim 的合法 JWT」
  // （email 视为 ""）放行。校验端 isEmailAllowlisted 也跳过空候选，双保险
  // （校验端不能单独兜住：空串仍会占据 allowlist，语义上等于放开无 email 的 JWT）。
  const cfAllowedEmails = asStringArray(raw.cfAllowedEmails)
    ?.map((email) => email.trim())
    .filter((email) => email.length > 0);
  if (cfTeamDomain !== undefined) request.cfTeamDomain = cfTeamDomain;
  if (cfAud !== undefined) request.cfAud = cfAud;
  if (externalBaseUrl !== undefined) request.externalBaseUrl = externalBaseUrl;
  if (cfAllowedEmails !== undefined) request.cfAllowedEmails = cfAllowedEmails;
  if (typeof raw.desktopEnabled === "boolean") request.desktopEnabled = raw.desktopEnabled;
  if (typeof raw.regenerate === "boolean") request.regenerate = raw.regenerate;
  return request;
}

/**
 * invoke handler 抛错时 Electron 只把 message 传回 renderer；统一包一层 main 日志便于定位（不回显敏感字段）。
 *
 * 签名契约：ipcMain.handle 的监听函数首参是 IpcMainInvokeEvent，payload 从第二个参数开始。
 * 曾经误把首参当 payload 转发，导致 parseSaveRequest 收到 event（mode 为 undefined）而
 * 恒抛 invalid payload——加载类无参 handler 正常、保存类带参 handler 必败。
 */
export function wrapHandler<T>(
  channel: string,
  handler: (payload: unknown) => Promise<T>,
  error: (...args: unknown[]) => void,
): (event: IpcMainInvokeEvent, payload: unknown) => Promise<T> {
  return async (_event, payload) => {
    try {
      return await handler(payload);
    } catch (cause) {
      error(
        `[web-remote-access] ipc ${channel} failed:`,
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  };
}
