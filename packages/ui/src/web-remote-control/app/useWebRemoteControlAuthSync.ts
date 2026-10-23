import { useEffect, useRef } from "react";
import type { WebRemoteControlAuthPlatform } from "@/web-remote-control/contract.js";

/** 初始恢复同步一次投影；BYOK fork P1b 后无 OAuth 会话事件，只投影一次 signed-out。 */
export function useWebRemoteControlAuthSync(
  platform: WebRemoteControlAuthPlatform,
  userId: string | undefined,
  restoring: boolean,
): void {
  const initialStateSynced = useRef(false);
  useEffect(() => {
    if (restoring || initialStateSynced.current) return;
    initialStateSynced.current = true;
    platform.notifyWebRemoteControlAuthStateChanged?.({
      state: userId ? "signed-in" : "signed-out",
    });
  }, [platform, userId, restoring]);
}
