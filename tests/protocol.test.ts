import { describe, expect, test } from "bun:test";
import { generateSigningKey, signMessage, verifyMessage } from "../src/server/crypto/signing";
import { agentMessageSchema, commandMessage, helloMessage, signCommand, verifyHello } from "../src/server/agents/protocol";

describe("agent protocol", () => {
  test("hello signatures expire and bind the nonce", () => {
    const agent = generateSigningKey();
    const now = Date.now();
    const sig = signMessage(agent.privateKey, helloMessage("a1", "n1", now));
    expect(verifyHello(agent.publicKey, "a1", "n1", now, sig, now)).toBe(true);
    expect(verifyHello(agent.publicKey, "a1", "n2", now, sig, now)).toBe(false);
    expect(verifyHello(agent.publicKey, "a2", "n1", now, sig, now)).toBe(false);
    expect(verifyHello(agent.publicKey, "a1", "n1", now, sig, now + 10 * 60_000)).toBe(false);
  });

  test("command envelopes sign the exact payload string", () => {
    const server = generateSigningKey();
    const envelope = signCommand(server.privateKey, {
      v: 1,
      id: "c1",
      agentId: "a1",
      type: "ka_service",
      args: { action: "reload" },
      issuedAt: 1,
      expiresAt: 2,
    });
    expect(verifyMessage(server.publicKey, commandMessage(envelope.payload), envelope.sig)).toBe(true);
    const tampered = envelope.payload.replace("reload", "stop");
    expect(verifyMessage(server.publicKey, commandMessage(tampered), envelope.sig)).toBe(false);
  });

  test("rejects oversized and unknown agent messages", () => {
    expect(agentMessageSchema.safeParse({ type: "shell", cmd: "id" }).success).toBe(false);
    const lines = Array.from({ length: 51 }, () => "x");
    expect(agentMessageSchema.safeParse({ type: "progress", id: "c1", lines }).success).toBe(false);
  });
});
