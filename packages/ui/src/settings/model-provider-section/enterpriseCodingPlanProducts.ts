// BYOK fork P1a：企业套餐展示模型（静态目录/实时定价/支付参数）随订阅链删除。
// 保留最小类型形状供导航与可见性解析编译；实际产品列表恒为空，解析函数不会被调用出有意义结果。
export interface EnterpriseTeamProjectContext {
  organizationId: string | null;
  organizationName: string | null;
  projectId: string | null;
  projectName: string | null;
  apiKeyStatus: string;
  apiKeyUnavailableReason?: string | null;
  apiKeyUnavailableMessage?: string | null;
}

export interface EnterpriseCodingPlanProductDisplay {
  productId: string;
  family?: "zai" | "bigmodel";
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseTeamProjectContext[];
  apiKeyStatus: string;
  apiKeyUnavailableReason?: string | null;
  apiKeyUnavailableMessage?: string | null;
  [key: string]: unknown;
}

export function resolveEnterpriseCodingPlanProductFamily(
  product: EnterpriseCodingPlanProductDisplay,
): "zai" | "bigmodel" {
  return product.family === "zai" ? "zai" : "bigmodel";
}
