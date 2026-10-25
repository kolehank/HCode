export { createHttpServer } from "./http.js";

// BYOK A2：桌面内嵌远程访问入口复用的 web-access 配置与鉴权核心。
// 这里的函数均为纯 node/zod 实现（无 hono 依赖），供 desktop main 的
// 内嵌 HTTP/WS 入口与设置页 IPC 数据源复用。
export {
  WEB_ACCESS_MODES,
  buildAccessUrl,
  loadWebAccessConfig,
  updateWebAccessConfig,
  sanitizeWebAccessConfig,
  generateWebAccessToken,
  tokenMatchesHash,
  resolveWebBindHost,
  getDefaultWebAccessConfig,
  validateWebAccessUpdateCrossFields,
  webAccessUpdateSchema,
  isLoopbackHost,
} from "./webAccess/webAccessConfig.js";
export type {
  WebAccessConfig,
  WebAccessMode,
  WebAccessUpdateInput,
  WebBindResolution,
} from "./webAccess/webAccessConfig.js";
export {
  isTokenProtectedPath,
  isLoopbackRemoteAddress,
  extractAccessToken,
  authorizeRequest,
  verifyCloudflareAccessJwt,
  isLoopbackWsHostHeader,
  isAllowedWsOrigin,
  isEmailAllowlisted,
} from "./webAccess/webAccessAuthBridge.js";
// BYOK A2：网卡枚举与过滤规则单一所有者在 server（web 形态同一套建议逻辑），
// desktop 设置页 IPC 直接复用，避免两份虚拟网卡名单漂移。
// 注意：该模块含 hono 路由；desktop main bundle 本就整体内联 @zcode/server，无额外体积增量。
export {
  listWebAccessInterfaces,
  type WebAccessInterfaceInfo,
} from "./webAccess/webAccessRoutes.js";
