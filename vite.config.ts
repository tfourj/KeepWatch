import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json";
import { buildCommit } from "./src/server/build-info";

/** Static hosts like Cloudflare Pages serve index.html for every route with this file. */
function spaRedirects(): Plugin {
  return {
    name: "spa-redirects",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_redirects", source: "/* /index.html 200\n" });
    },
  };
}

// `vite build --mode demo` builds a static demo with an in-browser fake API (see src/web/demo).
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  // Cloudflare Pages sets CF_PAGES_COMMIT_SHA; the demo shows that commit unless it is a release tag.
  const pagesCommit = process.env.CF_PAGES_COMMIT_SHA;
  const commit = demo && pagesCommit ? buildCommit({ KEEPWATCH_COMMIT: pagesCommit }) : null;
  return {
    root: "src/web",
    publicDir: "public",
    plugins: [react(), tailwindcss(), demo && spaRedirects()],
    define: {
      __DEMO__: JSON.stringify(demo),
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_COMMIT__: JSON.stringify(commit),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/web", import.meta.url)),
        "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      },
    },
    build: { outDir: demo ? "../../dist/demo" : "../../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
    server: {
      port: 5173,
      proxy: { "/api": { target: "http://localhost:4321", ws: true } },
    },
  };
});
