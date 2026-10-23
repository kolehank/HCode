// BYOK fork P1a：request-verification 依赖厂商订阅服务，删除后预检恒为空 proof；
// 上层 claimManualPlan 已不可达（服务已删），保留导出以维持模块边界。
import type { RequestVerificationProof } from "@zcode/shared";
export function useRequestVerificationPrewarm(_visible: boolean): void {}
export async function prepareRequestVerificationClaim(
  _service: unknown,
  signal: AbortSignal,
  _onVerifying: () => void,
): Promise<RequestVerificationProof | undefined> {
  signal.throwIfAborted();
  return {};
}
