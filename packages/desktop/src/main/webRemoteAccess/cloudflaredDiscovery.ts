// BYOK A2：临时公网通道（Cloudflare Quick Tunnel）的 cloudflared 二进制发现。
// Quick Tunnel 不需要账号，但需要本机 cloudflared；v1 只做「检测 + 引导安装」，
// 不自动下载、不内置二进制（见 docs/specs/web-remote-access.md「公网临时通道」节）。
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, join, win32 } from "node:path";
import type { CloudflaredDetection } from "@zcode/shared";

const VERSION_TIMEOUT_MS = 3_000;

const COMMON_INSTALL_PATHS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: [
    "C:\\Program Files\\cloudflared\\cloudflared.exe",
    "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  ],
  darwin: ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"],
  linux: ["/usr/bin/cloudflared", "/usr/local/bin/cloudflared", "/snap/bin/cloudflared"],
};

/**
 * 候选路径顺序：显式 env 覆盖 > PATH（含 Windows PATHEXT 变体）> 平台常见安装目录。
 * 只是候选，最终以「能执行 --version」为准，避免把同名目录/坏文件当成可用二进制。
 */
export function listCloudflaredCandidates(
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  const explicit = env.ZCODE_CLOUDFLARED_PATH?.trim();
  if (explicit) {
    candidates.push(explicit);
  }
  const executableNames =
    platform === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"];
  // 按目标平台而非宿主平台拼路径/分隔符：单测可在 macOS 上验证 Windows 候选。
  const pathSeparator = platform === "win32" ? ";" : delimiter;
  const joinPath = platform === "win32" ? win32.join : join;
  for (const dir of (env.PATH ?? "").split(pathSeparator)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    for (const name of executableNames) {
      candidates.push(joinPath(trimmed, name));
    }
  }
  for (const path of COMMON_INSTALL_PATHS[platform] ?? []) {
    candidates.push(path);
  }
  return [...new Set(candidates)];
}

/** 解析 `cloudflared version 2025.8.1 (built ...)` 的版本号；解析不到时返回 undefined。 */
export function parseCloudflaredVersion(output: string): string | undefined {
  const match = output.match(/cloudflared version\s+(\S+)/i);
  return match?.[1];
}

async function defaultIsExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    // Windows 的 X_OK 不生效（一律视为可执行），只要求文件存在。
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRunVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      path,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(`${stdout}${stderr}`.trim() || undefined);
      },
    );
  });
}

export interface DetectCloudflaredOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => Promise<boolean>;
  runVersion?: (path: string) => Promise<string | undefined>;
}

/**
 * 依次尝试候选：可执行且 `--version` 成功即返回；全部失败返回 {available:false}。
 * 版本命令失败但文件可执行时也视为不可用——PATH 里的损坏二进制比缺失更难排查，
 * 明确报 missing 并让用户重装更安全。
 */
export async function detectCloudflared(
  options: DetectCloudflaredOptions = {},
): Promise<CloudflaredDetection> {
  const platform = options.platform ?? process.platform;
  const isExecutable =
    options.isExecutable ?? ((path: string) => defaultIsExecutable(path, platform));
  const runVersion = options.runVersion ?? defaultRunVersion;
  for (const candidate of listCloudflaredCandidates(options)) {
    if (!(await isExecutable(candidate))) {
      continue;
    }
    const output = await runVersion(candidate);
    if (output) {
      return {
        available: true,
        path: candidate,
        ...(parseCloudflaredVersion(output) ? { version: parseCloudflaredVersion(output) } : {}),
      };
    }
  }
  return { available: false };
}
