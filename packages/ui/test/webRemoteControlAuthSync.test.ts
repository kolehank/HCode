// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";

afterEach(cleanup);

// BYOK fork P1b：OAuth 会话事件（onDidChangeSession）已删，hook 只在恢复完成后
// 投影一次初始登录态；后续 userId 变化不再转发，也不需要事件订阅。
it("恢复完成后投影一次初始登录态，之后不再转发", () => {
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  const { rerender, unmount } = renderHook(
    ({ userId, restoring }) => useWebRemoteControlAuthSync(platform, userId, restoring),
    {
      initialProps: { userId: "" as string | undefined, restoring: true },
    },
  );
  expect(notifyWebRemoteControlAuthStateChanged).not.toHaveBeenCalled();
  rerender({ userId: "user", restoring: false });
  expect(notifyWebRemoteControlAuthStateChanged.mock.calls).toEqual([[{ state: "signed-in" }]]);
  rerender({ userId: undefined, restoring: false });
  unmount();
  expect(notifyWebRemoteControlAuthStateChanged).toHaveBeenCalledTimes(1);
});

it("没有桌面平台通知能力时不调用通知", () => {
  const { result } = renderHook(() => useWebRemoteControlAuthSync({}, "user", false));
  expect(result.current).toBeUndefined();
});
