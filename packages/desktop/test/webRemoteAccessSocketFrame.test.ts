import assert from "node:assert/strict";
import { test } from "vitest";
import {
  encodeSocketFrame,
  FrameDecodeOverflowError,
  MAX_DECODER_BUFFER_BYTES,
  SocketFrameDecoder,
} from "../src/main/webRemoteAccess/socketFrameBridge.js";
import { ProtocolMessageType } from "@zcode/rpc";

/** 按浏览器 SocketProtocol 的线格式构造 Regular 帧：13 字节头 + body。 */
function encodeBrowserFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(13 + payload.byteLength);
  frame[0] = ProtocolMessageType.Regular;
  const view = new DataView(frame.buffer);
  view.setUint32(9, payload.byteLength, false);
  frame.set(payload, 13);
  return frame;
}

test("浏览器帧 → Host 裸消息：单帧完整到达", () => {
  const decoder = new SocketFrameDecoder();
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const out = decoder.push(encodeBrowserFrame(payload));
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0]], [...payload]);
});

test("帧头与 body 跨 chunk 分片也能正确重组", () => {
  const decoder = new SocketFrameDecoder();
  const frame = encodeBrowserFrame(new Uint8Array([9, 8, 7]));
  const out1 = decoder.push(frame.slice(0, 5)); // 帧头截断
  assert.deepEqual(out1, []);
  const out2 = decoder.push(frame.slice(5, 12)); // body 截断
  assert.deepEqual(out2, []);
  const out3 = decoder.push(frame.slice(12));
  assert.equal(out3.length, 1);
  assert.deepEqual([...out3[0]], [9, 8, 7]);
});

test("多条消息粘包、空 payload、非 Regular 帧丢弃", () => {
  const decoder = new SocketFrameDecoder();
  const ackFrame = new Uint8Array(13);
  ackFrame[0] = ProtocolMessageType.Ack;
  const emptyRegular = encodeBrowserFrame(new Uint8Array(0));
  const first = encodeBrowserFrame(new Uint8Array([10]));
  const second = encodeBrowserFrame(new Uint8Array([20, 30]));
  const out = decoder.push(new Uint8Array([...ackFrame, ...emptyRegular, ...first, ...second]));
  assert.equal(out.length, 3);
  assert.deepEqual([...out[0]], []);
  assert.deepEqual([...out[1]], [10]);
  assert.deepEqual([...out[2]], [20, 30]);
});

test("Host 裸消息 → 浏览器帧：与 rpc SocketProtocol 的读取约定一致", () => {
  const payload = new Uint8Array([4, 5, 6]);
  const frame = encodeSocketFrame(payload);
  assert.equal(frame[0], ProtocolMessageType.Regular);
  assert.equal(new DataView(frame.buffer).getUint32(9, false), payload.byteLength);
  assert.deepEqual([...frame.subarray(13)], [...payload]);

  // 用 SocketFrameDecoder 反解自身产物，验证往返一致性。
  const roundTrip = new SocketFrameDecoder().push(frame);
  assert.equal(roundTrip.length, 1);
  assert.deepEqual([...roundTrip[0]], [...payload]);
});

test("声明长度超限立即拒绝，不等待 body 到齐（防 4GB 声明占住缓冲）", () => {
  const decoder = new SocketFrameDecoder();
  const header = new Uint8Array(13);
  header[0] = ProtocolMessageType.Regular;
  // length 字段（offset 9，u32BE）声明 4GB。
  new DataView(header.buffer).setUint32(9, 0xffffffff, false);
  assert.throws(() => decoder.push(header), FrameDecodeOverflowError);
});

test("缓冲累积超过上限即拒绝：凑不齐一帧的字节流不得无限蚕食内存", () => {
  const decoder = new SocketFrameDecoder(MAX_DECODER_BUFFER_BYTES);
  // 先送一个声明 64MiB body 的帧头把流卡在半帧状态：后续字节永远凑不齐，
  // 只能在缓冲里堆积；超过上限当次 push 即抛（否则单个连接可蚕食 main 进程内存）。
  const partial = new Uint8Array(13);
  partial[0] = ProtocolMessageType.Regular;
  new DataView(partial.buffer).setUint32(9, 64 * 1024 * 1024, false);
  const chunk = new Uint8Array(1024 * 1024);
  assert.throws(() => {
    decoder.push(partial);
    for (let pushed = 0; pushed <= MAX_DECODER_BUFFER_BYTES; pushed += chunk.byteLength) {
      decoder.push(chunk);
    }
  }, FrameDecodeOverflowError);
});

test("单条 1MB 消息内 8 万个小帧的解析是均摊线性的（回归：逐帧 slice 拷贝 O(n²) 卡死事件循环）", () => {
  const decoder = new SocketFrameDecoder();
  // 8 万个 13 字节 None 空 帧；旧实现需 25s+，线性实现应在百毫秒量级。
  const payload = new Uint8Array(1024 * 1024);
  const startedAt = Date.now();
  const out = decoder.push(payload);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 5000, `解析耗时 ${elapsed}ms，应为均摊线性`);
  assert.equal(out.length, 0); // None 帧全部丢弃
});

test("返回的 payload 是独立拷贝，不与解码器内部缓冲共享内存", () => {
  const decoder = new SocketFrameDecoder();
  const out = decoder.push(encodeBrowserFrame(new Uint8Array([7, 7, 7])));
  assert.equal(out.length, 1);
  const view = out[0];
  // 继续解码新消息改写内部缓冲后，先前返回的 payload 不应被波及。
  decoder.push(encodeBrowserFrame(new Uint8Array([9, 9, 9, 9])));
  assert.deepEqual([...view], [7, 7, 7]);
});
