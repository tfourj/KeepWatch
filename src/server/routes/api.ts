import { Hono } from "hono";
import { requireSession, type AuthVars } from "../auth/middleware";
import { clusterRoutes } from "./clusters";
import { nodeRoutes } from "./nodes";
import { overviewRoutes } from "./overview";
import { settingsRoutes } from "./settings";

/** Authenticated API used by the web UI. */
export const apiRoutes = new Hono<AuthVars>();

apiRoutes.use("*", requireSession);
apiRoutes.route("/overview", overviewRoutes);
apiRoutes.route("/clusters", clusterRoutes);
apiRoutes.route("/nodes", nodeRoutes);
apiRoutes.route("/settings", settingsRoutes);
