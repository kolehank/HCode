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

  it("基址为空：返回 undefined（展示基址应先经 resolveWebAccessDisplayBaseUrl 解析）", () => {
    expect(buildAccessUrl("", "tok")).toBeUndefined();
    expect(buildAccessUrl("   ", "tok")).toBeUndefined();
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
