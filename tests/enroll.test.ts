import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { agents, nodes } from "../src/server/db/schema";
import { createEnrollmentToken, EnrollmentError, redeemEnrollment } from "../src/server/agents/enroll";
import { generateSealingKey } from "../src/server/crypto/sealing";
import { generateSigningKey } from "../src/server/crypto/signing";
import { sha256Hex } from "../src/server/crypto/secretbox";
import { enrollmentTokens } from "../src/server/db/schema";

const info = { version: "1.0.0", protocol: 1, os: "linux", arch: "amd64", hostname: "lb1", interfaces: [] };
const keys = () => ({ publicKey: generateSigningKey().publicKeyRaw, sealKey: generateSealingKey().publicKeyRaw });
let nodeId: string;

beforeEach(() => {
  nodeId = db.insert(nodes).values({ name: `node-${crypto.randomUUID()}` }).returning().get().id;
});

describe("agent enrollment", () => {
  test("a token pairs one agent and can be retried with the same key only", () => {
    const { token } = createEnrollmentToken(nodeId);
    const key = keys();
    const first = redeemEnrollment(token, key, info);
    expect(first.nodeId).toBe(nodeId);
    expect(first.retried).toBe(false);

    const retry = redeemEnrollment(token, key, info);
    expect(retry.agentId).toBe(first.agentId);
    expect(retry.retried).toBe(true);

    expect(() => redeemEnrollment(token, keys(), info)).toThrow(EnrollmentError);
  });

  test("stores only the token hash", () => {
    const { token } = createEnrollmentToken(nodeId);
    const row = db.select().from(enrollmentTokens).where(eq(enrollmentTokens.nodeId, nodeId)).get()!;
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test("expired and unknown tokens are rejected", () => {
    const { token } = createEnrollmentToken(nodeId, new Date(Date.now() - 60 * 60_000));
    expect(() => redeemEnrollment(token, keys(), info)).toThrow("invalid or expired");
    expect(() => redeemEnrollment("x".repeat(43), keys(), info)).toThrow(EnrollmentError);
  });

  test("a new token revokes the previous one and re-pairing replaces the agent", () => {
    const old = createEnrollmentToken(nodeId);
    const fresh = createEnrollmentToken(nodeId);
    expect(() => redeemEnrollment(old.token, keys(), info)).toThrow(EnrollmentError);

    const firstAgent = redeemEnrollment(fresh.token, keys(), info);
    const secondAgent = redeemEnrollment(createEnrollmentToken(nodeId).token, keys(), info);
    expect(secondAgent.replaced).toBe(true);
    expect(secondAgent.agentId).not.toBe(firstAgent.agentId);
    expect(db.select().from(agents).where(eq(agents.nodeId, nodeId)).all().length).toBe(1);
  });

  test("rejects malformed keys", () => {
    const { token } = createEnrollmentToken(nodeId);
    expect(() => redeemEnrollment(token, { ...keys(), publicKey: "not-a-key" }, info)).toThrow(EnrollmentError);
    expect(() => redeemEnrollment(token, { ...keys(), sealKey: "not-a-key" }, info)).toThrow(EnrollmentError);
  });
});

describe("automatic updates", () => {
  test("are on for new agents and kept when a node is paired again", () => {
    const first = redeemEnrollment(createEnrollmentToken(nodeId).token, keys(), info);
    const row = () => db.select().from(agents).where(eq(agents.nodeId, nodeId)).get()!;
    expect(row().autoUpdate).toBe(true);

    db.update(agents).set({ autoUpdate: false }).where(eq(agents.id, first.agentId)).run();
    redeemEnrollment(createEnrollmentToken(nodeId).token, keys(), info);
    expect(row().autoUpdate).toBe(false);
  });
});
