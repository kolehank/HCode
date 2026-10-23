// BYOK A2：浏览器 SocketProtocol 分帧 ↔ Host MessagePortProtocol 裸消息 的帧转换。
//
// 内嵌 server 的 WS 桥两端协议不同：
// - 浏览器端 connectViaWebSocket 用 SocketProtocol——每条 RPC 消息带 13 字节帧头
//   （type u8 | id u32BE | ack u32BE | length u32BE，见 packages/rpc/src/protocol.ts）；
// - Host 端 attachment registry 用 MessagePortProtocol——每条端口消息就是裸 VSBuffer，
//   没有帧头。
// 桥必须做帧转换：解出 Regular 帧的 body 再投递给端口，反向为裸消息包上 Regular 帧。
// 之前原样透传字节，Host 收到的每条消息都带着帧头垃圾，ChannelServer 解析失败，
// 浏览器端 connectViaWebSocket 的握手永远等不到应答（黑屏、无任何报错）。
//
// 为什么不用 ChunkStream（@zcode/rpc）：ChunkStream.read 对剩余缓冲逐帧 slice，
// 而 VSBuffer 底层是普通 Uint8Array，slice 是整段拷贝——一条 1MB WS 消息里塞 8 万个
// 小帧的解析耗时是 O(n²)（实测 25s，main 进程事件循环整段卡死）。这里自带
// 倍增扩容的增量缓冲：每次 push 只做一次 O(chunk) 拷贝，解析按 offset 前进零拷贝。
import { ProtocolMessageType } from "@zcode/rpc";

/** SocketProtocol 的帧头长度：type(1) + id(4) + ack(4) + length(4)。 */
const SOCKET_HEADER_SIZE = 13;

/** 单帧声明长度的硬上限：length 字段本身可声明到 4GB，等到 body 是纯浪费，超限直接拒绝。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * 解码缓冲累积上限：客户端只需发送「永远凑不齐一帧」的字节即可让缓冲无上限增长，
 * main 进程内存被单个 WS 连接蚕食直到 OOM。超过上限必须断开该连接。
 */
export const MAX_DECODER_BUFFER_BYTES = 32 * 1024 * 1024;

/** 帧解码超限：调用方应将对应 WS 以 1009（Message Too Big）关闭。 */
export class FrameDecodeOverflowError extends Error {
  constructor(reason: string) {
    super(`socket frame decode overflow: ${reason}`);
    this.name = "FrameDecodeOverflowError";
  }
}

/**
 * 增量解码浏览器方向的 SocketProtocol 帧，产出 Regular 帧的 payload（即 Host 端
 * MessagePortProtocol 期望的裸消息，返回值为独立拷贝）。非 Regular 帧（Ack/KeepAlive
 * 等 socket 层帧）在 Host 的 MessagePort 上没有对应概念，丢弃。
 */
export class SocketFrameDecoder {
  static readonly #EMPTY = Buffer.allocUnsafe(0);

  #buffer: Buffer = SocketFrameDecoder.#EMPTY;
  #offset = 0; // 已消费字节数
  #length = 0; // 有效字节数
  readonly #maxBufferBytes: number;

  constructor(maxBufferBytes = MAX_DECODER_BUFFER_BYTES) {
    this.#maxBufferBytes = maxBufferBytes;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const pending = this.#length - this.#offset;
    const needed = pending + incoming.byteLength;
    // 仅在空间不足时整理（搬到头部）+ 倍增扩容：总拷贝量对总字节数均摊 O(1)。
    if (needed > this.#buffer.byteLength - this.#offset) {
      const capacity = Math.max(needed, this.#buffer.byteLength * 2, 4096);
      const next = Buffer.allocUnsafe(capacity);
      if (pending > 0) {
        this.#buffer.copy(next, 0, this.#offset, this.#length);
      }
      this.#buffer = next;
      this.#offset = 0;
      this.#length = pending;
    }
    incoming.copy(this.#buffer, this.#length);
    this.#length += incoming.byteLength;

    // 缓冲上限要在解析前判定：声明超长帧的客户端可能永远凑不齐 body，字节只会堆积。
    if (this.#length - this.#offset > this.#maxBufferBytes) {
      throw new FrameDecodeOverflowError(
        `buffered ${this.#length - this.#offset} bytes exceeds limit ${this.#maxBufferBytes}`,
      );
    }

    const payloads: Uint8Array[] = [];
    for (;;) {
      if (this.#length - this.#offset < SOCKET_HEADER_SIZE) break;
      const type = this.#buffer.readUInt8(this.#offset);
      const length = this.#buffer.readUInt32BE(this.#offset + 9);
      // length 在等到 body 之前就判定：4GB 级声明不该占用缓冲等待。
      if (length > MAX_FRAME_BYTES) {
        throw new FrameDecodeOverflowError(`declared frame length ${length} exceeds limit`);
      }
      const frameBytes = SOCKET_HEADER_SIZE + length;
      if (this.#length - this.#offset < frameBytes) break;
      const bodyStart = this.#offset + SOCKET_HEADER_SIZE;
      if (type === ProtocolMessageType.Regular) {
        // new Uint8Array(view) 产生独立拷贝：payload 交由调用方投递/持有，
        // 不与内部缓冲共享内存（内部缓冲会被复用改写）。
        payloads.push(new Uint8Array(this.#buffer.subarray(bodyStart, bodyStart + length)));
      }
      this.#offset += frameBytes;
    }
    // 全部消费完则归还缓冲，避免长期持有一大块内存。
    if (this.#offset === this.#length) {
      this.#buffer = SocketFrameDecoder.#EMPTY;
      this.#offset = 0;
      this.#length = 0;
    }
    return payloads;
  }
}

/** 把 Host 端裸消息包装成浏览器 SocketProtocol 期望的 Regular 帧。 */
export function encodeSocketFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(SOCKET_HEADER_SIZE + payload.byteLength);
  frame[0] = ProtocolMessageType.Regular;
  const view = new DataView(frame.buffer);
  view.setUint32(9, payload.byteLength, false);
  frame.set(payload, SOCKET_HEADER_SIZE);
  return frame;
}
