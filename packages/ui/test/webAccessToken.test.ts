import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachWebAccessTokenToUrl,
  clearWebAccessToken,
  consumeWebAccessTokenFromHash,
  fetchWithWebAccessToken,
  getWebAccessDevice,
  getWebAccessToken,
} from "@/lib/webAccessToken.js";

interface FakeWindow {
  store: Map<string, string>;
  replaceState: ReturnType<typeof vi.fn>;
}

function installWindow(hash: string): FakeWindow {
  const store = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    location: { hash, pathname: "/", search: "" },
    history: { replaceState },
  });
  return { store, replaceState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webAccessToken：token + 设备标识引导", () => {
  it("从 fragment 读取 token 与 device，并清理地址栏", () => {
    const fake = installWindow("#token=tok-123&device=Desk-Top.");
    expect(consumeWebAccessTokenFromHash()).toBe("tok-123");
    expect(getWebAccessToken()).toBe("tok-123");
    expect(getWebAccessDevice()).toBe("Desk-Top.");
    expect(fake.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("WS URL 同时附加 token 与 device（已有 query 时正确续接）", () => {
    installWindow("#token=tok-123&device=Desk Top");
    consumeWebAccessTokenFromHash();
    expect(attachWebAccessTokenToUrl("ws://host/ws?remote=r1")).toBe(
      "ws://host/ws?remote=r1&token=tok-123&device=Desk%20Top",
    );
    expect(attachWebAccessTokenToUrl("ws://host/ws")).toBe(
      "ws://host/ws?token=tok-123&device=Desk%20Top",
    );
  });

  it("API fetch 附带 Authorization 与 X-Zcode-Device", async () => {
    installWindow("#token=tok-123&device=Desk-Top");
    consumeWebAccessTokenFromHash();
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithWebAccessToken("/api/server-info");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
    expect(headers.get("X-Zcode-Device")).toBe("Desk-Top");
  });

  it("clearWebAccessToken 同时清掉 token 与 device", () => {
    installWindow("#token=tok-123&device=Desk-Top");
    consumeWebAccessTokenFromHash();
    clearWebAccessToken();
    expect(getWebAccessToken()).toBeNull();
    expect(getWebAccessDevice()).toBeNull();
  });

  it("无 device 的旧链接：token 保留、device 为空（服务端会拒绝 token 档连接）", () => {
    installWindow("#token=tok-123");
    consumeWebAccessTokenFromHash();
    expect(getWebAccessToken()).toBe("tok-123");
    expect(getWebAccessDevice()).toBeNull();
    expect(attachWebAccessTokenToUrl("ws://host/ws")).toBe("ws://host/ws?token=tok-123");
  });
});
