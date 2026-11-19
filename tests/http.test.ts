import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireSameOrigin } from "../src/server/http/origin";

function app() {
  const a = new Hono();
  a.use("*", requireSameOrigin(["https://kw.example.com"]));
  a.all("/x", (c) => c.text("ok"));
  return a;
}

describe("requireSameOrigin", () => {
  test("allows safe methods from anywhere", async () => {
    const res = await app().request("/x", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(200);
  });

  test("allows writes from the configured origin", async () => {
    const res = await app().request("/x", { method: "POST", headers: { origin: "https://kw.example.com" } });
    expect(res.status).toBe(200);
  });

  test("refuses writes from another origin", async () => {
    const res = await app().request("/x", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  test("refuses writes without an origin", async () => {
    const res = await app().request("/x", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("allows same-origin fetch metadata without an origin", async () => {
    const res = await app().request("/x", { method: "PATCH", headers: { "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });
});
