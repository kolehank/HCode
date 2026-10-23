// BYOK A2：controller 生命周期操作的串行化队列（纯逻辑，无依赖，便于单测）。
// 背景：applyUpdate 的「停旧-起新」中 start 在 await 之后才赋值 #handle，两次并发保存
// 交错时，后发操作的失败分支会把先发操作刚赋值的存活 handle 置 null，监听器孤儿化、
// 永远无法 stop（审查发现 P2-5）。所有生命周期入口都必须经此队列执行。
export type LifecycleTask<T> = () => Promise<T>;

export class LifecycleQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /** 串行执行：任务按提交顺序依次运行，前一个完成（含失败）后才开始下一个。 */
  run<T>(task: LifecycleTask<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    // 队尾吞掉失败以保证后续任务照常执行；失败通过返回的 result 交给调用方处理。
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
