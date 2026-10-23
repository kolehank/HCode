export { hasConfiguredStandaloneCodingPlan, logoutZCodeCli } from "./auth-login-persistence.js";
import {
  persistStandaloneCodingPlanConnection,
} from "./auth-login-persistence.js";
export { ZCodeCliLoginError } from "./auth-login-contract.js";
export type {
  CodingPlanProviderId,
  ConfigureCodingPlanApiKeyOptions,
  ConfigureCodingPlanApiKeyResult,
  LogoutZCodeCliOptions,
  LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import {
  ZCodeCliLoginError,
  type ConfigureCodingPlanApiKeyOptions,
  type ConfigureCodingPlanApiKeyResult,
} from "./auth-login-contract.js";
// BYOK fork P1b：厂商 OAuth 登录（loginZCodeCli / loginBigmodelCodingPlan 的
// 浏览器授权 + 服务端轮询）已删除；仅保留手动 API Key 配置与登出清理。
import { createSharedZCodeCredentialStore } from "@zcode/adapters";
import { createStandaloneAccountIdentityFromSecret } from "./app/standalone-account-provider-runtime.js";

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}
