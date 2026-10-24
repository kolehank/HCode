import { describe, expect, it, vi } from "vitest";
import { ensureRemoteServerDeviceMid } from "../src/stdioDeviceMid.js";

// BYOK fork P0：远端 deviceMid（厂商 X-Device-Mid 请求头）已删除，恒返回 undefined。
describe("ensureRemoteServerDeviceMid", () => {
  it("BYOK fork 下恒为 no-op，不生成设备身份也不打日志", async () => {
    const log = vi.fn();
    const ensureDeviceMid = vi.fn(async () => "device-mid-remote");

    await expect(ensureRemoteServerDeviceMid({ ensureDeviceMid, log })).resolves.toBeUndefined();
    expect(ensureDeviceMid).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
