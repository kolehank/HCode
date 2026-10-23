import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;

// BYOK fork P6：远程运行资源默认不再指向厂商 CDN（自托管）。缺省 fail-closed——
// 未配置 ZCODE_CDN_BASE_URL / __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ 时返回空列表，
// 远程资源下载快速失败；用户通过 env 指向自己的静态资源服务
// （GitHub Releases / 内网 nginx / caddy 均可，按 <base>/zcode/electron/releases/<version>/ 放置）。
const REMOTE_CDN_RELEASE_ROOTS = {
  domestic: "",
  overseas: "",
} as const;
const TEST_REMOTE_CDN_RELEASE_ROOT = "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function isChineseLocale(locale?: string | null): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}

function resolveLocalTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isUtcPlusEightTimeZone(timeZone?: string | null, now: Date = new Date()): boolean {
  const normalizedTimeZone = timeZone?.trim();
  if (!normalizedTimeZone) {
    return false;
  }

  const offsetMinutes = resolveTimeZoneOffsetMinutes(normalizedTimeZone, now);
  return offsetMinutes === 8 * 60;
}

export function shouldPreferDomesticRemoteCdn(
  options: Pick<ResolveRemoteCdnOptions, "locale" | "timeZone" | "now">,
): boolean {
  const timeZone = options.timeZone ?? resolveLocalTimeZone();
  return isChineseLocale(options.locale) && isUtcPlusEightTimeZone(timeZone, options.now);
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }
  // BYOK fork P6：ZCODE_CDN_BASE_URL 是 fork 的自托管入口（最高优先 env）。
  const cdnBaseUrl = process.env.ZCODE_CDN_BASE_URL?.trim();
  if (cdnBaseUrl) {
    return [`${normalizeBaseUrl(cdnBaseUrl)}/${options.version ?? ZCODE_VERSION}`];
  }

  const orderedReleaseRoots = shouldPreferDomesticRemoteCdn(options)
    ? [REMOTE_CDN_RELEASE_ROOTS.domestic, REMOTE_CDN_RELEASE_ROOTS.overseas]
    : [REMOTE_CDN_RELEASE_ROOTS.overseas, REMOTE_CDN_RELEASE_ROOTS.domestic];
  const version = options.version ?? ZCODE_VERSION;

  if (options.env === "test") {
    return [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
  }

  const configuredReleaseRoots =
    typeof __ZCODE_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __ZCODE_REMOTE_CDN_RELEASE_ROOTS__;
  if (configuredReleaseRoots.length > 0) {
    // Bugfix：remote runtime 的 manifest/components 下载根不能继续写死旧 CDN。
    // 构建期按 CI 的 CDN_DOMAIN/OSS_PATH_PREFIX 注入有序列表，切换时只改 CI 变量。
    return configuredReleaseRoots.map(
      (releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`,
    );
  }

  // fail-closed：无配置时返回空列表，远程资源下载快速失败，不出网。
  return orderedReleaseRoots
    .filter((releaseRoot) => releaseRoot.length > 0)
    .map((releaseRoot) => `${releaseRoot}/${version}`);
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveTimeZoneOffsetMinutes(timeZone: string, now: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(now);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    const second = Number(values.second);
    if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) {
      return null;
    }

    // 这里把目标时区“格式化后的人类时间”反算成 UTC，得到该时区相对 UTC 的真实偏移。
    // 不能只按常见亚洲城市白名单判断，否则 UTC+8 但非中国命名的时区会被误判。
    const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const currentUtcMs = now.getTime();
    return Math.round((targetUtcMs - currentUtcMs) / 60_000);
  } catch {
    return null;
  }
}
