// BYOK fork P1a：Start Plan 推荐的额度事实源（usage-stats / startPlanQuotaBuckets）已删除。
// 保留纯比较函数；推荐本身恒返回 null（不做套餐升级推荐）。
import type { ModelSelection } from "@zcode/shared";

/** 只改思考档位、继承或其他字段不属于模型更换。 */
export function hasExplicitModelChanged(
  previous: ModelSelection | null | undefined,
  next: ModelSelection | null | undefined,
): next is ModelSelection {
  return Boolean(
    next && (previous?.providerId !== next.providerId || previous.modelId !== next.modelId),
  );
}
