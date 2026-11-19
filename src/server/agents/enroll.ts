import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, enrollmentTokens, nodes } from "../db/schema";
import { assertSealingKey } from "../crypto/sealing";
import { importPublicRaw } from "../crypto/signing";
import { randomToken, sha256Hex } from "../crypto/secretbox";
import { serverSigningKey } from "../secrets";
import type { AgentInfo } from "./protocol";

export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** Create a one-time enrollment token for a node. Older unused tokens for it are revoked. */
export function createEnrollmentToken(nodeId: string, now = new Date()) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
  db.transaction((tx) => {
    tx.delete(enrollmentTokens)
      .where(and(eq(enrollmentTokens.nodeId, nodeId), isNull(enrollmentTokens.usedAt)))
      .run();
    tx.insert(enrollmentTokens).values({ nodeId, tokenHash: sha256Hex(token), expiresAt }).run();
  });
  return { token, expiresAt };
}

export class EnrollmentError extends Error {}

export type EnrollResult = {
  agentId: string;
  nodeId: string;
  nodeName: string;
  serverPublicKey: string;
  replaced: boolean;
  retried: boolean;
};

export type EnrollKeys = { publicKey: string; sealKey: string };

/**
 * Redeem a token. A retry from the same key after the token was used succeeds,
 * so an interrupted HTTPS response does not strand the installer.
 */
export function redeemEnrollment(token: string, keys: EnrollKeys, info: AgentInfo, now = new Date()): EnrollResult {
  try {
    importPublicRaw(keys.publicKey);
    assertSealingKey(keys.sealKey);
  } catch {
    throw new EnrollmentError("invalid agent keys");
  }
  const serverPublicKey = serverSigningKey().publicKeyRaw;
  return db.transaction((tx) => {
    const row = tx.select().from(enrollmentTokens).where(eq(enrollmentTokens.tokenHash, sha256Hex(token))).get();
    if (!row || row.expiresAt.getTime() < now.getTime()) throw new EnrollmentError("invalid or expired token");
    const node = tx.select().from(nodes).where(eq(nodes.id, row.nodeId)).get();
    if (!node) throw new EnrollmentError("node no longer exists");
    const existing = tx.select().from(agents).where(eq(agents.nodeId, node.id)).get();
    const result = (agentId: string, replaced: boolean, retried: boolean): EnrollResult => ({
      agentId,
      nodeId: node.id,
      nodeName: node.name,
      serverPublicKey,
      replaced,
      retried,
    });

    if (row.usedAt) {
      if (existing && existing.publicKey === keys.publicKey) return result(existing.id, false, true);
      throw new EnrollmentError("token already used");
    }

    tx.update(enrollmentTokens).set({ usedAt: now }).where(eq(enrollmentTokens.id, row.id)).run();
    if (existing) tx.delete(agents).where(eq(agents.id, existing.id)).run();
    const agent = tx
      .insert(agents)
      .values({
        nodeId: node.id,
        publicKey: keys.publicKey,
        sealKey: keys.sealKey,
        version: info.version,
        os: info.os,
        arch: info.arch,
        hostname: info.hostname,
        interfaces: info.interfaces,
        // Re-pairing keeps the previous agent's choice.
        autoUpdate: existing?.autoUpdate ?? true,
        enrolledAt: now,
      })
      .returning()
      .get();
    return result(agent.id, !!existing, false);
  });
}
