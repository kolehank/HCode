/**
 * BYOK fork P1b：厂商 OAuth 登录（loginForTui / loginBigmodelForTui）已随
 * 登录体系删除；本文件仅保留 API Key 配置与登出的 TUI 适配。
 */
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";
import type { CommandCenterApiKeyOptions } from "./command-center/types.js";

export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

export async function logoutForTui(deps: RunDependencies) {
  const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
  return await logout({ env: deps.env ?? process.env });
}
