import { Hono } from "hono";
import { requireSession, type AuthVars } from "../auth/middleware";
import { settingsRoutes } from "./settings";

/** Authenticated API used by the web UI. */
export const apiRoutes = new Hono<AuthVars>();

apiRoutes.use("*", requireSession);
apiRoutes.route("/settings", settingsRoutes);
