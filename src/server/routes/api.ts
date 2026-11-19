import { Hono } from "hono";
import { requireSession, type AuthVars } from "../auth/middleware";
import { channelRoutes } from "./channels";
import { clusterRoutes } from "./clusters";
import { eventRoutes } from "./events";
import { nodeRoutes } from "./nodes";
import { overviewRoutes } from "./overview";
import { securityRoutes } from "./security";
import { settingsRoutes } from "./settings";

/** Authenticated API used by the web UI. */
export const apiRoutes = new Hono<AuthVars>();

apiRoutes.use("*", requireSession);
apiRoutes.route("/overview", overviewRoutes);
apiRoutes.route("/clusters", clusterRoutes);
apiRoutes.route("/nodes", nodeRoutes);
apiRoutes.route("/events", eventRoutes);
apiRoutes.route("/channels", channelRoutes);
apiRoutes.route("/settings", settingsRoutes);
apiRoutes.route("/security", securityRoutes);
