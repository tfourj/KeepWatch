import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../src/server/db/client";
import { nodes } from "../src/server/db/schema";
import { clusterRoutes } from "../src/server/routes/clusters";
import { nodeRoutes } from "../src/server/routes/nodes";

const app = new Hono();
app.route("/clusters", clusterRoutes);
app.route("/nodes", nodeRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.clone().text(), json: (await res.json()) as any };
}

async function setup() {
  const cluster = (await call("POST", "/clusters", { name: `c-${crypto.randomUUID()}` })).json.cluster;
  const a = db.insert(nodes).values({ name: "lb1", clusterId: cluster.id }).returning().get();
  const b = db.insert(nodes).values({ name: "lb2", clusterId: cluster.id }).returning().get();
  return { cluster, a, b };
}

const vip = (a: string, b: string, extra: Record<string, unknown> = {}) => ({
  name: "VI_web",
  vrid: 51,
  vrrpVersion: 2,
  interface: "eth0",
  authPass: "s3cretpw",
  virtualIps: [{ address: "10.0.0.10", prefix: 24 }],
  members: [
    { nodeId: a, priority: 150, initialState: "MASTER" },
    { nodeId: b, priority: 100 },
  ],
  ...extra,
});

describe("cluster API", () => {
  test("stores the VIP password encrypted and never returns it", async () => {
    const { cluster, a, b } = await setup();
    const created = await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id));
    expect(created.status).toBe(201);
    expect(created.json.instance.hasPassword).toBe(true);
    const read = await call("GET", `/clusters/${cluster.id}`);
    expect(read.text).not.toContain("s3cretpw");
    expect(read.text).not.toContain("authPassEnc");
  });

  test("keeps the password when an edit leaves it out", async () => {
    const { cluster, a, b } = await setup();
    const id = (await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id))).json.instance.id;
    const { authPass, ...rest } = vip(a.id, b.id, { advertInt: 2 });
    const edited = await call("PUT", `/clusters/${cluster.id}/instances/${id}`, rest);
    expect(edited.status).toBe(200);
    expect(edited.json.instance.hasPassword).toBe(true);
  });

  test("refuses clashes and members from other clusters", async () => {
    const { cluster, a, b } = await setup();
    await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id));
    const clash = await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id, { name: "VI_two" }));
    expect(clash.status).toBe(400);
    expect(clash.json.problems.join()).toContain("VRID 51 is already used");
    const other = await setup();
    const foreign = await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, other.a.id, { vrid: 52 }));
    expect(foreign.json.problems).toContain("lb1 is not in this cluster");
  });

  test("validates input on both levels", async () => {
    const { cluster, a, b } = await setup();
    const bad = await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id, { name: "bad name" }));
    expect(bad.status).toBe(400);
    const v3pass = await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id, { vrrpVersion: 3 }));
    expect(v3pass.json.problems).toContain("Passwords only exist in VRRP version 2");
    const samePrio = vip(a.id, b.id);
    (samePrio.members as { priority: number }[])[1]!.priority = 150;
    expect((await call("POST", `/clusters/${cluster.id}/instances`, samePrio)).status).toBe(400);
  });

  test("health checks need unique ids per cluster", async () => {
    const { cluster } = await setup();
    const check = { name: "Web", key: "web", params: { type: "tcp", host: "127.0.0.1", port: 80 } };
    expect((await call("POST", `/clusters/${cluster.id}/checks`, check)).status).toBe(201);
    expect((await call("POST", `/clusters/${cluster.id}/checks`, check)).status).toBe(400);
    const script = { ...check, key: "s", params: { type: "script", path: "/bin/sh" } };
    expect((await call("POST", `/clusters/${cluster.id}/checks`, script)).status).toBe(400);
  });
});

describe("node API", () => {
  test("install commands use the one-time token and never list agent keys", async () => {
    const created = await call("POST", "/nodes", { name: "lb9" });
    expect(created.status).toBe(201);
    expect(created.json.enrollment.command).toMatch(/install\.sh \| sh -s -- --server \S+ --token \S{40,}/);
    const list = await call("GET", "/nodes");
    expect(list.text).not.toContain("sealKey");
    expect(list.text).not.toContain("publicKey");
  });

  test("a node in a VIP cannot move to another cluster", async () => {
    const { cluster, a, b } = await setup();
    await call("POST", `/clusters/${cluster.id}/instances`, vip(a.id, b.id));
    const other = await setup();
    const moved = await call("PATCH", `/nodes/${a.id}`, { clusterId: other.cluster.id });
    expect(moved.status).toBe(409);
  });
});
