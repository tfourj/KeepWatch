import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  HeartPulse,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { CHECK_TYPE_LABELS } from "@shared/keepalived";
import { EmptyState, PageHeader, ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { Check, Cluster, KeepNode, Vip } from "@/lib/types";
import { nodeHealth, stateLabel, stateTone, vipAddresses, vipAlerts } from "@/lib/vrrp";
import { ApplyDialog } from "./ApplyDialog";
import { CheckDialog } from "./CheckDialog";
import { ClusterDialog } from "./ClusterDialog";
import { VipDialog } from "./VipDialog";

const INVALIDATE = [["clusters"], ["nodes"], ["overview"]];

function checkTarget(check: Check) {
  const p = check.params;
  if (p.type === "tcp") return `${p.host}:${p.port}`;
  if (p.type === "http") return p.url;
  if (p.type === "ping") return p.host;
  if (p.type === "process") return p.process;
  return p.path;
}

export function VipMenu({
  cluster,
  vip,
  nodes,
  onEdit,
}: {
  cluster: Cluster;
  vip: Vip;
  nodes: KeepNode[];
  /** Left out where the VIP cannot be edited, like the Services page. */
  onEdit?: () => void;
}) {
  const maintenance = useAction(
    (body: { nodeId?: string; on: boolean }) =>
      api.post(`/clusters/${cluster.id}/instances/${vip.id}/maintenance`, body),
    { invalidate: INVALIDATE, success: (_r) => "Sent to the node" },
  );
  const remove = useAction(() => api.delete(`/clusters/${cluster.id}/instances/${vip.id}`), {
    invalidate: INVALIDATE,
    success: "VIP removed. Apply the cluster to remove it from the nodes.",
  });
  const master = nodes.find((n) => n.id === vip.masterNodeId);
  const inMaintenance = vip.members.filter((m) => m.maintenance);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${vip.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {onEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil />
            Edit
          </DropdownMenuItem>
        )}
        {master && master.configMode === "managed" && (
          <ConfirmAction
            onClosed={closeMenu}
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <ArrowRightLeft />
                Fail over
              </DropdownMenuItem>
            }
            title={`Fail ${vip.name} over?`}
            description={
              `${master.name} goes into maintenance for this VIP so a backup takes over. ` +
              "It stays there until you end the maintenance."
            }
            confirmLabel="Fail over"
            onConfirm={() => maintenance.mutateAsync({ nodeId: master.id, on: true })}
          />
        )}
        {inMaintenance.map((m) => (
          <DropdownMenuItem key={m.nodeId} onClick={() => maintenance.mutate({ nodeId: m.nodeId, on: false })}>
            <Wrench />
            End maintenance on {nodes.find((n) => n.id === m.nodeId)?.name ?? "node"}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <ConfirmAction
          onClosed={closeMenu}
          trigger={
            <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          }
          title={`Remove ${vip.name}?`}
          description="It stays on the nodes until the cluster is applied."
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutateAsync(undefined)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VipTable({ cluster, nodes, onEdit }: { cluster: Cluster; nodes: KeepNode[]; onEdit: (vip: Vip) => void }) {
  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? "node";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>VIP</TableHead>
          <TableHead>Addresses</TableHead>
          <TableHead>Master</TableHead>
          <TableHead>Members</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {cluster.instances.map((vip) => (
          <TableRow key={vip.id}>
            <TableCell>
              <div className="font-medium">{vip.service ?? vip.name}</div>
              <div className="text-muted-foreground font-mono text-xs">
                {vip.service && `${vip.name} · `}VRID {vip.vrid} · {vip.interface} · v{vip.vrrpVersion}
              </div>
            </TableCell>
            <TableCell className="font-mono text-xs">{vipAddresses(vip)}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                {vip.masterNodeId ? (
                  <span>
                    {nodeName(vip.masterNodeId)}
                    {vip.masterSince && (
                      <span className="text-muted-foreground text-xs"> since {timeAgo(vip.masterSince)}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
                {vipAlerts(vip).map((a) => (
                  <ToneBadge key={a.label} tone={a.tone}>
                    {a.label}
                  </ToneBadge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1.5">
                {vip.members.map((m) => (
                  <ToneBadge key={m.nodeId} tone={stateTone(m.state, m.maintenance)}>
                    {nodeName(m.nodeId)} {m.priority} · {stateLabel(m.state, m.maintenance)}
                  </ToneBadge>
                ))}
              </div>
            </TableCell>
            <TableCell>
              <VipMenu cluster={cluster} vip={vip} nodes={nodes} onEdit={() => onEdit(vip)} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ChecksList({ cluster, onEdit }: { cluster: Cluster; onEdit: (check: Check) => void }) {
  const remove = useAction((id: string) => api.delete(`/clusters/${cluster.id}/checks/${id}`), {
    invalidate: INVALIDATE,
    success: "Check removed",
  });
  return (
    <ul className="grid gap-2">
      {cluster.checks.map((check) => {
        const used = cluster.instances.filter((i) => i.checkIds.includes(check.id)).map((i) => i.name);
        return (
          <li key={check.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{check.name}</span>
                <Badge variant="outline">{CHECK_TYPE_LABELS[check.params.type]}</Badge>
                <span className="text-muted-foreground truncate font-mono text-xs">{checkTarget(check)}</span>
              </div>
              <div className="text-muted-foreground text-xs">
                {check.weight === 0 ? "FAULT while failing" : `Priority ${check.weight} while failing`}
                {used.length ? ` · ${used.join(", ")}` : " · not used"}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" size="icon" aria-label={`Edit ${check.name}`} onClick={() => onEdit(check)}>
                <Pencil />
              </Button>
              <ConfirmAction
                trigger={
                  <Button variant="ghost" size="icon" aria-label={`Remove ${check.name}`}>
                    <Trash2 />
                  </Button>
                }
                title={`Remove ${check.name}?`}
                description="VIPs using it stop checking it after the next apply."
                confirmLabel="Remove"
                destructive
                onConfirm={() => remove.mutateAsync(check.id)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ClusterCard({
  cluster,
  nodes,
  onEdit,
  onApply,
}: {
  cluster: Cluster;
  nodes: KeepNode[];
  onEdit: () => void;
  onApply: () => void;
}) {
  const [vipDialog, setVipDialog] = useState<{ vip?: Vip } | null>(null);
  const [checkDialog, setCheckDialog] = useState<{ check?: Check } | null>(null);
  const remove = useAction(() => api.delete(`/clusters/${cluster.id}`), {
    invalidate: INVALIDATE,
    success: "Cluster removed",
  });
  const members = nodes.filter((n) => n.clusterId === cluster.id);
  const behind = members.filter((n) => n.behind || n.migrateInstances?.length).length;
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {cluster.name}
          {behind > 0 && <ToneBadge tone="info">{behind} not applied</ToneBadge>}
        </CardTitle>
        {cluster.description && <CardDescription>{cluster.description}</CardDescription>}
        <CardAction className="flex gap-1">
          <Button size="sm" onClick={onApply}>
            <Upload />
            Apply
          </Button>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${cluster.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setVipDialog({})}>
                <Plus />
                Add VIP
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCheckDialog({})}>
                <HeartPulse />
                Add health check
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ConfirmAction
                onClosed={closeMenu}
                trigger={
                  <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
                    <Trash2 />
                    Remove
                  </DropdownMenuItem>
                }
                title={`Remove ${cluster.name}?`}
                description="Its VIPs and checks are removed here. Nodes keep their keepalived config as it is."
                confirmLabel="Remove"
                destructive
                onConfirm={() => remove.mutateAsync(undefined)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-wrap gap-1.5">
          {members.length === 0 ? (
            <span className="text-muted-foreground text-sm">No nodes in this cluster</span>
          ) : (
            members.map((n) => {
              const health = nodeHealth(n);
              return (
                <ToneBadge key={n.id} tone={health.tone}>
                  {n.name} · {health.label}
                </ToneBadge>
              );
            })
          )}
        </div>
        {cluster.instances.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-md border border-dashed p-4 text-sm">
            <span className="text-muted-foreground">No VIPs yet</span>
            <Button size="sm" variant="outline" onClick={() => setVipDialog({})} disabled={!members.length}>
              <Plus />
              Add VIP
            </Button>
          </div>
        ) : (
          <VipTable cluster={cluster} nodes={nodes} onEdit={(vip) => setVipDialog({ vip })} />
        )}
        {cluster.checks.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Health checks</h3>
            <ChecksList cluster={cluster} onEdit={(check) => setCheckDialog({ check })} />
          </div>
        )}
      </CardContent>
      <VipDialog
        open={!!vipDialog}
        onOpenChange={(o) => !o && setVipDialog(null)}
        cluster={cluster}
        nodes={nodes}
        vip={vipDialog?.vip}
      />
      <CheckDialog
        open={!!checkDialog}
        onOpenChange={(o) => !o && setCheckDialog(null)}
        cluster={cluster}
        check={checkDialog?.check}
      />
    </Card>
  );
}

export function ClustersPage() {
  const { data: clusters = [], isPending } = useQuery({
    queryKey: ["clusters"],
    queryFn: () => api.get<{ clusters: Cluster[] }>("/clusters"),
    select: (d) => d.clusters,
    refetchInterval: 5_000,
  });
  const { data: nodes = [] } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: KeepNode[] }>("/nodes"),
    select: (d) => d.nodes,
    refetchInterval: 5_000,
  });
  const [dialog, setDialog] = useState<{ cluster?: Cluster } | null>(null);
  const [applying, setApplying] = useState<Cluster | null>(null);

  return (
    <>
      <PageHeader title="Clusters">
        <Button onClick={() => setDialog({})}>
          <Plus />
          Add cluster
        </Button>
      </PageHeader>
      {!isPending && clusters.length === 0 ? (
        <EmptyState icon={Network} title="No clusters yet">
          <Button onClick={() => setDialog({})}>
            <Plus />
            Add cluster
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4">
          {clusters.map((cluster) => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              nodes={nodes}
              onEdit={() => setDialog({ cluster })}
              onApply={() => setApplying(cluster)}
            />
          ))}
        </div>
      )}
      <ClusterDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} cluster={dialog?.cluster} />
      <ApplyDialog cluster={applying} onClose={() => setApplying(null)} />
    </>
  );
}
