import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

// BYOK fork P1b：厂商 OAuth 登录已删除。CLI `zcode login` 不再有浏览器授权流程；
// 提示用户改用 API Key 配置（/login *-api-key 或桌面设置页）。
export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  _deps: RunDependencies,
  _noBrowser: boolean,
  _args: readonly string[] = [],
): Promise<number> {
  const hint =
    "Vendor account login is not available in this build. Configure an API key instead:\n" +
    "  zcode-tui: /login zai-coding-plan-api-key <api-key> (or bigmodel-coding-plan-api-key)\n" +
    "  desktop: Settings -> Model Providers";
  if (options.json) {
    ctx.stdout.write(`{"status":"unavailable","hint":${JSON.stringify(hint)}}\n`);
  } else {
    ctx.stdout.write(`${hint}\n`);
  }
  return 1;
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env: deps.env ?? process.env });
    if (options.json) {
      ctx.stdout.write(`{"status":"logged_out","credentialsPath":${JSON.stringify(result.credentialsPath)}}\n`);
      return 0;
    }
    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}
