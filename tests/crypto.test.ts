import { describe, expect, test } from "bun:test";
import { createSecretBox, maskSecret } from "../src/server/crypto/secretbox";
import { generateSigningKey, importPublicRaw, signMessage, verifyMessage } from "../src/server/crypto/signing";
import { generateSealingKey, openSealed, seal } from "../src/server/crypto/sealing";

describe("secretbox", () => {
  const box = createSecretBox("test-secret-that-is-long-enough-123");

  test("round trips and uses a fresh IV each time", () => {
    const a = box.encrypt("hunter2");
    const b = box.encrypt("hunter2");
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe("hunter2");
    expect(box.decryptJson<{ x: number }>(box.encryptJson({ x: 1 }))).toEqual({ x: 1 });
  });

  test("rejects tampered ciphertext and the wrong key", () => {
    const sealed = box.encrypt("secret");
    const raw = Buffer.from(sealed.slice(3), "base64url");
    raw[15] ^= 1;
    expect(() => box.decrypt(`v1:${raw.toString("base64url")}`)).toThrow();
    expect(() => createSecretBox("another-secret-value-1234567890").decrypt(sealed)).toThrow();
  });

  test("masks secrets", () => {
    expect(maskSecret("abcdefghij")).toBe("••••••••ghij");
    expect(maskSecret("")).toBe("");
  });
});

describe("ed25519 signing", () => {
  test("verifies only the signed message with the right key", () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const sig = signMessage(key.privateKey, "hello");
    expect(verifyMessage(importPublicRaw(key.publicKeyRaw), "hello", sig)).toBe(true);
    expect(verifyMessage(key.publicKey, "hellO", sig)).toBe(false);
    expect(verifyMessage(other.publicKey, "hello", sig)).toBe(false);
    expect(verifyMessage(key.publicKey, "hello", "garbage")).toBe(false);
  });

  test("public keys are raw 32 bytes for the Go agent", () => {
    expect(Buffer.from(generateSigningKey().publicKeyRaw, "base64url").length).toBe(32);
  });
});

describe("x25519 sealing", () => {
  test("only the agent key opens a sealed value, bound to its context", () => {
    const agent = generateSealingKey();
    const other = generateSealingKey();
    const sealed = seal(agent.publicKeyRaw, "vrrp-pass", "a1\nc1");
    expect(sealed.startsWith("s1:")).toBe(true);
    expect(openSealed(agent.privateKey, sealed, "a1\nc1")).toBe("vrrp-pass");
    expect(() => openSealed(agent.privateKey, sealed, "a1\nc2")).toThrow();
    expect(() => openSealed(other.privateKey, sealed, "a1\nc1")).toThrow();
  });

  test("every seal uses a fresh ephemeral key", () => {
    const agent = generateSealingKey();
    expect(seal(agent.publicKeyRaw, "x", "ctx")).not.toBe(seal(agent.publicKeyRaw, "x", "ctx"));
  });

  test("rejects keys that are not 32 bytes", () => {
    expect(() => seal(Buffer.alloc(16).toString("base64url"), "x", "ctx")).toThrow();
  });
});
