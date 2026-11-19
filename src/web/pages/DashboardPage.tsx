import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Activity, Network, Server, ShieldAlert, Waypoints } from "lucide-react";
import { EmptyState, StatCard, ToneBadge, type Tone } from "@/components/common";
import { EventSummary } from "@/components/EventRow";
import { FailoverChart } from "@/components/FailoverChart";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { Overview } from "@/lib/types";
import { stateLabel, stateTone, vipAddresses, vipAlerts } from "@/lib/vrrp";

type Alert = { key: string; tone: Tone; label: string; text: string };

/** Everything that needs attention now, most serious first. */
function alerts(data: Overview): Alert[] {
  const out: Alert[] = [];
  const nodeName = (id: string) => data.nodes.find((n) => n.id === id)?.name ?? "node";
  for (const cluster of data.clusters) {
    for (const vip of cluster.instances) {
      for (const a of vipAlerts(vip)) {
        const where =
          a.label === "Fault"
            ? vip.members
                .filter((m) => m.state === "FAULT" && !m.maintenance)
                .map((m) => nodeName(m.nodeId))
                .join(", ")
            : vipAddresses(vip);
        out.push({ key: `${vip.id}-${a.label}`, tone: a.tone, label: a.label, text: `${vip.name} · ${where}` });
      }
    }
  }
  for (const n of data.nodes) {
    if (!n.online) out.push({ key: `${n.id}-off`, tone: "error", label: "Offline", text: n.name });
    else if (n.service && n.service !== "active") {
      out.push({ key: `${n.id}-svc`, tone: "error", label: "keepalived", text: `${n.name} · ${n.service}` });
    }
    if (n.drift) out.push({ key: `${n.id}-drift`, tone: "warning", label: "Edited", text: n.name });
    for (const p of n.problems.filter((p) => p.startsWith("check:"))) {
      out.push({ key: `${n.id}-${p}`, tone: "warning", label: "Check", text: `${p.slice(6)} on ${n.name}` });
    }
  }
  const rank: Record<Tone, number> = { error: 0, warning: 1, info: 2, success: 3, muted: 4 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

export function DashboardPage() {
  const { data, isPending } = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<Overview>("/overview"),
    refetchInterval: 5_000,
  });

  if (isPending || !data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  const { counts } = data;
  if (counts.nodes === 0 && counts.clusters === 0) {
    return (
      <EmptyState icon={Network} title="Nothing to watch yet">
        <div className="flex gap-2">
          <Button asChild>
            <Link to="/clusters">Add a cluster</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/nodes">Add a node</Link>
          </Button>
        </div>
      </EmptyState>
    );
  }

  const list = alerts(data);
  const nodeName = (id: string | null) => data.nodes.find((n) => n.id === id)?.name ?? "-";
  const vips = data.clusters.flatMap((c) => c.instances.map((vip) => ({ cluster: c, vip })));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="VIPs" value={counts.vips} hint={`${counts.clusters} clusters`} icon={Waypoints} />
        <StatCard
          label="Nodes online"
          value={`${counts.nodesOnline}/${counts.nodes}`}
          icon={Server}
          tone={counts.nodesOnline < counts.nodes ? "warning" : "success"}
        />
        <StatCard
          label="Alerts"
          value={list.length}
          hint={counts.splitBrain ? `${counts.splitBrain} split brain` : undefined}
          icon={ShieldAlert}
          tone={list.some((a) => a.tone === "error") ? "error" : list.length ? "warning" : "success"}
        />
        <StatCard label="Events today" value={counts.eventsToday} icon={Activity} tone="info" />
      </div>

      {list.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {list.map((a) => (
              <div key={a.key} className="flex items-center gap-3 text-sm">
                <ToneBadge tone={a.tone} className="shrink-0">
                  {a.label}
                </ToneBadge>
                <span className="truncate">{a.text}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Virtual IPs</CardTitle>
            <CardAction>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/clusters">Clusters</Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-3">
            {vips.length === 0 && <p className="text-muted-foreground text-sm">No VIPs yet</p>}
            {vips.map(({ cluster, vip }) => (
              <div key={vip.id} className="grid gap-1.5 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{vip.name}</span>
                    <span className="text-muted-foreground"> · {cluster.name}</span>
                  </div>
                  <span className="font-mono text-xs">{vipAddresses(vip)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">Master</span>
                  <span className="font-medium">{nodeName(vip.masterNodeId)}</span>
                  {vip.masterSince && (
                    <span className="text-muted-foreground text-xs">since {timeAgo(vip.masterSince)}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {vip.members.map((m) => (
                    <ToneBadge key={m.nodeId} tone={stateTone(m.state, m.maintenance)}>
                      {nodeName(m.nodeId)} · {stateLabel(m.state, m.maintenance)}
                    </ToneBadge>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid content-start gap-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Failovers</CardTitle>
            </CardHeader>
            <CardContent>
              <FailoverChart data={data.failovers} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent events</CardTitle>
              <CardAction>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/events">View all</Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {data.recentEvents.length === 0 ? (
                <p className="text-muted-foreground text-sm">No events yet</p>
              ) : (
                <div className="divide-y">
                  {data.recentEvents.map((e) => (
                    <EventSummary key={e.id} event={e} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
