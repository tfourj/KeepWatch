import { Hono } from "hono";
import { checkForAgentUpdates, latestAgentRelease } from "../agents/releases";
import { COMMIT, VERSION } from "../build-info";
import { env } from "../env";
import { appSettingsSchema, getSettings, updateSettings } from "../settings";
import { parseBody, patchSchema } from "./util";

export const settingsRoutes = new Hono();

export function systemInfo() {
  const release = latestAgentRelease();
  return {
    latestAgent: release.latest,
    latestAgentError: release.error,
    agentReleaseCheckedAt: release.checkedAt,
    version: VERSION,
    commit: COMMIT,
    baseUrl: env.baseUrl,
    agentRepo: env.agentRepo,
    timezone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

settingsRoutes.get("/", (c) => c.json({ settings: getSettings(), system: systemInfo() }));

settingsRoutes.patch("/", async (c) => {
  const body = await parseBody(c, patchSchema(appSettingsSchema));
  if (body instanceof Response) return body;
  return c.json({ settings: updateSettings(body), system: systemInfo() });
});

settingsRoutes.post("/check-agent-release", async (c) => {
  await checkForAgentUpdates();
  return c.json(systemInfo());
});
