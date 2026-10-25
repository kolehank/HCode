import { describe, expect, it } from "vitest";
import { nextExternalBaseUrlOnSelection } from "../src/settings/RemoteAccessSection.js";
import type { WebAccessInterfaceItem } from "@zcode/shared";

const INTERFACES: WebAccessInterfaceItem[] = [
  {
    name: "Ethernet0",
    address: "192.168.5.9",
    family: "IPv4",
    isTailscale: false,
    suggested: false,
  },
  { name: "Tailscale", address: "100.101.1.2", family: "IPv4", isTailscale: true, suggested: true },
];

const PORT = 30330;

describe("nextExternalBaseUrlOnSelection（网卡联动：未手填跟随、手填优先）", () => {
  it("基址为空：跟随新选择的网卡", () => {
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: "",
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "100.101.1.2",
        interfaces: INTERFACES,
        port: PORT,
      }),
    ).toBe(`http://100.101.1.2:${PORT}`);
  });

  it("基址仍是上一条自动建议：切换网卡时跟随新建议", () => {
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: `http://192.168.5.9:${PORT}`,
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "100.101.1.2",
        interfaces: INTERFACES,
        port: PORT,
      }),
    ).toBe(`http://100.101.1.2:${PORT}`);
  });

  it("用户手填域名/反代地址：不被覆盖", () => {
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: "https://zcode.example.com",
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "100.101.1.2",
        interfaces: INTERFACES,
        port: PORT,
      }),
    ).toBeUndefined();
  });

  it("手填值恰好等于建议值（等价于未手填）：仍跟随", () => {
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: ` http://192.168.5.9:${PORT} `,
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "100.101.1.2",
        interfaces: INTERFACES,
        port: PORT,
      }),
    ).toBe(`http://100.101.1.2:${PORT}`);
  });

  it("目标网卡不存在或端口未就绪：保持输入不变", () => {
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: "",
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "10.0.0.1",
        interfaces: INTERFACES,
        port: PORT,
      }),
    ).toBeUndefined();
    expect(
      nextExternalBaseUrlOnSelection({
        currentBaseUrl: "",
        previousSelectedAddress: "192.168.5.9",
        nextAddress: "100.101.1.2",
        interfaces: INTERFACES,
        port: 0,
      }),
    ).toBeUndefined();
  });
});
