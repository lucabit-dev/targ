import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptToken, encryptToken } from "./token-cipher";

describe("token-cipher", () => {
  const originalKey = process.env.APP_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    delete process.env.APP_TOKEN_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.APP_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.APP_TOKEN_ENCRYPTION_KEY = originalKey;
    }
  });

  it("round-trips an ASCII token under the dev fallback key", () => {
    const plaintext = "ghp_exampleAccessToken_0123456789";
    const ciphertext = encryptToken(plaintext);

    expect(ciphertext.startsWith("v1.")).toBe(true);
    expect(ciphertext).not.toContain(plaintext);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it("round-trips a unicode / whitespace-heavy token", () => {
    const plaintext = "tok-üñîçødé\nwith\ttabs 🟩";
    const ciphertext = encryptToken(plaintext);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it("produces a different ciphertext each time for the same plaintext (IV randomness)", () => {
    const plaintext = "same-token-over-and-over";
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it("honours a passphrase supplied via APP_TOKEN_ENCRYPTION_KEY", () => {
    process.env.APP_TOKEN_ENCRYPTION_KEY =
      "a-strong-passphrase-with-enough-entropy-123!";
    const plaintext = "ghu_passphraseRoundTripTest";
    expect(decryptToken(encryptToken(plaintext))).toBe(plaintext);
  });

  it("honours a base64-encoded 32-byte key", () => {
    const keyBytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) {
      keyBytes[i] = i;
    }
    process.env.APP_TOKEN_ENCRYPTION_KEY = keyBytes.toString("base64");

    const plaintext = "ghu_base64KeyRoundTrip";
    const ciphertext = encryptToken(plaintext);
    expect(decryptToken(ciphertext)).toBe(plaintext);
  });

  it("rejects a token encrypted under a different key", () => {
    process.env.APP_TOKEN_ENCRYPTION_KEY = "passphrase-one-1234567890abcdefgh";
    const ciphertext = encryptToken("secret-token");

    process.env.APP_TOKEN_ENCRYPTION_KEY = "passphrase-two-1234567890abcdefgh";
    expect(() => decryptToken(ciphertext)).toThrow();
  });

  it("rejects malformed input", () => {
    expect(() => decryptToken("")).toThrow();
    expect(() => decryptToken("not-a-real-ciphertext")).toThrow();
    expect(() => decryptToken("v1.aaa.bbb")).toThrow();
    expect(() => decryptToken("v2.aaaaa.bbbbb.ccccc")).toThrow();
  });
});
