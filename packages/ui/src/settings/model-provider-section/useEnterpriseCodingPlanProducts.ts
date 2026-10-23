// BYOK fork P1a：企业套餐目录（实时定价/订阅列表）依赖厂商订阅服务，已删除。
// 保留 hook 形状：snapshot 恒为空目录。
import { useCallback } from "react";

export interface EnterpriseProductsStub {
  snapshot: { productList: never[] } | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEnterpriseCodingPlanProducts(_params: {
  enabled?: boolean;
  authenticated?: boolean;
  family?: "zai" | "bigmodel";
  staticOnly?: boolean;
}): EnterpriseProductsStub {
  const refresh = useCallback(async () => {}, []);
  return { snapshot: null, loading: false, error: null, refresh };
}

export type EnterpriseCodingPlanProductGroup = {
  key: string;
  title: string;
  products: never[];
};

export function useEnterpriseCodingPlanProductGroups(): EnterpriseCodingPlanProductGroup[] {
  return [];
}
