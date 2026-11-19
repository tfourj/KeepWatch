// Serves dist/demo on port 4321 with an SPA fallback, for scripts/screenshots.sh.
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "../../dist/demo");

Bun.serve({
  port: 4321,
  async fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = Bun.file(join(root, path));
    if (path !== "/" && path.startsWith("/") && (await file.exists())) return new Response(file);
    return new Response(Bun.file(join(root, "index.html")), { headers: { "content-type": "text/html" } });
  },
});
