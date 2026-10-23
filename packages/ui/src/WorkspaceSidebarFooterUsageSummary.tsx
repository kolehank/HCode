// BYOK fork P1a：侧栏套餐余额汇总（Coding Plan 剩余额度）依赖 usage-stats / coding-plan-subscription，
// 已整体删除。保留导出形状：state 恒为空态（不渲染余额/升级入口）。
import type { ReactNode } from "react";

export function WorkspaceSidebarFooterUsageSummary(_props: {
  enabled: boolean;
  onUsageClick?: () => void;
  onUpgradeClick?: (providerId: string, funnelContext: unknown) => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}): ReactNode {
  return null;
}

export function useWorkspaceSidebarFooterUsageSummaryState(_params: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  return {
    upgradeTargetProviderId: null as string | null,
  } as const;
}

export type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent(_props: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
  onUpgradeClick?: (providerId: string, funnelContext: unknown) => void;
}): ReactNode {
  return null;
}
