import type { Tone } from "@/components/common";
import type { KeepNode, Vip } from "@/lib/types";

/** Badge tone for a VRRP state. */
export function stateTone(state: string | null | undefined, maintenance = false): Tone {
  if (maintenance) return "info";
  switch (state) {
    case "MASTER":
      return "success";
    case "BACKUP":
      return "muted";
    case "FAULT":
      return "error";
    case "STOP":
      return "warning";
    default:
      return "muted";
  }
}

export function stateLabel(state: string | null | undefined, maintenance = false) {
  if (maintenance) return "Maintenance";
  if (!state || state === "UNKNOWN") return "Unknown";
  return state.charAt(0) + state.slice(1).toLowerCase();
}

/** How a node's keepalived is doing, for its status badge. */
export function nodeHealth(node: Pick<KeepNode, "online" | "status" | "agent" | "configMode">): {
  label: string;
  tone: Tone;
} {
  if (!node.agent) return { label: "No agent", tone: "muted" };
  if (!node.online) return { label: "Offline", tone: "error" };
  if (!node.status) return { label: "Waiting for report", tone: "muted" };
  if (!node.status.installed) return { label: "keepalived missing", tone: "warning" };
  if (!node.configMode) return { label: "Setup needed", tone: "warning" };
  if (node.status.service !== "active") return { label: `keepalived ${node.status.service}`, tone: "error" };
  return { label: "Running", tone: "success" };
}

/** Problems with a VIP right now, most serious first. */
export function vipAlerts(vip: Vip): { label: string; tone: Tone }[] {
  const out: { label: string; tone: Tone }[] = [];
  if (vip.splitBrainSince) out.push({ label: "Split brain", tone: "error" });
  if (vip.noMasterSince) out.push({ label: "No master", tone: "error" });
  if (vip.members.some((m) => m.state === "FAULT" && !m.maintenance)) out.push({ label: "Fault", tone: "warning" });
  return out;
}

export function vipAddresses(vip: Pick<Vip, "virtualIps">) {
  return vip.virtualIps.map((v) => `${v.address}/${v.prefix}`).join(", ");
}
