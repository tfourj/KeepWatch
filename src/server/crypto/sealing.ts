import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * End-to-end sealing of secret fields for one agent, so a TLS-terminating proxy never sees them.
 *
 *   s1:<base64url(ephemeralPublic[32] | iv[12] | ciphertext | tag[16])>
 *
 * key = HKDF-SHA256(X25519(ephemeral, agent), salt = ephemeralPublic | agentPublic, info = "keepwatch-seal-v1")
 * The associated data binds the value to its context, for example "<agentId>\n<commandId>".
 * Keep in sync with agent/internal/core/seal.go.
 */
const VERSION = "s1";
const INFO = "keepwatch-seal-v1";

export type SealingKeyPair = { privateKey: KeyObject; publicKey: KeyObject; publicKeyRaw: string };

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an X25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

function importRawPublic(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("X25519 public key must be 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

function deriveKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

export function generateSealingKey(): SealingKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey, publicKeyRaw: rawPublic(publicKey).toString("base64url") };
}

/** Validates a raw base64url X25519 public key from an agent. */
export function assertSealingKey(raw: string) {
  importRawPublic(Buffer.from(raw, "base64url"));
}

export function seal(recipientRaw: string, plaintext: string, aad: string): string {
  const recipient = Buffer.from(recipientRaw, "base64url");
  const recipientKey = importRawPublic(recipient);
  const eph = generateKeyPairSync("x25519");
  const ephRaw = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
  const key = deriveKey(shared, ephRaw, recipient);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([ephRaw, iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}

/** The agent's side, used in tests to check the format. */
export function openSealed(privateKey: KeyObject, sealed: string, aad: string): string {
  const [version, data] = sealed.split(":", 2);
  if (version !== VERSION || !data) throw new Error("unsupported sealed format");
  const raw = Buffer.from(data, "base64url");
  if (raw.length < 32 + 12 + 16) throw new Error("sealed value too short");
  const ephRaw = raw.subarray(0, 32);
  const iv = raw.subarray(32, 44);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(44, raw.length - 16);
  const recipient = rawPublic(createPublicKey(privateKey));
  const shared = diffieHellman({ privateKey, publicKey: importRawPublic(ephRaw) });
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(shared, ephRaw, recipient), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
