import { describe, expect, it } from "vitest";
import {
  buildAccessUrl,
  getDefaultWebAccessConfig,
  sanitizeWebAccessConfig,
  validateWebAccessUpdateCrossFields,
  webAccessUpdateSchema,
} from "../src/webAccess/webAccessConfig.js";

describe("quickTunnelEnabled（临时公网通道开关）", () => {
  it("默认关闭；旧配置文件缺少该字段时由 schema 默认值兜底", () => {
    expect(getDefaultWebAccessConfig().quickTunnelEnabled).toBe(false);
    // 入参 schema 保持可选：未携带时由 controller 与磁盘当前值合并，而不是强制重置。
    expect(webAccessUpdateSchema.parse({ mode: "token" }).quickTunnelEnabled).toBeUndefined();
    expect(
      webAccessUpdateSchema.parse({ mode: "token", quickTunnelEnabled: true }).quickTunnelEnabled,
    ).toBe(true);
  });

  it("sanitize 视图透出开关（不含任何凭据）", () => {
    const view = sanitizeWebAccessConfig({
      ...getDefaultWebAccessConfig(),
      mode: "token",
      quickTunnelEnabled: true,
    });
    expect(view.quickTunnelEnabled).toBe(true);
    expect(view).not.toHaveProperty("tokenHash");
  });
});

describe("buildAccessUrl", () => {
  it("基址已配置：裁掉尾部斜杠后拼 #token", () => {
    expect(buildAccessUrl("http://192.168.5.9:30330///", "tok")).toBe(
      "http://192.168.5.9:30330/#token=tok",
    );
  });

  it("基址为空：返回 undefined（展示基址应先经 resolveWebAccessDisplayBaseUrl 解析）", () => {
    expect(buildAccessUrl("", "tok")).toBeUndefined();
    expect(buildAccessUrl("   ", "tok")).toBeUndefined();
  });

  it("设备标识：追加到 fragment 并 URL 编码（fragment 不进代理日志）", () => {
    expect(buildAccessUrl("http://192.168.5.9:30330/", "tok", "my host")).toBe(
      "http://192.168.5.9:30330/#token=tok&device=my%20host",
    );
    // 空白设备名视为未提供，保持旧格式（server 形态不生成设备参数）。
    expect(buildAccessUrl("http://192.168.5.9:30330", "tok", "   ")).toBe(
      "http://192.168.5.9:30330/#token=tok",
    );
  });
});

describe("validateWebAccessUpdateCrossFields", () => {
  it("CF 档缺域名/AUD、域名带 scheme 均拒绝；合法 externalBaseUrl 通过", () => {
    const parse = (input: Record<string, unknown>) =>
      webAccessUpdateSchema.parse(input) as unknown as Parameters<
        typeof validateWebAccessUpdateCrossFields
      >[0];

    expect(validateWebAccessUpdateCrossFields(parse({ mode: "cloudflare-access" }))).toMatch(
      /requires cfTeamDomain and cfAud/,
    );
    expect(
      validateWebAccessUpdateCrossFields(
        parse({ mode: "cloudflare-access", cfTeamDomain: "https://t.cfaccess.com", cfAud: "a" }),
      ),
    ).toMatch(/bare hostname/);
    expect(
      validateWebAccessUpdateCrossFields(
        parse({ mode: "open", externalBaseUrl: "ftp://example.com" }),
      ),
    ).toMatch(/http:\/\/ or https:\/\//);
    expect(
      validateWebAccessUpdateCrossFields(
        parse({ mode: "cloudflare-access", cfTeamDomain: "t.cfaccess.com", cfAud: "a" }),
      ),
    ).toBeNull();
    expect(
      validateWebAccessUpdateCrossFields(parse({ mode: "open", externalBaseUrl: "" })),
    ).toBeNull();
  });
});
