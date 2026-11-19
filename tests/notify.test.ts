import { describe, expect, test } from "bun:test";
import { backoffMs, channelMatches } from "../src/server/notify/dispatcher";
import { mergeConfig, publicConfig, type ChannelRow } from "../src/server/notify/channels";

function channel(partial: Partial<ChannelRow>): ChannelRow {
  return {
    id: "c",
    name: "c",
    type: "ntfy",
    configEnc: "",
    enabled: true,
    events: ["failover"],
    clusterIds: null,
    nodeIds: null,
    titleTemplate: null,
    bodyTemplate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

describe("channel filters", () => {
  const event = { type: "failover", clusterId: "c1", nodeId: null };

  test("match on event type and enabled state", () => {
    expect(channelMatches(channel({}), event)).toBe(true);
    expect(channelMatches(channel({ enabled: false }), event)).toBe(false);
    expect(channelMatches(channel({ events: ["split_brain"] }), event)).toBe(false);
  });

  test("cluster and node filters only apply when the event has that id", () => {
    expect(channelMatches(channel({ clusterIds: ["c2"] }), event)).toBe(false);
    expect(channelMatches(channel({ clusterIds: ["c1"] }), event)).toBe(true);
    expect(channelMatches(channel({ nodeIds: ["n1"] }), event)).toBe(true);
    const nodeEvent = { type: "failover", clusterId: null, nodeId: "n2" };
    expect(channelMatches(channel({ nodeIds: ["n1"] }), nodeEvent)).toBe(false);
    const login = { type: "login", clusterId: null, nodeId: null };
    expect(channelMatches(channel({ events: ["login"], clusterIds: ["c2"], nodeIds: ["n1"] }), login)).toBe(true);
  });

  test("a grouped agent update matches a node filter on any of its nodes", () => {
    const grouped = { type: "agent_updated", clusterId: null, nodeId: null, data: { nodeIds: ["n1", "n2"] } };
    const events = ["agent_updated"];
    expect(channelMatches(channel({ events, nodeIds: ["n2"] }), grouped)).toBe(true);
    expect(channelMatches(channel({ events, nodeIds: ["n3"] }), grouped)).toBe(false);
  });
});

describe("retry backoff", () => {
  test("doubles and caps at 30 minutes", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});

describe("channel config", () => {
  test("keeps stored secrets when the field is left empty", () => {
    const stored = { serverUrl: "https://ntfy.sh", topic: "t", token: "secret", priority: "auto" };
    const { config, errors } = mergeConfig("ntfy", { serverUrl: "https://ntfy.sh", topic: "t2", token: "" }, stored);
    expect(errors).toEqual([]);
    expect(config).toMatchObject({ topic: "t2", token: "secret" });
  });

  test("validates required fields and urls", () => {
    expect(mergeConfig("gotify", { serverUrl: "gotify.lan" }).errors).toEqual([
      "Server URL must start with http:// or https://",
      "App token is required",
    ]);
  });

  test("never exposes secret values", () => {
    const view = publicConfig("telegram", { botToken: "123:abc", chatId: "42" });
    expect(view.values).toEqual({ chatId: "42" });
    expect(view.secretsSet).toEqual({ botToken: true });
  });
});
