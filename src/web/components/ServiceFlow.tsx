import { useEffect, useRef, useState } from "react";
import type { KeepNode, Member, Vip } from "@/lib/types";

/** How one member's path is drawn. */
type Path = "active" | "split" | "backup" | "fault" | "maintenance" | "offline";

const STROKE: Record<Path, string> = {
  active: "var(--success)",
  split: "var(--destructive)",
  backup: "var(--muted-foreground)",
  fault: "var(--destructive)",
  maintenance: "var(--info)",
  offline: "var(--muted-foreground)",
};

const LABEL: Record<Path, string> = {
  active: "Active",
  split: "Active",
  backup: "Standby",
  fault: "Fault",
  maintenance: "Maintenance",
  offline: "Offline",
};

function pathOf(member: Member, node: KeepNode | undefined, masters: number): Path {
  if (!node?.online) return "offline";
  if (member.maintenance) return "maintenance";
  if (member.state === "MASTER") return masters > 1 ? "split" : "active";
  if (member.state === "FAULT" || member.state === "STOP") return "fault";
  return "backup";
}

const ROW = 76;
const BOX_H = 58;

/** Wide cards show the clients too; narrow ones drop them so the text stays readable on a phone. */
const LAYOUTS = {
  wide: { W: 720, clients: true, CLIENT_X: 20, VIP_X: 230, VIP_W: 190, BOX_W: 210, NODE_X: 500 },
  compact: { W: 430, clients: false, CLIENT_X: 0, VIP_X: 6, VIP_W: 156, BOX_W: 200, NODE_X: 224 },
};
const COMPACT_BELOW = 560;

/** Width of the element, updated as it resizes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(COMPACT_BELOW);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Remembers which node became master since the last render, so it can flash once. */
function useTakeover(masterId: string | null) {
  const previous = useRef(masterId);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (previous.current && masterId && previous.current !== masterId) setFlash(masterId);
    previous.current = masterId;
    if (!masterId) return;
    const t = setTimeout(() => setFlash(null), 3_600);
    return () => clearTimeout(t);
  }, [masterId]);
  return flash;
}

/**
 * Live diagram of a service: clients reach the VIP, which points at the node that holds it. It shows which node
 * keepalived made master, not measured traffic.
 */
