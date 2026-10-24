import { describe, expect, it } from "vitest";
import {
  isUtcPlusEightTimeZone,
  resolveRemoteCdnBaseUrls,
  shouldPreferDomesticRemoteCdn,
} from "../src/main/remoteCdn.js";

describe("remoteCdn", () => {
  it("中文且东八区时应优先国内 CDN", () => {
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe(true);
    // BYOK fork P6：厂商 CDN 已移除，缺省 fail-closed 返回空列表（自托管经 ZCODE_CDN_BASE_URL 配置）。
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual([]);
  });

  it("非中文或非东八区时应优先海外 CDN", () => {
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "en-US",
        timeZone: "Asia/Shanghai",
      }),
    ).toBe(false);
    expect(
      shouldPreferDomesticRemoteCdn({
        locale: "zh-CN",
        timeZone: "America/Los_Angeles",
      }),
    ).toBe(false);
    expect(
      resolveRemoteCdnBaseUrls({
        env: "production",
        locale: "zh-CN",
        timeZone: "America/Los_Angeles",
        version: "0.0.0-test",
      }),
    // BYOK fork P6：厂商 CDN 已移除，缺省 fail-closed 返回空列表。
    ).toEqual([]);
  });

  it("东八区判断应按 UTC 偏移而不是固定城市名单", () => {
    expect(isUtcPlusEightTimeZone("Asia/Shanghai")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Singapore")).toBe(true);
    expect(isUtcPlusEightTimeZone("Asia/Tokyo")).toBe(false);
  });

  it("测试产品环境应固定使用内网 SSH remote assets 根目录", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual([
      "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
    ]);
  });

  it("显式覆盖 CDN 基址时不再按产品环境选择默认值", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });
});
