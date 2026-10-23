import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
// BYOK fork P2：主密钥升级为 OS keychain 随机密钥（与 services 侧同构，见
// packages/shared/src/node/credentialMasterKey.ts）；本机信息推导仅保留给 legacy 密文迁移。
import { resolveCredentialMasterKey } from "@zcode/shared/node";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";

export interface ZCodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface ZCodeCredentialCipherOptions {
  env?: Record<string, string | undefined>;
}

export function createZCodeCredentialCipher(
  options: ZCodeCredentialCipherOptions = {},
): ZCodeCredentialCipher {
  // 同步工厂仅支持显式 ZCODE_CREDENTIAL_SECRET（测试/企业 KMS）；
  // keychain 场景必须用 createZCodeCredentialCipherAsync。
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (!configuredSecret) {
    throw new Error(
      "credential cipher requires ZCODE_CREDENTIAL_SECRET for sync construction; " +
        "use createZCodeCredentialCipherAsync for keychain-backed provisioning",
    );
  }
  const key = deriveCipherKey(configuredSecret);

  return {
    decrypt(value: string): string {
      if (!isEncryptedZCodeCredentialValue(value)) {
        return value;
      }

      const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
      const parts = payload.split(".");
      const [ivRaw, authTagRaw, cipherRaw] = parts;

      if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }

      const iv = Buffer.from(ivRaw, "base64url");
      const authTag = Buffer.from(authTagRaw, "base64url");
      const cipherText = Buffer.from(cipherRaw, "base64url");

      if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
        throw new Error("Credential decrypt failed: invalid IV length");
      }
      if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
        throw new Error("Credential decrypt failed: invalid auth tag length");
      }

      try {
        const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return plainText.toString("utf-8");
      } catch (error) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error,
        });
      }
    },

    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return [
        ENCRYPTED_VALUE_PREFIX,
        iv.toString("base64url"),
        ".",
        authTag.toString("base64url"),
        ".",
        encrypted.toString("base64url"),
      ].join("");
    },
  };
}

export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function deriveLegacyCipherKey(env: Record<string, string | undefined>): Buffer {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  if (configuredSecret) {
    return deriveCipherKey(configuredSecret);
  }
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some packaged or sandboxed runtimes cannot resolve OS user info.
  }
  return deriveCipherKey(
    `zcode-credential-fallback:${platform()}:${homedir()}:${username}`,
  );
}

/** 生产工厂：预热 keychain 主密钥后返回同步 cipher（含 legacy 密文回退解密）。 */
export async function createZCodeCredentialCipherAsync(
  options: ZCodeCredentialCipherOptions = {},
): Promise<ZCodeCredentialCipher> {
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  const current = configuredSecret
    ? deriveCipherKey(configuredSecret)
    : await resolveCredentialMasterKey(env);
  const legacy = deriveLegacyCipherKey(env);
  if (legacy.equals(current)) {
    return createZCodeCredentialCipher(options);
  }
  const decryptWith = (value: string, key: Buffer): string => {
    const payload = value.slice(ENCRYPTED_VALUE_PREFIX.length);
    const parts = payload.split(".");
    const [ivRaw, authTagRaw, cipherRaw] = parts;
    if (!ivRaw || !authTagRaw || !cipherRaw || parts.length !== 3) {
      throw new Error("Credential decrypt failed: invalid ciphertext format");
    }
    const iv = Buffer.from(ivRaw, "base64url");
    const authTag = Buffer.from(authTagRaw, "base64url");
    const cipherText = Buffer.from(cipherRaw, "base64url");
    const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf-8");
  };
  const encryptWith = (value: string, key: Buffer): string => {
    const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
    const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      ENCRYPTED_VALUE_PREFIX,
      iv.toString("base64url"),
      ".",
      authTag.toString("base64url"),
      ".",
      encrypted.toString("base64url"),
    ].join("");
  };
  return {
    decrypt(value: string): string {
      if (!isEncryptedZCodeCredentialValue(value)) return value;
      try {
        return decryptWith(value, current);
      } catch {
        // legacy 本机推导密钥兜底：旧密文仍可读（迁移由宿主在读后重写完成）。
        return decryptWith(value, legacy);
      }
    },
    encrypt(value: string): string {
      return encryptWith(value, current);
    },
  };
}
