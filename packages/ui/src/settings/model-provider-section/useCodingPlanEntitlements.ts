// BYOK fork P1a：Coding Plan 权益刷新 hook（usage-stats 依赖）已删除。保留最小形状：恒空映射。
import { useCallback } from "react";

export interface CodingPlanEntitlementStub {
  loading: boolean;
  snapshot: null;
  error: string | null;
  refresh: (options?: { force?: boolean; silent?: boolean; reason?: string }) => Promise<void>;
}

export function useCodingPlanEntitlements(_params: {
  providerSettingsView?: unknown;
  connectionSelections?: unknown;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Record<string, CodingPlanEntitlementStub>;
  enabledStartPlanProviderIds: string[];
  refresh: (options?: { force?: boolean; silent?: boolean; reason?: string }) => Promise<void>;
} {
  const refresh = useCallback(async () => {}, []);
  return { entitlements: {}, enabledStartPlanProviderIds: [], refresh };
}

export function useCodingPlanAccessRefresh(_params?: {
  refresh?: (options?: { force?: boolean; silent?: boolean; reason?: string }) => Promise<void>;
  selectedPlanKey?: string | null;
}): { refresh: () => Promise<void> } {
  const refresh = useCallback(async () => {}, []);
  return { refresh };
}
