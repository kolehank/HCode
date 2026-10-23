import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  UsageLedgerStore,
  type UsageLedgerAppendRow,
  type UsageLedgerEntry,
  type UsageLedgerGroupBy,
  type UsageLedgerSummaryRow,
} from "./usageLedgerStore.js";

/** usage.delta 事实（CLI 侧 model_request_completed 的协议投影）在 host 侧的 sink 输入。 */
export type UsageDeltaFact = Extract<ConversationTelemetryFact, { kind: "usage.delta" }>;

export interface UsageDeltaFactEvent {
  /** workspaceIdentity?.trim() || workspacePath，与全仓库身份键口径一致。 */
  workspaceKey: string;
  fact: UsageDeltaFact;
}

export interface UsageLedgerSummaryQuery {
  /** Unix ms 下界（含）；缺省 = 全量。 */
  sinceTs?: number;
  groupBy: UsageLedgerGroupBy;
}

/**
 * 本地 token 用量账本服务（BYOK P5）。
 *
 * 数据流：CLI runner 发 `model_request_completed`（ModelStatusSink 管道）→ CLI bootstrap 归一为
 * `usage.delta` 会话埋点事实 → host 在 conversationTelemetryFact 通知入口旁路投给本服务。
 * 与已删除的 ModelApiTelemetryStatusSink 同型：纯本地旁路观测口，publish 侧不感知账本存在，
 * 账本内部异常绝不能反噬事件管道。
 *
 * 口径：只记成功请求（`model_request_failed` 不产 usage.delta，天然不记）；主轮 / subagent /
 * workflow_child 的请求 usage（标题 sidecar 与 compact 的 usage 在 CLI 侧即不外送）。
 * 红线：仅本地落盘，永不作为任何上报源；不做价格/成本。
 */
export interface IUsageLedgerService {
  /**
   * 本地 sink 入口（fire-and-forget）：一条 usage.delta 追加一行账本。
   * 同步返回；内部串行落库以保持事件到达顺序，异常只记服务日志。
   */
  recordUsageDelta(event: UsageDeltaFactEvent): void;
  /** 按时间窗 + 维度聚合；`bucket` 语义见 UsageLedgerSummaryRow。 */
  getUsageSummary(query: UsageLedgerSummaryQuery): Promise<UsageLedgerSummaryRow[]>;
  /** 最近若干条原始账本行（调试/明细用，上限 500）。 */
  getRecentUsage(limit: number): Promise<UsageLedgerEntry[]>;
}

export const IUsageLedgerService = createServiceDescriptor<IUsageLedgerService>(
  ServiceChannels.UsageLedger,
);

/** 账本写入的串行队列：usage.delta 到达顺序即落库顺序（懒初始化是异步的，不能并发抢跑）。 */
type AppendTask = Promise<unknown>;

export function createUsageLedgerService(options?: {
  /** 测试注入临时库路径；生产缺省 ~/.zcode/v2/usage-ledger.sqlite。 */
  dbPath?: string;
}): IUsageLedgerService & { close(): void } {
  const store = new UsageLedgerStore(options?.dbPath);
  const logger = createServiceLogger("usage-ledger");
  let appendQueue: AppendTask = Promise.resolve();

  return {
    recordUsageDelta(event: UsageDeltaFactEvent): void {
      const fact = event.fact;
      const row: UsageLedgerAppendRow = {
        // usage.delta 没带 provider/model 时（CLI 侧 completed request 匹配失败的兼容路径），
        // 仍记 token 数，维度落 unknown，保证账本守恒不丢量。
        ts: typeof fact.occurredAt === "number" ? fact.occurredAt : Date.now(),
        providerId: fact.providerId?.trim() || "unknown",
        model: fact.modelId?.trim() || "unknown",
        sessionId: fact.sessionId,
        workspaceKey: event.workspaceKey,
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
        reasoningTokens: fact.reasoningTokens,
        cacheReadTokens: fact.cacheReadTokens,
        cacheWriteTokens: fact.cacheWriteTokens,
      };
      appendQueue = appendQueue
        .then(() => store.append(row))
        .catch((error: unknown) => {
          // 旁路 sink 不能反噬事件管道：落库失败只记日志，不影响会话消息流。
          logger.warn(undefined, "写入本地用量账本失败", error);
        });
    },

    async getUsageSummary(query: UsageLedgerSummaryQuery): Promise<UsageLedgerSummaryRow[]> {
      return store.getUsageSummary({
        sinceTs: query.sinceTs,
        groupBy: query.groupBy,
      });
    },

    async getRecentUsage(limit: number): Promise<UsageLedgerEntry[]> {
      return store.getRecentUsage(limit);
    },

    close(): void {
      store.close();
    },
  };
}
