// BYOK A2：桌面内嵌远程访问入口的 HTTP/WS 监听器（纯 node 实现，不含 electron 依赖，
// 便于在 node:test 里回归三档鉴权矩阵与生命周期语义，见 docs/specs/web-remote-access.md）。
// electron 侧的 MessagePort 桥由 server.ts 以 onClientConnected 回调注入。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { formatZodError } from "@zcode/shared";
import type { WebAccessConfig } from "@zcode/server";
import {
  authorizeRequest,
  buildAccessUrl,
  generateWebAccessToken,
  isAllowedWsOrigin,
  isLoopbackRemoteAddress,
  isLoopbackWsHostHeader,
  isTokenProtectedPath,
  listWebAccessInterfaces,
  loadWebAccessConfig,
  sanitizeWebAccessConfig,
  updateWebAccessConfig,
  validateWebAccessUpdateCrossFields,
  verifyCloudflareAccessJwt,
  webAccessUpdateSchema,
} from "@zcode/server";

/** Cf-Access-Jwt-Assertion 等头在 Node http 里可能是 string[]；校验只认第一个值。 */
export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface WebRemoteAccessHttpServerOptions {
  /** 生效配置（启动时快照；改动重启生效）。 */
  config: WebAccessConfig;
  /** 解析后的绑定地址（open 档调用方须已强制 127.0.0.1）。 */
  bindHost: string;
  port: number;
  /** Web 前端静态资源目录（安装包 resources/web-dist 或 dev 的 packages/web/dist）。 */
  webStaticDir: string | undefined;
  /** WS 升级完成后的客户端接入回调（electron 适配层注入 MessagePort 桥）。 */
  onClientConnected: (ws: WebSocket) => void;
  /**
   * PUT /api/web-access/config 落盘成功且响应已回包后触发（desktop 传入 controller 的
   * 停旧起新重建入口）。必须在响应 end 回调里调用：stop 会终止包括当前连接在内的全部 socket。
   */
  onConfigUpdated?: () => void;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface WebRemoteAccessHttpServerHandle {
  port: number;
  stop(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// 基础安全响应头：nosniff 防内容嗅探，no-referrer 防 token 出现在 referrer 里外泄。
// CSP / X-Frame-Options 暂不设置（远端 UI 是否允许嵌入未决策），见 docs/specs/web-remote-access.md。
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const HTTP_REASON_PHRASES: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 与 server 形态 http.ts 的 isInsideDirectory 同一语义：relative 判定拒绝穿越与兄弟目录。 */
function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function serveStaticFile(
  res: ServerResponse,
  webStaticDir: string,
  pathname: string,
): Promise<void> {
  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    // 保留原路径走 404/SPA fallback，不因畸形编码抛错。
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const resolved = join(webStaticDir, relativePath);
  if (!isInsideDirectory(webStaticDir, resolved)) {
    res.writeHead(403, STATIC_SECURITY_HEADERS).end();
    return;
  }
  let fileStat = null;
  try {
    fileStat = await stat(resolved);
  } catch {
    fileStat = null;
  }
  if (!fileStat?.isFile()) {
    // SPA fallback：非资产路径回 index.html。
    const index = join(webStaticDir, "index.html");
    try {
      const indexStat = await stat(index);
      if (indexStat.isFile()) {
        res.writeHead(200, { "content-type": MIME_TYPES[".html"], ...STATIC_SECURITY_HEADERS });
        createReadStream(index).pipe(res);
        return;
      }
    } catch {
      // 落到 404。
    }
    res.writeHead(404, STATIC_SECURITY_HEADERS).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME_TYPES[extname(resolved)] ?? "application/octet-stream",
    ...STATIC_SECURITY_HEADERS,
  });
  createReadStream(resolved).pipe(res);
}

/** 拒绝 WS 升级：status 是数值，reason phrase 按码表写（403 写成 Unauthorized 是历史笔误）。
 *  拒绝原因不入响应（避免回显内部细节），由调用方记 warn 日志。 */
function rejectUpgrade(socket: import("node:net").Socket, status: number): void {
  const reason = HTTP_REASON_PHRASES[status] ?? "Forbidden";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\n\r\n`);
  socket.destroy();
}

export function startWebRemoteAccessHttpServer(
  options: WebRemoteAccessHttpServerOptions,
): Promise<WebRemoteAccessHttpServerHandle> {
  const { config, logger } = options;
  const server: Server = createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: "internal error" });
      } else {
        res.destroy();
      }
      logger.error(
        "[web-remote-access] http handler failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const pathname = new URL(url, "https://local").pathname;
    const requestLike = {
      method: req.method,
      url,
      headers: req.headers as Record<string, string | undefined>,
      remoteAddress: req.socket.remoteAddress,
    };

    // token 档同步鉴权（/api/* 与 /ws* 升级前必须过）。CF 档在下方异步验签分支处理；
    // authorizeRequest 对 CF 恒拒绝，历史上把 CF 也放进这个分支导致异步分支不可达（死代码）。
    // open 档无应用层鉴权，但浏览器来源校验（Origin/Host）对三档一致生效。
    if (isTokenProtectedPath(pathname)) {
      const guardHost = firstHeaderValue(req.headers.host);
      if (config.mode === "open" && !isLoopbackWsHostHeader(guardHost)) {
        json(res, 403, { error: "host header is not allowed in open mode" });
        return;
      }
      if (
        !isAllowedWsOrigin(firstHeaderValue(req.headers.origin), guardHost, config.externalBaseUrl)
      ) {
        json(res, 403, { error: "cross-origin request is not allowed" });
        return;
      }
      if (config.mode === "token") {
        const auth = authorizeRequest(requestLike, config);
        if (!auth.ok) {
          json(res, auth.status, { error: auth.detail });
          return;
        }
        // /api/web-access 的读写粒度 loopback 约束在下方 API 分发器统一执行。
      } else if (config.mode === "cloudflare-access") {
        const result = await verifyCloudflareAccessJwt(
          firstHeaderValue(req.headers["cf-access-jwt-assertion"]),
          config,
        );
        if (!result.ok) {
          json(res, result.status, { error: result.detail });
          return;
        }
      }
    }

    // /api 空间只挂载 web-access 配置面（open/token 档），未挂载路径一律 404 JSON——
    // 不能落入 SPA fallback：浏览器端会把 index.html 当 JSON 解析，报「Unexpected token '<'」。
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApiRequest(req, res, pathname, requestLike);
      return;
    }

    if (options.webStaticDir) {
      await serveStaticFile(res, options.webStaticDir, pathname);
      return;
    }
    res.writeHead(404, STATIC_SECURITY_HEADERS).end("web static root is not configured");
  }

  /**
   * /api/web-access 配置面（desktop 挂载 open/token 档；CF 档不挂载，见 spec 鉴权矩阵）。
   * 读写约束与 server 形态对齐：open 档全接口仅 loopback（未鉴权挡探测）；
   * token 档 GET 凭据放行（远程只读），写接口仅 loopback（本机设置页）。
   * 配置读写都直接走 @zcode/server（磁盘 web-access.json 唯一事实），不经 controller 缓存。
   */
  async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    requestLike: {
      method: string | undefined;
      url: string;
      headers: Record<string, string | undefined>;
      remoteAddress: string | undefined;
    },
  ): Promise<void> {
    if (config.mode !== "open" && config.mode !== "token") {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!pathname.startsWith("/api/web-access")) {
      json(res, 404, { error: "not found" });
      return;
    }
    const isWrite = req.method !== "GET";
    const loopbackRequired = config.mode === "open" || isWrite;
    if (loopbackRequired && !isLoopbackRemoteAddress(requestLike.remoteAddress)) {
      json(res, 403, { error: "web access config requires loopback" });
      return;
    }

    if (pathname === "/api/web-access/config" && req.method === "GET") {
      const current = await loadWebAccessConfig();
      json(res, 200, { ...sanitizeWebAccessConfig(current), port: listeningPort });
      return;
    }
    if (pathname === "/api/web-access/interfaces" && req.method === "GET") {
      json(res, 200, { interfaces: listWebAccessInterfaces(), port: listeningPort });
      return;
    }
    if (pathname === "/api/web-access/config" && req.method === "PUT") {
      await handleConfigPut(req, res);
      return;
    }
    json(res, 404, { error: "not found" });
  }

  /** PUT 请求体上限：schema 各字段有界，超限直接拒绝，不给 main 进程缓冲机会。 */
  const MAX_PUT_BODY_BYTES = 1024 * 1024;

  async function handleConfigPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      total += buf.length;
      if (total > MAX_PUT_BODY_BYTES) {
        json(res, 413, { error: "request body too large" });
        return;
      }
      chunks.push(buf);
    }
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const parsed = webAccessUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      json(res, 400, { error: `Invalid request body: ${formatZodError(parsed.error)}` });
      return;
    }
    const body = parsed.data;
    const crossFieldError = validateWebAccessUpdateCrossFields(body);
    if (crossFieldError) {
      json(res, 400, { error: crossFieldError });
      return;
    }

    // token 档没有可用 token，或显式 regenerate：生成新 token（旧 token 在重启后失效）。
    let generated: { token: string; tokenHash: string; tokenPrefix: string } | undefined;
    if (body.mode === "token") {
      const existing = await loadWebAccessConfig();
      if (body.regenerate || !existing.tokenHash) {
        generated = generateWebAccessToken();
      }
    }

    try {
      const next = await updateWebAccessConfig((current) => ({
        ...current,
        mode: body.mode,
        cfTeamDomain: body.cfTeamDomain.trim(),
        cfAud: body.cfAud.trim(),
        cfAllowedEmails: body.cfAllowedEmails.map((email) => email.trim()).filter(Boolean),
        externalBaseUrl: body.externalBaseUrl.trim(),
        ...(generated
          ? { tokenHash: generated.tokenHash, tokenPrefix: generated.tokenPrefix }
          : {}),
      }));
      logger.info(
        `[web-remote-access] config updated via http mode=${next.mode} tokenPrefix=${next.tokenPrefix} tokenRegenerated=${Boolean(generated)}`,
      );
      // 先回包再触发重建：onConfigUpdated 会 stop 本监听器（含当前连接），
      // 回包必须已完成。end 回调失败（连接早断）时本轮不重建，磁盘事实由
      // 后续生命周期操作或下次启动重同步（见 spec 生命周期节）。
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ...sanitizeWebAccessConfig(next),
          port: listeningPort,
          ...(generated
            ? {
                token: generated.token,
                // 基址为空时回退本机回环（仅展示，不落盘），与 server 形态同一语义。
                accessUrl: buildAccessUrl(next.externalBaseUrl, generated.token, listeningPort),
              }
            : {}),
        }),
        () => {
          options.onConfigUpdated?.();
        },
      );
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    // 与帧解码的 MAX_FRAME_BYTES 同一量级兜底：ws 层直接拒绝超限消息（close 1009）。
    maxPayload: 64 * 1024 * 1024,
  });

  // WS 升级顺序：路径 → open 档 Host → Origin → 三档鉴权（CF 异步验签），全过后才桥接。
  // @types/node 25 把 upgrade 的 socket 类型标为 Duplex；拒绝/桥接路径都需要 net.Socket API，
  // 这里按运行时真实形态收窄（Node 对 upgrade 事件交付的确实是 Socket 实例）。
  server.on("upgrade", (req, socket: Socket, head) => {
    const url = req.url ?? "/";
    const pathname = new URL(url, "https://local").pathname;
    if (pathname !== "/ws" && !pathname.startsWith("/ws/")) {
      socket.destroy();
      return;
    }
    const requestLike = {
      method: "GET",
      url,
      headers: req.headers as Record<string, string | undefined>,
      remoteAddress: req.socket.remoteAddress,
    };
    const guardHost = firstHeaderValue(req.headers.host);
    const guardOrigin = firstHeaderValue(req.headers.origin);
    // open 档绑定被强制在回环上，但本机浏览器就运行在回环：WebSocket 不受 CORS 约束，
    // 恶意网页可直接握手，因此 Host/Origin 校验是 open 档唯一的浏览器侧防线。
    if (config.mode === "open" && !isLoopbackWsHostHeader(guardHost)) {
      logger.warn(
        `[web-remote-access] upgrade rejected: host not loopback in open mode host=${guardHost}`,
      );
      rejectUpgrade(socket, 403);
      return;
    }
    if (!isAllowedWsOrigin(guardOrigin, guardHost, config.externalBaseUrl)) {
      logger.warn(
        `[web-remote-access] upgrade rejected: cross-origin origin=${guardOrigin} host=${guardHost}`,
      );
      rejectUpgrade(socket, 403);
      return;
    }
    const proceed = () => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        options.onClientConnected(ws);
      });
    };
    if (config.mode === "cloudflare-access") {
      void verifyCloudflareAccessJwt(
        firstHeaderValue(req.headers["cf-access-jwt-assertion"]),
        config,
      ).then((result) => {
        if (!result.ok) {
          logger.warn(
            `[web-remote-access] upgrade rejected by cf verification: status=${result.status} detail=${result.detail}`,
          );
          rejectUpgrade(socket, result.status);
          return;
        }
        proceed();
      });
      return;
    }
    const auth = authorizeRequest(requestLike, config);
    if (!auth.ok) {
      logger.warn(
        `[web-remote-access] upgrade rejected: status=${auth.status} detail=${auth.detail}`,
      );
      rejectUpgrade(socket, auth.status);
      return;
    }
    proceed();
  });

  // /api/web-access 响应里的 port 字段：配置端口可能为 0（临时端口），以实际监听值为准。
  let listeningPort = options.port;

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port, options.bindHost, () => {
      server.removeListener("error", rejectPromise);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : options.port;
      listeningPort = actualPort;
      logger.info(
        `[web-remote-access] listening mode=${config.mode} bind=${options.bindHost} port=${actualPort}`,
      );
      resolvePromise({
        port: actualPort,
        stop: () =>
          new Promise<void>((resolveStop) => {
            // 先强断全部活动桥：wss.close() 只等客户端自行断开，有在线客户端时
            // server.close 的回调永不触发，设置页保存/停用会无限挂起、新 token 永不生效。
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close();
            server.close(() => resolveStop());
            // 兜底清掉 keep-alive 与未完成 upgrade 的 socket（Node ≥ 18.2）。
            server.closeAllConnections();
          }),
      });
    });
  });
}
