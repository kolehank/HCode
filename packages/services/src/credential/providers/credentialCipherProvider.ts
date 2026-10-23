import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
} from "@zcode/shared";
import { resolveCredentialMasterKey } from "@zcode/shared/node";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * BYOK fork P2：加密密钥解析顺序——
 * 1. ZCODE_CREDENTIAL_SECRET（企业/KMS 显式配置，SHA-256 派生）；
 * 2. OS keychain 随机主密钥（Win=DPAPI / macOS=Keychain / Linux=secret-tool，
 *    首次 randomBytes(32) 生成并持久化，见 shared/node/credentialMasterKey.ts）。
 * 删除了旧版「platform/homedir/username 本机信息推导」fallback：密文换机/拷贝不可解。
 * keychain 不可用时构造直接抛错（credential_master_key_unavailable），绝不静默降级。
 */
function resolveKey(env: NodeJS.ProcessEnv): Buffer {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return createHash("sha256").update(configuredSecret).digest();
  }
  // 同步构造点：masterKey 由 createCredentialCipherProviderAsync 预热注入；
  // 直接同步调用本函数的旧路径（如测试）走 env 显式 secret 或显式传入的 key。
  throw new Error(
    "credential cipher key not provisioned: use createCredentialCipherProviderAsync or set ZCODE_CREDENTIAL_SECRET",
  );
}

/** legacy：旧版本（BYOK P2 之前）用本机信息推导密钥。仅用于历史密文的解密迁移，
 * 绝不用于 encrypt；本机信息推导出的密钥只在本机有效，迁移后新密文全部走 keychain 密钥。 */
function deriveLegacyCipherKey(env: NodeJS.ProcessEnv): Buffer {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return createHash("sha256").update(configuredSecret).digest();
  }
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }
  return createHash("sha256")
    .update(`zcode-credential-fallback:${platform()}:${homedir()}:${username}`)
    .digest();
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

interface ProvisionedKeys {
  current: Buffer;
  legacy: Buffer;
  /** legacy 迁移回调：旧密文解密成功后触发（fire-and-forget，宿主复用原子写重加密）。 */
  onLegacyValueMigrated?: (credentialKey: string, plaintext: string, legacyValue: string) => void;
}

function encryptWithKey(value: string, key: Buffer): string {
  const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
  const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENCRYPTED_VALUE_PREFIX,
    bufferToBase64url(iv),
    ".",
    bufferToBase64url(authTag),
    ".",
    bufferToBase64url(encrypted),
  ].join("");
}

function decryptWithKey(value: string, key: Buffer): string {
  const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
  const parts = payload.split(".");
  const [ivRaw, authTagRaw, cipherRaw] = parts;
  // Bug 根因：AES-GCM 加密空字符串时 cipherText 合法地为空，编码结果以点号结尾。
  // 只拒绝真正缺失的第三段。
  if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
    throw createCredentialDecryptError("密文格式非法");
  }
  const iv = base64urlToBuffer(ivRaw);
  const authTag = base64urlToBuffer(authTagRaw);
  const cipherText = base64urlToBuffer(cipherRaw);
  if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
    throw createCredentialDecryptError("IV 长度非法");
  }
  if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
    throw createCredentialDecryptError("AuthTag 长度非法");
  }
  const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    const text = plainText.toString("utf-8");
    plainText.fill(0);
    return text;
  } catch {
    throw createCredentialDecryptError("密钥不匹配或密文已损坏");
  }
}

function createCipherProviderWithKeys(keys: ProvisionedKeys): CredentialCipherProvider {
  return {
    encrypt(value: string): string {
      return encryptWithKey(value, keys.current);
    },
    decrypt(value: string, credentialKey?: string): string {
      if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }
      try {
        return decryptWithKey(value, keys.current);
      } catch (currentError) {
        // 历史密文：尝试 legacy 本机推导密钥解密，成功即触发重加密迁移。
        if (keys.legacy.equals(keys.current)) throw currentError;
        try {
          const plaintext = decryptWithKey(value, keys.legacy);
          if (credentialKey) {
            try {
              keys.onLegacyValueMigrated?.(credentialKey, plaintext, value);
            } catch {
              /* 迁移回调异常不阻断读取 */
            }
          }
          return plaintext;
        } catch {
          throw currentError;
        }
      }
    },
  } as CredentialCipherProvider;
}

/** 同步构造（仅测试/显式 ZCODE_CREDENTIAL_SECRET 场景）：由 env secret 派生两把同钥。 */
export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (!configuredSecret) {
    throw new Error(
      "credential cipher requires ZCODE_CREDENTIAL_SECRET for sync construction; " +
        "use createCredentialCipherProviderAsync for keychain-backed provisioning",
    );
  }
  const key = createHash("sha256").update(configuredSecret).digest();
  return createCipherProviderWithKeys({ current: key, legacy: key });
}

export interface CreateCredentialCipherProviderAsyncOptions
  extends CredentialCipherProviderOptions {
  /** legacy 密文迁移回调：宿主负责用迁移后的 keychain 密钥重写凭据条目。 */
  onLegacyValueMigrated?: (credentialKey: string, plaintext: string, legacyValue: string) => void;
}

/** 生产构造：预热解析 keychain 主密钥后返回同步 cipher。 */
export async function createCredentialCipherProviderAsync(
  options: CreateCredentialCipherProviderAsyncOptions = {},
): Promise<CredentialCipherProvider> {
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  const current = configuredSecret
    ? createHash("sha256").update(configuredSecret).digest()
    : await resolveCredentialMasterKey(env);
  return createCipherProviderWithKeys({
    current,
    legacy: deriveLegacyCipherKey(env),
    onLegacyValueMigrated: options.onLegacyValueMigrated,
  });
}
