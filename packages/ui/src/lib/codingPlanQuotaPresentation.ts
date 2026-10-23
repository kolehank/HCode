// BYOK fork P1a：Coding Plan 额度展示辅助（MCP 配额、重置时间格式化）随 usage-stats 删除。
// 保留最小导出供导航解析编译；额度恒为 undefined。
import type { UsageQuotaLimit } from "@zcode/shared";

export function resolveMcpQuotaLimit(_snapshot: unknown): UsageQuotaLimit | undefined {
  return undefined;
}
