// BYOK fork P1a：IUsageStatsService / CodingPlanRegularTpsRequest 随 usage-stats 删除。

export interface HighspeedTimingMetricsForSavedTime {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}

export function calculateHighspeedSavedDurationMs(params: {
  outputTokens: number;
  regularTps: number;
  highspeedTps: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}): number {
  if (
    !Number.isFinite(params.regularTps) ||
    params.regularTps <= 0 ||
    !Number.isFinite(params.highspeedTps) ||
    params.highspeedTps <= 0
  ) {
    return 0;
  }
  const modelSpeedup = params.highspeedTps / params.regularTps;
  if (!Number.isFinite(modelSpeedup) || modelSpeedup <= 0) return 0;
  if (
    params.modelDurationMs !== undefined &&
    params.toolDurationMs !== undefined &&
    Number.isFinite(params.modelDurationMs) &&
    Number.isFinite(params.toolDurationMs) &&
    params.modelDurationMs >= 0 &&
    params.toolDurationMs >= 0
  ) {
    const modelDurationMs = params.modelDurationMs;
    const toolDurationMs = params.toolDurationMs;
    const otherDurationMs =
      params.otherDurationMs !== undefined &&
      Number.isFinite(params.otherDurationMs) &&
      params.otherDurationMs >= 0
        ? params.otherDurationMs
        : Math.max(0, params.durationMs - modelDurationMs - toolDurationMs);
    // CLI 已把真实模型/工具区间持久化；工具与其它等待不因模型换速而缩短。
    const regularDurationMs = toolDurationMs + otherDurationMs + modelDurationMs * modelSpeedup;
    const actualDurationMs = modelDurationMs + toolDurationMs + otherDurationMs;
    return Math.max(0, Math.round(regularDurationMs - actualDurationMs));
  }
  // Bug 根因：此前把卡级 TPS 直接当成整轮耗时，工具调用时间也被错误地按模型速度缩短。
  // 工具占 20% 且不变，只有模型推理的 80% 按 Highspeed 倍率缩短。
  const highspeedShare = 0.2 + 0.8 / modelSpeedup;
  const estimatedRegularDurationMs = params.durationMs / highspeedShare;
  return Math.max(0, Math.round(estimatedRegularDurationMs - params.durationMs));
}

/**
 * 统一把完成态的真实耗时拆分传入计算器，避免持久化前漏传拆分字段后静默回退到 20/80 估算。
 */
export function calculateHighspeedSavedDurationFromMetrics(
  metrics: HighspeedTimingMetricsForSavedTime,
  regularTps: number,
  highspeedTps: number,
): number {
  return calculateHighspeedSavedDurationMs({
    ...metrics,
    regularTps,
    highspeedTps,
  });
}

// BYOK fork P1a：usage-stats 服务删除后，Coding Plan 健康接口的基准 TPS 查询不再可用；
// 节省时间展示退化为无基准（返回 undefined），加速卡本身不受影响。
export async function readHighspeedRegularTpsFromHealth(_params: {
  preferredProviderId: string;
  accountAccess: unknown;
  timeZone?: string;
}): Promise<number | undefined> {
  return undefined;
}
