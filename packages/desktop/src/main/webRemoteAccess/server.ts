// BYOK A2：桌面内嵌远程访问入口（electron 适配层）。
// 监听器、三档鉴权与浏览器来源校验在 webRemoteAccessHttpServer.ts（纯 node，可单测）；
// 本文件只做 electron 专属的 MessagePort 桥接与生命周期装配。
// 三档鉴权语义见 docs/specs/web-remote-access.md；生命周期由设置页开关
// （web-access.json 的 desktopEnabled）驱动，默认关闭。
import { randomUUID } from "node:crypto";
import { MessageChannelMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type { WebSocket } from "ws";
import {
  startWebRemoteAccessHttpServer,
  type WebRemoteAccessHttpServerOptions,
} from "./webRemoteAccessHttpServer.js";
import {
  FrameDecodeOverflowError,
  encodeSocketFrame,
  SocketFrameDecoder,
} from "./socketFrameBridge.js";

type HttpServerOptions = Omit<WebRemoteAccessHttpServerOptions, "onClientConnected">;

export interface WebRemoteAccessServerOptions extends HttpServerOptions {
  /** 取当前应被远控的窗口 Host 子进程（主窗口优先）。 */
  getHostChild: () => ElectronUtilityProcess | undefined;
}

export interface WebRemoteAccessServerHandle {
  port: number;
  stop(): Promise<void>;
}

/** WS ↔ Host MessagePort 字节透传桥：host 端 AttachServicePort 会为该 port 建 ChannelServer。 */
function bridgeWebSocketToHost(
  ws: WebSocket,
  child: ElectronUtilityProcess,
  logger: WebRemoteAccessServerOptions["logger"],
): void {
  const requestId = randomUUID();
  const attachmentId = randomUUID();
  const { port1, port2 } = new MessageChannelMain();
  // 复用 Host 既有的多客户端 attachment 机制：为 web 客户端开独立 ChannelServer，
  // clientMode=web-remote-replayable（会话落盘可恢复；桌面运行中会话的实时接力由
  // v4 transport 的既有事实流承载）。
  child.postMessage(
    {
      type: "attach-service-port",
      requestId,
      attachmentId,
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    },
    [port2],
  );

  // 帧转换：浏览器端是 SocketProtocol 分帧（13 字节头），Host 端 MessagePortProtocol
  // 是裸消息。原样透传会让 Host 收到带头部垃圾的 RPC 消息、握手死锁（前端黑屏）。
  const decoder = new SocketFrameDecoder();
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    try {
      for (const payload of decoder.push(new Uint8Array(buf))) {
        // 不能把 ArrayBuffer 放进 transfer 列表：MessagePortMain 对 ArrayBuffer transfer
        // 在部分平台会静默丢弃整条消息（与 electronBrowserWebmRecorder 同一坑），
        // 让 structured clone 复制一份即可。
        port1.postMessage(payload);
      }
    } catch (error) {
      // 恶意客户端用「永远凑不齐一帧」的字节流蚕食 main 进程内存：超限即断开并释放 port。
      if (error instanceof FrameDecodeOverflowError) {
        logger.warn(`[web-remote-access] frame limit exceeded, closing client: ${error.message}`);
        port1.close();
        ws.close(1009, "frame limit exceeded");
        return;
      }
      throw error;
    }
  });
  ws.on("close", () => port1.close());
  ws.on("error", () => port1.close());
  port1.on("message", (event: Electron.MessageEvent) => {
    const data = event.data;
    // Host 端 MessagePortProtocol 的 flow-control 对象对浏览器无意义，桥不透传。
    if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      if (ws.readyState === ws.OPEN) ws.send(encodeSocketFrame(new Uint8Array(data)));
      return;
    }
  });
  port1.on("close", () => ws.close());
  port1.start();
  logger.info(`[web-remote-access] remote client attached attachmentId=${attachmentId}`);
}

export function startWebRemoteAccessServer(
  options: WebRemoteAccessServerOptions,
): Promise<WebRemoteAccessServerHandle> {
  return startWebRemoteAccessHttpServer({
    ...options,
    onClientConnected: (ws) => {
      const child = options.getHostChild();
      if (!child) {
        ws.close(1013, "no host process available");
        return;
      }
      bridgeWebSocketToHost(ws, child, options.logger);
    },
  });
}
