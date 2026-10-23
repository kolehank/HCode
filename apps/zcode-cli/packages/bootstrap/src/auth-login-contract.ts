import type { SharedZCodeCredentialStore } from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";

export type CodingPlanProviderId = "bigmodel" | "zai";

// BYOK fork P1b：LoginZCodeCliOptions/Result 与 BigModel 轮询登录类型
// 已随厂商 OAuth 登录删除。

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export interface LogoutZCodeCliOptions {
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  credentialsPath: string;
}

export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}
