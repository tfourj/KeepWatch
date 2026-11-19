import type { CheckParams } from "./keepalived";

/** A ready-made health check for a common service. Fills the check form; everything stays editable. */
export type CheckPreset = {
  id: string;
  service: string;
  name: string;
  key: string;
  params: CheckParams;
  weight: number;
};

/** Common services, their usual process names and ports. */
export const CHECK_PRESETS: CheckPreset[] = [
  {
    id: "adguard-process",
    service: "AdGuard Home",
    name: "AdGuard Home running",
    key: "adguard",
    params: { type: "process", process: "AdGuardHome" },
    weight: 0,
  },
  {
    id: "adguard-dns",
    service: "AdGuard Home",
    name: "DNS answers on port 53",
    key: "dns",
    params: { type: "tcp", host: "127.0.0.1", port: 53 },
    weight: 0,
  },
  {
    id: "pihole-process",
    service: "Pi-hole",
    name: "Pi-hole running",
    key: "pihole",
    params: { type: "process", process: "pihole-FTL" },
    weight: 0,
  },
  {
    id: "unbound-process",
    service: "Unbound",
    name: "Unbound running",
    key: "unbound",
    params: { type: "process", process: "unbound" },
    weight: 0,
  },
  {
    id: "nginx-process",
    service: "nginx",
    name: "nginx running",
    key: "nginx",
    params: { type: "process", process: "nginx" },
    weight: 0,
  },
  {
    id: "haproxy-process",
    service: "HAProxy",
    name: "HAProxy running",
    key: "haproxy",
    params: { type: "process", process: "haproxy" },
    weight: 0,
  },
  {
    id: "http-health",
    service: "Web app",
    name: "Health endpoint",
    key: "health",
    params: { type: "http", url: "http://127.0.0.1/health", expectStatus: 200, insecureTls: false },
    weight: -30,
  },
  {
    id: "postgres-port",
    service: "PostgreSQL",
    name: "PostgreSQL port",
    key: "postgres",
    params: { type: "tcp", host: "127.0.0.1", port: 5432 },
    weight: -60,
  },
  {
    id: "home-assistant",
    service: "Home Assistant",
    name: "Home Assistant web",
    key: "hass",
    params: { type: "http", url: "http://127.0.0.1:8123/", expectStatus: 200, insecureTls: false },
    weight: 0,
  },
];

/** Service names for the VIP editor's suggestions. */
export const SERVICE_NAMES = [...new Set(CHECK_PRESETS.map((p) => p.service))];
