import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { CommandLog } from "@/components/CommandLog";
import { CopyField } from "@/components/CopyField";
import { Field, ToneBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import type { CommandState, Detected, Enrollment, ImportedInstance, KeepNode } from "@/lib/types";
import { cn } from "@/lib/utils";

type Step = "install" | "keepalived" | "done";

function useCountdown(until: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

function useNode(id: string | undefined) {
  return useQuery({
    queryKey: ["nodes", id],
    queryFn: () => api.get<{ node: KeepNode }>(`/nodes/${id}`).then((r) => r.node),
    refetchInterval: 2_000,
    enabled: !!id,
  });
}

function InstallStep({ node, onNext }: { node: KeepNode; onNext: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [startedAt] = useState(node.agent?.enrolledAt ?? null);
  const { data: live } = useNode(node.id);
  const paired = !!live?.agent && live.agent.enrolledAt !== startedAt;
  const connected = paired && live?.agent?.connected;
  const left = useCountdown(enrollment?.expiresAt);

  const fetchToken = () =>
    api
      .post<Enrollment>(`/nodes/${node.id}/enroll`)
      .then(setEnrollment)
      .catch((e) => toast.error(e.message));
  // A new token only when the dialog opens for this node.
  useEffect(() => {
    void fetchToken();
  }, [node.id]);

  if (!enrollment) return <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />;
  const minutes = Math.floor((left ?? 0) / 60);
  const seconds = String((left ?? 0) % 60).padStart(2, "0");
  return (
    <div className="grid gap-4">
      {enrollment.insecure && (
        <div className="border-warning/40 bg-warning/10 text-warning flex gap-2 rounded-md border p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          BASE_URL uses http, so the token travels unencrypted. Use https outside a trusted LAN.
        </div>
      )}
      <CopyField value={enrollment.command} />
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>{left === 0 ? "Token expired" : `One-time token, expires in ${minutes}:${seconds}`}</span>
        {left === 0 && (
          <Button size="sm" variant="outline" onClick={fetchToken}>
            New token
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Add <code className="font-mono">--allow-custom-scripts</code> to let health checks run your own scripts from
        /etc/keepwatch/scripts on this node.
      </p>
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
        {connected ? (
          <>
            <CheckCircle2 className="text-success size-4" />
            Agent v{live?.agent?.version} paired and connected
          </>
        ) : (
          <>
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
            {paired ? "Paired, waiting for the agent to connect..." : "Waiting for the agent to pair..."}
          </>
        )}
      </div>
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer">Uninstall command</summary>
        <div className="mt-2">
          <CopyField value={enrollment.uninstallCommand} />
        </div>
      </details>
      <DialogFooter>
        <Button disabled={!connected} onClick={onNext}>
          Next
        </Button>
      </DialogFooter>
    </div>
  );
}

type ImportRow = { selected: boolean; password: string };

/** The import body for one existing instance. Missing values get keepalived's defaults. */
function importPayload(inst: ImportedInstance, row: ImportRow) {
  const v6 = inst.virtualIps.some((v) => v.address.includes(":"));
  return {
    original: inst.name,
    name: inst.name,
    vrid: inst.vrid,
    vrrpVersion: v6 ? 3 : inst.vrrpVersion === 3 ? 3 : 2,
    interface: inst.interface,
    advertInt: inst.advertInt || 1,
    preempt: inst.preempt,
    preemptDelay: inst.preemptDelay,
    unicast: inst.unicastPeers.length > 0,
    virtualIps: inst.virtualIps,
    priority: inst.priority || 100,
    initialState: inst.state === "MASTER" ? "MASTER" : "BACKUP",
    ...(inst.hasPassword && row.password ? { authPass: row.password } : {}),
  };
}

function KeepalivedStep({ node, onDone }: { node: KeepNode; onDone: (imported: boolean) => void }) {
  const queryClient = useQueryClient();
  const [detected, setDetected] = useState<Detected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, ImportRow>>({});

  const detect = async () => {
    setError(null);
    try {
      const d = await api.post<Detected>(`/nodes/${node.id}/detect`);
      setDetected(d);
      setRows(Object.fromEntries(d.existing.map((i) => [i.name, { selected: true, password: "" }])));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  useEffect(() => {
    void detect();
  }, [node.id]);

  const install = async () => {
    try {
      const { commandId } = await api.post<{ commandId: string }>(`/nodes/${node.id}/install`);
      setInstalling(commandId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onInstalled = async (state: CommandState) => {
    if (state.status === "failed") {
      toast.error(state.error ?? "Installing keepalived failed");
      return;
    }
    // The agent restarts after installing keepalived; give it a moment to reconnect.
    await new Promise((r) => setTimeout(r, 4_000));
    setInstalling(null);
    await detect();
  };

  const choose = async (mode: "managed" | "monitor") => {
    setBusy(true);
    try {
      await api.post(`/nodes/${node.id}/mode`, { mode });
      queryClient.invalidateQueries({ queryKey: ["nodes"] });
      onDone(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importSelected = async () => {
    if (!detected || !node.clusterId) return;
    const instances = detected.existing
      .filter((i) => rows[i.name]?.selected)
      .map((i) => importPayload(i, rows[i.name]!));
    if (!instances.length) return toast.error("Pick at least one instance");
    setBusy(true);
    try {
      await api.post(`/nodes/${node.id}/mode`, { mode: "managed" });
      await api.post(`/clusters/${node.clusterId}/import`, { nodeId: node.id, instances });
      queryClient.invalidateQueries({ queryKey: ["nodes"] });
      queryClient.invalidateQueries({ queryKey: ["clusters"] });
      onDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="grid gap-3">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" onClick={detect}>
          Try again
        </Button>
      </div>
    );
  }
  if (!detected) return <Loader2 className="text-muted-foreground mx-auto size-6 animate-spin" />;

  if (installing) {
    return (
      <div className="grid gap-3">
        <p className="text-sm">Installing keepalived with {detected.packageManager || "the package manager"}...</p>
        <CommandLog nodeId={node.id} commandId={installing} onFinished={onInstalled} />
      </div>
    );
  }

  if (!detected.installed) {
    return (
      <div className="grid gap-4">
        <p className="text-sm">keepalived is not installed on this node.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => choose("monitor")} disabled={busy}>
            Skip
          </Button>
          <Button onClick={install} disabled={!detected.packageManager}>
            Install keepalived
          </Button>
        </DialogFooter>
        {!detected.packageManager && (
          <p className="text-muted-foreground text-xs">No apt, dnf or pacman found. Install keepalived by hand.</p>
        )}
      </div>
    );
  }

  const canManage = detected.configTest && !detected.conflict;
  const existing = detected.existing;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>keepalived {detected.version}</span>
        <ToneBadge tone={detected.service === "active" ? "success" : "warning"}>{detected.service}</ToneBadge>
        {detected.customScripts && <ToneBadge tone="info">Custom scripts allowed</ToneBadge>}
      </div>
      {!detected.configTest && (
        <p className="text-warning text-sm">
          keepalived {detected.version} cannot test a config before using it. Update to 2.0.11 or newer to let
          KeepWatch manage it.
        </p>
      )}
      {detected.conflict && <p className="text-warning text-sm">{detected.conflict}</p>}

      {existing.length > 0 && canManage && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Existing instances in keepalived.conf</p>
          {!node.clusterId && (
            <p className="text-muted-foreground text-sm">Put this node in a cluster to import them.</p>
          )}
          {existing.map((inst) => {
            const row = rows[inst.name] ?? { selected: false, password: "" };
            const set = (patch: Partial<ImportRow>) => setRows({ ...rows, [inst.name]: { ...row, ...patch } });
            return (
              <div key={inst.name} className="grid gap-2 rounded-md border p-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={row.selected} onCheckedChange={(c) => set({ selected: c === true })} />
                  <span className="font-medium">{inst.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    VRID {inst.vrid} · {inst.interface} · {inst.virtualIps.map((v) => v.address).join(", ")}
                  </span>
                </label>
                {inst.hasPassword && row.selected && (
                  <Field label="VRRP password" help="KeepWatch never reads passwords from the node. Enter it again.">
                    <Input
                      value={row.password}
                      maxLength={8}
                      onChange={(e) => set({ password: e.target.value })}
                      autoComplete="off"
                    />
                  </Field>
                )}
                {inst.unsupported.length > 0 && (
                  <p className="text-warning text-xs">Not carried over: {inst.unsupported.join(", ")}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <DialogFooter className="flex-wrap">
        <Button variant="outline" onClick={() => choose("monitor")} disabled={busy}>
          Monitor only
        </Button>
        {canManage && existing.length > 0 && (
          <Button onClick={importSelected} disabled={busy || !node.clusterId}>
            Import into KeepWatch
          </Button>
        )}
        {canManage && existing.length === 0 && (
          <Button onClick={() => choose("managed")} disabled={busy}>
            Manage with KeepWatch
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

const STEPS: { id: Step; label: string }[] = [
  { id: "install", label: "Install agent" },
  { id: "keepalived", label: "keepalived" },
  { id: "done", label: "Done" },
];

/** Pairs an agent with a node and sets up keepalived on it. */
export function NodeSetupDialog({
  node,
  start = "install",
  onClose,
}: {
  node: KeepNode | null;
  start?: Step;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>(start);
  const [imported, setImported] = useState(false);
  useEffect(() => {
    setStep(start);
    setImported(false);
  }, [node?.id, start]);

  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up {node?.name}</DialogTitle>
          <DialogDescription>
            {step === "install"
              ? "Run this on the node as root. Elsewhere than Proxmox, put sudo before sh."
              : step === "keepalived"
                ? "Choose whether KeepWatch writes this node's keepalived config or only watches it."
                : "The node is ready."}
          </DialogDescription>
        </DialogHeader>
        <ol className="flex gap-4 text-xs">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={cn("text-muted-foreground", s.id === step && "text-foreground font-medium")}
            >
              {i + 1}. {s.label}
            </li>
          ))}
        </ol>
        {node && step === "install" && <InstallStep node={node} onNext={() => setStep("keepalived")} />}
        {node && step === "keepalived" && (
          <KeepalivedStep
            node={node}
            onDone={(i) => {
              setImported(i);
              setStep("done");
            }}
          />
        )}
        {step === "done" && (
          <div className="grid gap-4 text-sm">
            <p>
              {imported
                ? "The instances are now VIPs in the cluster. Apply the cluster to move them into KeepWatch's config."
                : "Add the node to a VIP in Clusters, then apply the cluster."}
            </p>
            <DialogFooter>
              <Button onClick={onClose}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
