import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Waypoints } from "lucide-react";
import { EmptyState, ToneBadge } from "@/components/common";
import { ServiceFlow } from "@/components/ServiceFlow";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { Cluster, KeepNode } from "@/lib/types";
import { vipAddresses, vipAlerts } from "@/lib/vrrp";
import { VipMenu } from "./ClustersPage";

const ALL = "all";
/** Faster than other pages, so a failover shows up within a couple of seconds. */
const LIVE_MS = 2_000;

/** Every VIP as a live diagram of which node serves it. */
export function ServicesPage() {
  const [clusterId, setClusterId] = useState(ALL);
  const clusters = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.get<{ clusters: Cluster[] }>("/clusters"),
    select: (d) => d.clusters,
    refetchInterval: LIVE_MS,
  });
  const nodes = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: KeepNode[] }>("/nodes"),
    select: (d) => d.nodes,
    refetchInterval: LIVE_MS,
  });

  if (clusters.isPending || nodes.isPending) {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  const all = clusters.data ?? [];
  const nodeList = nodes.data ?? [];
  const shown = all.filter((c) => clusterId === ALL || c.id === clusterId);
  const vips = shown.flatMap((cluster) => cluster.instances.map((vip) => ({ cluster, vip })));

  if (all.every((c) => c.instances.length === 0)) {
    return (
      <EmptyState icon={Waypoints} title="No services yet">
        <Button asChild>
          <Link to="/clusters">Add a VIP</Link>
        </Button>
      </EmptyState>
    );
  }

  return (
    <>
      {all.length > 1 && (
        <Select value={clusterId} onValueChange={setClusterId}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All clusters</SelectItem>
            {all.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {vips.map(({ cluster, vip }) => {
          const master = nodeList.find((n) => n.id === vip.masterNodeId);
          return (
            <Card key={vip.id} className="gap-3">
              <CardHeader>
                <CardTitle>{vip.service ?? vip.name}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {cluster.name} · {vip.service ? `${vip.name} · ` : ""}
                  {vipAddresses(vip)}
                </CardDescription>
                <CardAction className="flex items-center gap-1">
                  {vipAlerts(vip).map((a) => (
                    <ToneBadge key={a.label} tone={a.tone}>
                      {a.label}
                    </ToneBadge>
                  ))}
                  <VipMenu cluster={cluster} vip={vip} nodes={nodeList} />
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-2">
                <ServiceFlow vip={vip} nodes={nodeList} />
                {master && vip.masterSince && (
                  <p className="text-muted-foreground text-xs">
                    {master.name} active since {timeAgo(vip.masterSince)}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
