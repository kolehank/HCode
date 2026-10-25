import { describe, expect, it } from "vitest";
import {
  buildAccessUrl,
  validateWebAccessUpdateCrossFields,
  webAccessUpdateSchema,
} from "../src/webAccess/webAccessConfig.js";

describe("buildAccessUrl", () => {
  it("基址已配置：裁掉尾部斜杠后拼 #token", () => {
    expect(buildAccessUrl("http://192.168.5.9:30330///", "tok")).toBe(
      "http://192.168.5.9:30330/#token=tok",
    );
  });

  it("基址为空且无回退端口：返回 undefined（调用方按无链接处理）", () => {
    expect(buildAccessUrl("", "tok")).toBeUndefined();
    expect(buildAccessUrl("   ", "tok")).toBeUndefined();
  });

  it("基址为空且提供回退端口：回退本机回环（仅展示语义）", () => {
    expect(buildAccessUrl("", "tok", 30330)).toBe("http://127.0.0.1:30330/#token=tok");
    expect(buildAccessUrl("", "tok", 0)).toBeUndefined();
  });

  it("基址已配置时忽略回退端口，以用户配置为准", () => {
    expect(buildAccessUrl("https://zcode.example.com", "tok", 30330)).toBe(
      "https://zcode.example.com/#token=tok",
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
