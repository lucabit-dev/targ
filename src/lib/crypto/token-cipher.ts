import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const CIPHERTEXT_VERSION = 1;

const DEV_FALLBACK_MATERIAL =
  "dev-only-token-encryption-key-do-not-use-in-production";

function loadKey(): Buffer {
  const raw = process.env.APP_TOKEN_ENCRYPTION_KEY;

  if (raw && raw.length > 0) {
    // Accept either a base64-encoded 32-byte key or a >=32-byte passphrase.
    // Passphrases are normalized through SHA-256 so the output is always 32 bytes.
    const decoded = tryDecodeBase64Key(raw);
    if (decoded) {
      return decoded;
    }

    return createHash("sha256").update(raw, "utf8").digest();
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APP_TOKEN_ENCRYPTION_KEY must be set in production (base64-encoded 32 bytes or a passphrase >= 32 chars)."
    );
  }

  return createHash("sha256").update(DEV_FALLBACK_MATERIAL, "utf8").digest();
}

function tryDecodeBase64Key(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, "base64");
    if (buffer.length === 32) {
      return buffer;
    }
  } catch {
    // fall through to passphrase path
  }
  return null;
}

export function encryptToken(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptToken expects a string.");
  }

  const key = loadKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Packed format: v1.<iv>.<authTag>.<ciphertext>, all base64url.
  return [
    `v${CIPHERTEXT_VERSION}`,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(packed: string): string {
  if (typeof packed !== "string" || packed.length === 0) {
    throw new Error("decryptToken expects a non-empty string.");
  }

  const parts = packed.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed token ciphertext.");
  }

  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== `v${CIPHERTEXT_VERSION}`) {
    throw new Error(`Unsupported token cipher version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");

  if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Token ciphertext has invalid IV or auth tag length.");
  }

  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

export function isTokenEncryptionConfigured(): boolean {
  const raw = process.env.APP_TOKEN_ENCRYPTION_KEY;
  return typeof raw === "string" && raw.length > 0;
}
