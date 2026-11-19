import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { FileDiff } from "@/components/FileDiff";
import { ToneBadge, type Tone } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Cluster, NodePlan, Rollout, RolloutNodeStatus } from "@/lib/types";

const STATUS: Record<RolloutNodeStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "muted" },
  applying: { label: "Applying", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  unchanged: { label: "Unchanged", tone: "muted" },
  failed: { label: "Failed", tone: "error" },
  rolled_back: { label: "Rolled back", tone: "warning" },
  skipped: { label: "Skipped", tone: "muted" },
};

function PlanRow({ plan }: { plan: NodePlan }) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{plan.name}</span>
        {plan.skipped ? (
          <ToneBadge tone="muted">Skipped: {plan.skipped}</ToneBadge>
        ) : plan.error ? (
          <ToneBadge tone="error">Error</ToneBadge>
        ) : plan.problems.length ? (
          <ToneBadge tone="error">Needs attention</ToneBadge>
        ) : plan.plan?.changed ? (
          <ToneBadge tone="info">Changes</ToneBadge>
        ) : (
          <ToneBadge tone="muted">Up to date</ToneBadge>
        )}
      </div>
      {plan.error && <p className="text-destructive text-sm">{plan.error}</p>}
      {plan.problems.length > 0 && (
        <ul className="text-destructive list-disc pl-5 text-sm">
          {plan.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {plan.plan?.changed && (
        <div className="grid gap-2">
          <FileDiff path="/etc/keepalived/conf.d/keepwatch.conf" before={plan.plan.current} after={plan.plan.next} />
          {plan.plan.mainCurrent !== plan.plan.mainNext && (
            <FileDiff
              path="/etc/keepalived/keepalived.conf"
              before={plan.plan.mainCurrent}
              after={plan.plan.mainNext}
            />
          )}
        </div>
      )}
    </div>
  );
}

const OUTPUT_CLASS = "bg-muted/50 max-h-40 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap";

function RolloutView({ cluster, rolloutId }: { cluster: Cluster; rolloutId: string }) {
  const queryClient = useQueryClient();
  const { data: rollout } = useQuery({
    queryKey: ["rollout", rolloutId],
    queryFn: () =>
      api.get<{ rollout: Rollout }>(`/clusters/${cluster.id}/rollouts/${rolloutId}`).then((r) => r.rollout),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 1_000),
  });
  useEffect(() => {
    if (rollout && rollout.status !== "running") {
      for (const key of [["clusters"], ["nodes"], ["overview"]]) queryClient.invalidateQueries({ queryKey: key });
    }
  }, [rollout?.status, queryClient, rollout]);
  if (!rollout) return <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />;
  return (
    <div className="grid gap-2">
      {rollout.nodes.map((n) => (
        <div key={n.nodeId} className="grid gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{n.name}</span>
            <ToneBadge tone={STATUS[n.status].tone}>
              {n.status === "applying" && <Loader2 className="size-3 animate-spin" />}
              {STATUS[n.status].label}
            </ToneBadge>
          </div>
          {n.error && <p className="text-destructive text-sm">{n.error}</p>}
          {n.output.length > 0 && (
            <pre className={OUTPUT_CLASS}>
              {n.output.join("\n")}
            </pre>
          )}
        </div>
      ))}
      {rollout.status !== "running" && (
        <p className={rollout.status === "failed" ? "text-destructive text-sm" : "text-success text-sm"}>
          {rollout.status === "failed" ? `Stopped: ${rollout.error}` : "Done"}
        </p>
      )}
    </div>
  );
}

/** Shows what an apply changes on each node, then rolls it out one node at a time. */
export function ApplyDialog({ cluster, onClose }: { cluster: Cluster | null; onClose: () => void }) {
  const [rolloutId, setRolloutId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => setRolloutId(null), [cluster?.id]);
  const {
    data: plans,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["plan", cluster?.id],
    queryFn: () => api.post<{ nodes: NodePlan[] }>(`/clusters/${cluster!.id}/plan`).then((r) => r.nodes),
    enabled: !!cluster && !rolloutId,
    gcTime: 0,
    retry: false,
  });
  const blocked = plans?.some((p) => p.problems.length > 0 || p.error) ?? true;
  const anyTarget = plans?.some((p) => !p.skipped) ?? false;

  const apply = async () => {
    setStarting(true);
    try {
      const { rolloutId } = await api.post<{ rolloutId: string }>(`/clusters/${cluster!.id}/apply`);
      setRolloutId(rolloutId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={!!cluster} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Apply {cluster?.name}</DialogTitle>
          <DialogDescription>
            Backups get the config first and the current master last. Each node is tested by keepalived before the
            change and rolled back if keepalived fails afterwards.
          </DialogDescription>
        </DialogHeader>
        {rolloutId && cluster ? (
          <RolloutView cluster={cluster} rolloutId={rolloutId} />
        ) : error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : isFetching || !plans ? (
          <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />
        ) : plans.length === 0 ? (
          <p className="text-muted-foreground text-sm">No node is a member of a VIP in this cluster yet.</p>
        ) : (
          <div className="grid gap-2">
            {plans.map((p) => (
              <PlanRow key={p.nodeId} plan={p} />
            ))}
          </div>
        )}
        <DialogFooter>
          {rolloutId ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <Button onClick={apply} disabled={blocked || !anyTarget || starting}>
              Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
