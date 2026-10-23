// BYOK fork P1a：动态工作流的远端灰度源（codingPlanSubscriptionService）已删除。
// 保留 hook 形状以最小化消费方改动：availability 恒 disabled，user mode sync 变 no-op。
import { useEffect, useMemo } from "react";

export interface DynamicWorkflowAvailabilitySnapshot {
  status: "loading" | "ready";
  enabled: boolean;
  config: null;
}
export type { DynamicWorkflowAvailabilitySnapshot as default };

export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  const snapshot = useMemo<DynamicWorkflowAvailabilitySnapshot>(
    () => ({ status: "ready", enabled: false, config: null }),
    [],
  );
  return snapshot;
}

export function useDynamicWorkflowAvailabilityLoader(_service: unknown): void {
  useEffect(() => {}, []);
}

export function useDynamicWorkflowUserModeSync(params: {
  settingsLoaded: boolean;
  userMode?: unknown;
  zcodeAgentService?: unknown;
  codingPlanSubscriptionService?: unknown;
}): void {
  void params;
  useEffect(() => {}, []);
}
