// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useUiPluginRecommendations } from "@/plugin-ui/adapters/useUiPluginRecommendations.js";

afterEach(cleanup);

// BYOK fork P1a：clientConfigService（厂商远端配置）删除，插件推荐恒为空列表。
// 旧「启用读取 / 迟到结果丢弃」用例改为断言恒空投影、不进入 loading。
it("不再读取远端配置，任何 enabled 状态都返回空推荐且不进入 loading", () => {
  const { result, rerender } = renderHook(({ enabled }) => useUiPluginRecommendations(enabled), {
    initialProps: { enabled: false },
  });
  expect(result.current).toEqual({ recommendations: [], loading: false });
  rerender({ enabled: true });
  expect(result.current).toEqual({ recommendations: [], loading: false });
  rerender({ enabled: false });
  expect(result.current).toEqual({ recommendations: [], loading: false });
});
