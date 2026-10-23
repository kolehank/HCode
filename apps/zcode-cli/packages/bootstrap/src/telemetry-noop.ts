import type {
  AgentExecutionTelemetryPort,
  ModelExecutionTelemetryPort,
} from "@zcode/contracts";
import type { ModelStatusSink } from "@zcode/contracts/model";

/**
 * BYOK fork P0：原 @zcode/telemetry（OTLP Trace/Metric 导出）已整体移除。
 * 这里保留同形 no-op 接缝，让 App 工厂的既有 telemetry 接线继续编译通过，
 * 且在宿主未注入进程级 Owner 时与原 disabled 路径行为一致：零出网、零上报。
 */

export interface ModelTelemetryBootstrap {
  agentExecution: AgentExecutionTelemetryPort;
  enabled: boolean;
  modelExecution: ModelExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

export interface CreateModelTelemetryOptions {
  owner?: unknown;
  sessionId?: string;
}

/**
 * 通用 noop 端口：任意方法调用返回另一个 noop 端口，兼容
 * Port → SpanWriter → mark/finish 的链式调用面；captureCausation 按契约返回 undefined。
 *
 * 两个必须按契约特判的属性，否则 no-op 会静默杀死整个 turn 生命周期：
 * - `run`：AgentTelemetryScope.run(execute) 契约要求执行回调并返回其结果
 *   （contracts agent-execution.ts）。turn 全部执行体都在 turnTelemetry.run(execute)
 *   里，回调被丢弃 = turn 永不启动且无任何日志。
 * - `then`：返回函数会让 noop 对象意外成为 thenable，且 resolve/reject 被忽略，
 *   任何 `await noopPort(...)` 都会永久挂起（runRuntimeCommand 的 drain 因此卡死，
 *   后续所有命令饿死）。必须返回 undefined 保持非 thenable。
 */
function createNoopPort<T>(): T {
  const handler: ProxyHandler<object> = {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "run") return (execute: () => unknown) => execute();
      if (prop === "captureCausation") return () => undefined;
      return () => createNoopPort();
    },
  };
  return new Proxy(function noopPort() {}, handler) as T;
}

export function createModelTelemetry(
  _options: CreateModelTelemetryOptions = {},
): ModelTelemetryBootstrap {
  const noop = createNoopPort<AgentExecutionTelemetryPort & ModelExecutionTelemetryPort>();
  return {
    agentExecution: noop,
    enabled: false,
    modelExecution: noop,
    async shutdown() {},
  };
}
