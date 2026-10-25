import assert from "node:assert/strict";
import { test } from "vitest";
import { LifecycleQueue } from "../src/main/webRemoteAccess/lifecycleQueue.js";

test("并发提交的任务按提交顺序串行执行，不交错", async () => {
  const queue = new LifecycleQueue();
  const events: string[] = [];
  const makeTask = (name: string, delayMs: number) => async () => {
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    events.push(`${name}:end`);
    return name;
  };
  // a 慢、b 快：b 也必须等 a 完整结束后才开始（回归：并发 applyUpdate 交错孤儿化监听器）。
  const results = await Promise.all([
    queue.run(makeTask("a", 30)),
    queue.run(makeTask("b", 1)),
    queue.run(makeTask("c", 1)),
  ]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("前序任务失败不阻塞后续任务，失败原样交给对应调用方", async () => {
  const queue = new LifecycleQueue();
  await assert.rejects(
    () =>
      queue.run(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  const result = await queue.run(async () => "after-failure");
  assert.equal(result, "after-failure");
});
