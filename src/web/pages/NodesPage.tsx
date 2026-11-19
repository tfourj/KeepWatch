import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Settings2,
  Trash2,
  Unlink,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, ToneBadge } from "@/components/common";
import { ConfirmAction } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAction } from "@/lib/mutations";
import type { KeepNode } from "@/lib/types";
import { nodeHealth, stateLabel, stateTone } from "@/lib/vrrp";
import { NodeDialog } from "./NodeDialog";
import { NodeLogsDialog } from "./NodeLogsDialog";
import { NodeSetupDialog } from "./NodeSetupDialog";

type UpdateCheck =
  | { ok: true; status: "current" | "updating"; version: string | null; latestVersion: string }
  | { ok: false; error: string };

const INVALIDATE = [["nodes"], ["overview"], ["clusters"]];

function AgentLine({ node }: { node: KeepNode }) {
  const agent = node.agent;
  if (!agent) return <span className="text-muted-foreground">Not installed</span>;
  const updating = agent.updateStatus === "updating" || agent.updateStatus === "restarting";
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-xs">v{agent.version}</span>
      {agent.hostname && <span className="text-muted-foreground text-xs">on {agent.hostname}</span>}
      {updating && <Badge variant="secondary">Updating</Badge>}
      {!updating && agent.updateAvailable && (
        <Badge variant="outline" className="border-info/40 text-info">
          v{agent.latestVersion} available
        </Badge>
      )}
      {agent.updateStatus === "failed" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Update failed
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{agent.lastUpdateError}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

function NodeMenu({
  node,
  onEdit,
  onSetup,
  onLogs,
}: {
  node: KeepNode;
  onEdit: () => void;
  onSetup: (start: "install" | "keepalived") => void;
  onLogs: () => void;
}) {
  const managed = node.configMode === "managed";
  const ready = !!node.agent?.connected;
  const service = useAction((action: string) => api.post(`/nodes/${node.id}/service`, { action }), {
    invalidate: INVALIDATE,
    success: "Done",
  });
  const maintenance = useAction((on: boolean) => api.post(`/nodes/${node.id}/maintenance`, { on, instances: [] }), {
    invalidate: INVALIDATE,
    success: (r) => (r ? "Maintenance changed" : null),
  });
  const update = useAction(() => api.post<UpdateCheck>(`/nodes/${node.id}/check-update`), {
    invalidate: INVALIDATE,
    success: (r) =>
      r.ok && r.status === "current" ? `Agent v${r.version} is up to date` : r.ok ? "Updating the agent" : null,
  });
  const autoUpdate = useAction((enabled: boolean) => api.patch(`/nodes/${node.id}/auto-update`, { enabled }), {
    invalidate: INVALIDATE,
  });
  const unpair = useAction(() => api.post(`/nodes/${node.id}/unpair`), {
    invalidate: INVALIDATE,
    success: "Agent unpaired",
  });
  const remove = useAction(() => api.delete(`/nodes/${node.id}`), {
    invalidate: INVALIDATE,
    success: "Node removed",
  });
  const inMaintenance = node.members.some((m) => m.maintenance);

  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${node.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {node.agent && !node.configMode && (
          <DropdownMenuItem onClick={() => onSetup("keepalived")} disabled={!ready}>
            <Settings2 />
            Finish setup
          </DropdownMenuItem>
        )}
        {managed && node.members.length > 0 && (
          <DropdownMenuItem onClick={() => maintenance.mutate(!inMaintenance)} disabled={!ready}>
            <Wrench />
            {inMaintenance ? "End maintenance" : "Maintenance"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => service.mutate("reload")} disabled={!ready}>
          <RefreshCw />
          Reload keepalived
        </DropdownMenuItem>
        <ConfirmAction
          onClosed={closeMenu}
          trigger={
            <DropdownMenuItem onSelect={(e) => e.preventDefault()} disabled={!ready}>
              <RotateCw />
              Restart keepalived
            </DropdownMenuItem>
          }
          title={`Restart keepalived on ${node.name}?`}
          description="VIPs this node holds move to a backup while keepalived restarts."
          confirmLabel="Restart"
          onConfirm={() => service.mutateAsync("restart")}
        />
        <DropdownMenuItem onClick={onLogs} disabled={!ready}>
          <FileText />
          keepalived log
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onSetup("install")}>
          <Download />
          {node.agent ? "Reinstall agent" : "Install agent"}
        </DropdownMenuItem>
        {node.agent && (
          <>
            <DropdownMenuItem onClick={() => update.mutate(undefined)} disabled={!ready || update.isPending}>
              <RefreshCw />
              Check for update
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={node.agent.autoUpdate}
              onCheckedChange={(c) => autoUpdate.mutate(c === true)}
            >
              Automatic updates
            </DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuItem onClick={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {node.agent && (
          <ConfirmAction
            onClosed={closeMenu}
            trigger={
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <Unlink />
                Unpair agent
              </DropdownMenuItem>
            }
            title={`Unpair the agent on ${node.name}?`}
            description="keepalived keeps running with its current config. Install the agent again to manage it."
            confirmLabel="Unpair"
            destructive
            onConfirm={() => unpair.mutateAsync(undefined)}
          />
        )}
        <ConfirmAction
          onClosed={closeMenu}
          trigger={
            <DropdownMenuItem variant="destructive" onSelect={(e) => e.preventDefault()}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          }
          title={`Remove ${node.name}?`}
          description="The node leaves its VIPs and its agent is unpaired. keepalived keeps running as it is."
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutateAsync(undefined)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NodeCard({
  node,
  onEdit,
  onSetup,
  onLogs,
}: {
  node: KeepNode;
  onEdit: () => void;
  onSetup: (start: "install" | "keepalived") => void;
  onLogs: () => void;
}) {
  const health = nodeHealth(node);
  const status = node.status;
  const failing = status?.checks.filter((c) => !c.ok) ?? [];
  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {node.name}
            <ToneBadge tone={health.tone}>{health.label}</ToneBadge>
          </CardTitle>
          <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
            {node.description && <span>{node.description}</span>}
            {node.cluster && <Badge variant="outline">{node.cluster.name}</Badge>}
            {node.configMode === "monitor" && <Badge variant="secondary">Monitor only</Badge>}
          </div>
        </div>
        <NodeMenu node={node} onEdit={onEdit} onSetup={onSetup} onLogs={onLogs} />
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {!node.agent && (
          <Button variant="outline" className="justify-self-start" onClick={() => onSetup("install")}>
            <Download />
            Install agent
          </Button>
        )}
        {node.agent && (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1.5">
            <dt className="text-muted-foreground">Agent</dt>
            <dd>
              <AgentLine node={node} />
            </dd>
            <dt className="text-muted-foreground">keepalived</dt>
            <dd className="font-mono text-xs">{status?.version ? `v${status.version}` : "-"}</dd>
            <dt className="text-muted-foreground">Last report</dt>
            <dd>{status ? timeAgo(status.reportedAt) : "never"}</dd>
          </dl>
        )}
        {(status?.drift || node.behind || failing.length > 0 || node.migrateInstances?.length) && (
          <div className="flex flex-wrap gap-1.5">
            {status?.drift && <ToneBadge tone="warning">Edited outside KeepWatch</ToneBadge>}
            {node.behind && <ToneBadge tone="info">Changes not applied</ToneBadge>}
            {node.migrateInstances?.length ? <ToneBadge tone="info">Import pending</ToneBadge> : null}
            {failing.map((c) => (
              <Tooltip key={c.id}>
                <TooltipTrigger asChild>
                  <span>
                    <ToneBadge tone="error">{c.id} failing</ToneBadge>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{c.error}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
        {node.members.length > 0 && (
          <ul className="grid gap-1.5 border-t pt-3">
            {node.members.map((m) => (
              <li key={m.instanceId} className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{m.service ?? m.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs">prio {m.priority}</span>
                  <ToneBadge tone={stateTone(m.state, m.maintenance)}>{stateLabel(m.state, m.maintenance)}</ToneBadge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function NodesPage() {
  const { data: nodes = [], isPending } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: KeepNode[] }>("/nodes"),
    select: (d) => d.nodes,
    refetchInterval: 5_000,
  });
  const [editing, setEditing] = useState<KeepNode | undefined>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [setup, setSetup] = useState<{ node: KeepNode; start: "install" | "keepalived" } | null>(null);
  const [logs, setLogs] = useState<KeepNode | null>(null);

  const openSetup = (node: KeepNode, start: "install" | "keepalived") => {
    if (start === "keepalived" && !node.agent?.connected) return toast.error("The agent is not connected");
    setSetup({ node, start });
  };

  return (
    <>
      <PageHeader title="Nodes">
        <Button
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
        >
          <Plus />
          Add node
        </Button>
      </PageHeader>
      {!isPending && nodes.length === 0 ? (
        <EmptyState icon={Server} title="No nodes yet">
          <Button onClick={() => setDialogOpen(true)}>
            <Plus />
            Add node
          </Button>
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              onEdit={() => {
                setEditing(node);
                setDialogOpen(true);
              }}
              onSetup={(start) => openSetup(node, start)}
              onLogs={() => setLogs(node)}
            />
          ))}
        </div>
      )}
      <NodeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        node={editing}
        onCreated={(node) => setSetup({ node, start: "install" })}
      />
      <NodeSetupDialog node={setup?.node ?? null} start={setup?.start} onClose={() => setSetup(null)} />
      <NodeLogsDialog node={logs} onClose={() => setLogs(null)} />
    </>
  );
}
