import assert from "node:assert/strict";
import { test } from "vitest";
import { ActiveAccessToken } from "../src/main/webRemoteAccess/activeAccessToken.js";

test("初始为空：本进程没有生成过明文时不提供链接", () => {
  const cache = new ActiveAccessToken();
  assert.equal(cache.get(), null);
});

test("生成本进程明文后可重复读取（弹窗/设置页共用同一链接）", () => {
  const cache = new ActiveAccessToken();
  cache.noteGenerated("tok-1", "hash-1");
  assert.equal(cache.get(), "tok-1");
  assert.equal(cache.get(), "tok-1");
});

test("hash 未变的重载保留明文：只改基址/开关后不需要用户重新生成", () => {
  const cache = new ActiveAccessToken();
  cache.noteGenerated("tok-1", "hash-1");
  cache.noteConfigLoaded("token", "hash-1");
  assert.equal(cache.get(), "tok-1");
});

test("hash 变化（外部改写磁盘）必须丢弃明文，避免旧明文配到新 hash", () => {
  const cache = new ActiveAccessToken();
  cache.noteGenerated("tok-1", "hash-1");
  cache.noteConfigLoaded("token", "hash-2");
  assert.equal(cache.get(), null);

  // 清空后再对齐同一旧 hash，也不能把已丢弃的明文还原。
  cache.noteConfigLoaded("token", "hash-1");
  assert.equal(cache.get(), null);
});

test("切离 token 档丢弃明文，切回也不恢复", () => {
  const cache = new ActiveAccessToken();
  cache.noteGenerated("tok-1", "hash-1");
  cache.noteConfigLoaded("open", "hash-1");
  assert.equal(cache.get(), null);

  cache.noteConfigLoaded("token", "hash-1");
  assert.equal(cache.get(), null);
});

test("重新生成覆盖为新明文", () => {
  const cache = new ActiveAccessToken();
  cache.noteGenerated("tok-1", "hash-1");
  cache.noteGenerated("tok-2", "hash-2");
  assert.equal(cache.get(), "tok-2");
});
