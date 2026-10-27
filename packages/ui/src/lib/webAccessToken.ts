/* BYOK P3：web 前端访问令牌与设备标识的入口引导与携带。
 * 两者都经 URL fragment（#token=…&device=…）进入——fragment 不进代理/访问日志；
 * 读取后立刻从地址栏清除并存入 sessionStorage（会话级，关页即失），
 * 后续 API fetch（Authorization + X-Zcode-Device）与 WS URL（?token=&device=）附加。
 */

const WEB_ACCESS_TOKEN_STORAGE_KEY = "zcode-web-access-token";
const WEB_ACCESS_DEVICE_STORAGE_KEY = "zcode-web-access-device";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    // 个别 WebView 禁用 storage；令牌引导失败时按无 token 处理。
    return null;
  }
}

/**
 * 启动时调用一次：从 location.hash 读取 #token=<token>&device=<hostname>，读后用
 * history.replaceState 清掉 hash（避免留在地址栏/分享/截图中），并写入 sessionStorage。
 */
export function consumeWebAccessTokenFromHash(): string | null {
  const storage = getSessionStorage();
  if (!storage || typeof window === "undefined") {
    return null;
  }

  const rawHash = window.location.hash;
  if (!rawHash.startsWith("#")) {
    return getWebAccessToken();
  }

  const params = new URLSearchParams(rawHash.slice(1));
  const token = params.get("token")?.trim();
  const device = params.get("device")?.trim();
  if (token) {
    try {
      storage.setItem(WEB_ACCESS_TOKEN_STORAGE_KEY, token);
    } catch {
      // 存储失败时本次会话仍可用：调用方会拿到 token 用于当前连接。
    }
  }
  if (device) {
    try {
      storage.setItem(WEB_ACCESS_DEVICE_STORAGE_KEY, device);
    } catch {
      // 存储失败时服务端会拒绝 token 档连接并给出明确错误。
    }
  }

  // 无论本次 hash 是否带 token 都清掉，避免旧 token 长期留在地址栏。
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}`);

  return token || getWebAccessToken();
}

export function getWebAccessToken(): string | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(WEB_ACCESS_TOKEN_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** 设备标识（本机 hostname）：随 token 从 fragment 读入，WS/API 请求回传给服务端比对。 */
export function getWebAccessDevice(): string | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(WEB_ACCESS_DEVICE_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function clearWebAccessToken(): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(WEB_ACCESS_TOKEN_STORAGE_KEY);
    storage.removeItem(WEB_ACCESS_DEVICE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** WS URL 附加 `?token=&device=`；浏览器 WS 不能带自定义头，只能走 query。 */
export function attachWebAccessTokenToUrl(url: string): string {
  const params: string[] = [];
  const token = getWebAccessToken();
  const device = getWebAccessDevice();
  if (token && !url.includes("token=")) {
    params.push(`token=${encodeURIComponent(token)}`);
  }
  if (device && !url.includes("device=")) {
    params.push(`device=${encodeURIComponent(device)}`);
  }
  if (params.length === 0) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${params.join("&")}`;
}

/** API fetch 附加 `Authorization: Bearer <token>` 与设备标识头；CF 档（边缘注入）无需浏览器处理。 */
export async function fetchWithWebAccessToken(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getWebAccessToken();
  const device = getWebAccessDevice();
  if (!token) {
    return fetch(input, init);
  }
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (device && !headers.has("X-Zcode-Device")) {
    headers.set("X-Zcode-Device", device);
  }
  return fetch(input, { ...init, headers });
}
