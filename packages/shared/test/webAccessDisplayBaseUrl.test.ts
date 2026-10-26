import { describe, expect, it } from "vitest";
import { resolveWebAccessDisplayBaseUrl } from "../src/platform.js";

describe("resolveWebAccessDisplayBaseUrl（展示回退链：基址 > 建议网卡 > 回环）", () => {
  it("已配置基址：裁尾斜杠后原样返回，任何档位都优先用户配置", () => {
    expect(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: "https://zcode.example.com///",
        mode: "token",
        port: 30330,
        suggestedAddress: "192.168.5.9",
      }),
    ).toBe("https://zcode.example.com");
  });

  it("open 档：即使有建议网卡也回退本机回环（open 档强制绑回环，LAN 地址必不可达）", () => {
    expect(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: "",
        mode: "open",
        port: 30330,
        suggestedAddress: "192.168.5.9",
      }),
    ).toBe("http://127.0.0.1:30330");
  });

  it("token/CF 档：基址为空时优先建议网卡（二维码给其他设备扫）", () => {
    expect(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: "",
        mode: "token",
        port: 30330,
        suggestedAddress: "192.168.5.9",
      }),
    ).toBe("http://192.168.5.9:30330");
    expect(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: "   ",
        mode: "cloudflare-access",
        port: 30330,
        suggestedAddress: "100.101.1.2",
      }),
    ).toBe("http://100.101.1.2:30330");
  });

  it("token/CF 档无建议网卡：回退本机回环", () => {
    expect(
      resolveWebAccessDisplayBaseUrl({ externalBaseUrl: "", mode: "token", port: 30330 }),
    ).toBe("http://127.0.0.1:30330");
  });

  it("port 未就绪（server 未运行）：返回空串，调用方按无链接处理", () => {
    expect(
      resolveWebAccessDisplayBaseUrl({
        externalBaseUrl: "",
        mode: "token",
        port: 0,
        suggestedAddress: "192.168.5.9",
      }),
    ).toBe("");
    expect(resolveWebAccessDisplayBaseUrl({ externalBaseUrl: "", mode: "open", port: 0 })).toBe("");
  });
});