export function ServiceFlow({ vip, nodes }: { vip: Vip; nodes: KeepNode[] }) {
  const [ref, width] = useWidth();
  const { W, clients, CLIENT_X, VIP_X, VIP_W, BOX_W, NODE_X } = width < COMPACT_BELOW ? LAYOUTS.compact : LAYOUTS.wide;
  const members = [...vip.members].sort((a, b) => b.priority - a.priority);
  const masters = members.filter((m) => m.state === "MASTER" && nodes.find((n) => n.id === m.nodeId)?.online).length;
  const takeover = useTakeover(masters === 1 ? vip.masterNodeId : null);
  const height = Math.max(ROW * members.length, 130) + 20;
  const midY = height / 2;
  const hasMaster = masters > 0;
  const addresses = vip.virtualIps.map((v) => v.address);

  return (
    <div ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${vip.service ?? vip.name}: ${
          masters === 1
            ? `served by ${nodes.find((n) => n.id === vip.masterNodeId)?.name ?? "a node"}`
            : masters > 1
              ? "split brain"
              : "no active node"
        }`}
      >
        {/* Clients to VIP */}
        {clients && (
          <>
            <path
              d={`M ${CLIENT_X + 120} ${midY} L ${VIP_X} ${midY}`}
              stroke={hasMaster ? (masters > 1 ? STROKE.split : STROKE.active) : STROKE.fault}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              className={hasMaster ? "flow-active" : undefined}
              strokeDasharray={hasMaster ? undefined : "2 8"}
            />
            <g>
              <rect
                x={CLIENT_X}
                y={midY - 26}
                width={120}
                height={52}
                rx={12}
                fill="var(--muted)"
                stroke="var(--border)"
              />
              <text x={CLIENT_X + 60} y={midY + 5} textAnchor="middle" fontSize={14} fill="var(--foreground)">
                Clients
              </text>
            </g>
          </>
        )}

        {/* VIP to each member */}
        {members.map((m, i) => {
          const node = nodes.find((n) => n.id === m.nodeId);
          const kind = pathOf(m, node, masters);
          const y = 10 + i * ROW + ROW / 2;
          const live = kind === "active" || kind === "split";
          const x1 = VIP_X + VIP_W;
          const x2 = NODE_X;
          const c = (x1 + x2) / 2;
          return (
            <path
              key={m.nodeId}
              d={`M ${x1} ${midY} C ${c} ${midY}, ${c} ${y}, ${x2} ${y}`}
              stroke={STROKE[kind]}
              strokeWidth={live ? 3 : 1.5}
              strokeOpacity={live ? 1 : 0.45}
              strokeDasharray={live ? undefined : kind === "offline" ? "1 6" : "5 6"}
              fill="none"
              strokeLinecap="round"
              className={live ? "flow-active" : undefined}
              style={{ transition: "stroke 0.4s, stroke-opacity 0.4s" }}
            />
          );
        })}

        <g>
          <rect
            x={VIP_X}
            y={midY - 34}
            width={VIP_W}
            height={68}
            rx={34}
            fill="var(--card)"
            stroke={hasMaster ? (masters > 1 ? STROKE.split : STROKE.active) : STROKE.fault}
            strokeWidth={2}
          />
          <text
            x={VIP_X + VIP_W / 2}
            y={midY - 6}
            textAnchor="middle"
            fontSize={14}
            fontWeight={600}
            fill="var(--foreground)"
          >
            {vip.service ?? vip.name}
          </text>
          <text
            x={VIP_X + VIP_W / 2}
            y={midY + 14}
            textAnchor="middle"
            fontSize={12}
            fontFamily="ui-monospace, monospace"
            fill="var(--muted-foreground)"
          >
            {addresses.length > 1 ? `${addresses[0]} +${addresses.length - 1}` : addresses[0]}
          </text>
        </g>

        {members.map((m, i) => {
          const node = nodes.find((n) => n.id === m.nodeId);
          const kind = pathOf(m, node, masters);
          const y = 10 + i * ROW + (ROW - BOX_H) / 2;
          const failing = node?.status?.checks.filter((c) => !c.ok).map((c) => c.id) ?? [];
          const detail = failing.length ? `${failing.join(", ")} failing` : `priority ${m.priority}`;
          return (
            <g key={m.nodeId} opacity={kind === "offline" ? 0.55 : 1}>
              {takeover === m.nodeId && (
                <rect
                  x={NODE_X}
                  y={y}
                  width={BOX_W}
                  height={BOX_H}
                  rx={10}
                  fill="none"
                  stroke={STROKE.active}
                  className="flow-takeover"
                />
              )}
              <rect
                x={NODE_X}
                y={y}
                width={BOX_W}
                height={BOX_H}
                rx={10}
                fill="var(--card)"
                stroke={kind === "backup" || kind === "offline" ? "var(--border)" : STROKE[kind]}
                strokeWidth={kind === "backup" || kind === "offline" ? 1 : 2}
                style={{ transition: "stroke 0.4s" }}
              />
              <circle cx={NODE_X + 16} cy={y + 20} r={5} fill={STROKE[kind]} />
              <text x={NODE_X + 28} y={y + 24} fontSize={14} fontWeight={600} fill="var(--foreground)">
                {node?.name ?? "node"}
              </text>
              <text x={NODE_X + BOX_W - 12} y={y + 24} textAnchor="end" fontSize={12} fill={STROKE[kind]}>
                {LABEL[kind]}
              </text>
              <text
                x={NODE_X + 16}
                y={y + 44}
                fontSize={12}
                fill={failing.length ? "var(--warning)" : "var(--muted-foreground)"}
              >
                {detail}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
