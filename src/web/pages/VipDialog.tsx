import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { instanceInputProblems, instanceInputSchema } from "@shared/clusters";
import { Field, SwitchRow } from "@/components/common";
import { MultiCheck } from "@/components/MultiCheck";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import type { Cluster, KeepNode, Vip } from "@/lib/types";

type MemberForm = { included: boolean; priority: number; interface: string; master: boolean };

type Form = {
  name: string;
  vrid: number;
  vrrpVersion: 2 | 3;
  interface: string;
  advertInt: number;
  preempt: boolean;
  preemptDelay: number;
  unicast: boolean;
  password: string;
  removePassword: boolean;
  addresses: { address: string; prefix: number }[];
  members: Record<string, MemberForm>;
  checkIds: string[];
};

function nextVrid(cluster: Cluster) {
  const used = new Set(cluster.instances.map((i) => i.vrid));
  for (let v = 51; v <= 255; v++) if (!used.has(v)) return v;
  return 1;
}

/** The interface most member nodes report, for a new VIP. */
function commonInterface(nodes: KeepNode[]) {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const i of n.interfaces) if (i.cidrs.length) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "eth0";
}

function toForm(cluster: Cluster, nodes: KeepNode[], vip?: Vip): Form {
  const members: Record<string, MemberForm> = {};
  nodes.forEach((n, index) => {
    const m = vip?.members.find((x) => x.nodeId === n.id);
    members[n.id] = m
      ? { included: true, priority: m.priority, interface: m.interface ?? "", master: m.initialState === "MASTER" }
      : { included: !vip, priority: 150 - index * 10, interface: "", master: !vip && index === 0 };
  });
  return {
    name: vip?.name ?? `VI_${cluster.instances.length + 1}`,
    vrid: vip?.vrid ?? nextVrid(cluster),
    vrrpVersion: vip?.vrrpVersion ?? 3,
    interface: vip?.interface ?? commonInterface(nodes),
    advertInt: vip?.advertInt ?? 1,
    preempt: vip?.preempt ?? true,
    preemptDelay: vip?.preemptDelay ?? 0,
    unicast: vip?.unicast ?? true,
    password: "",
    removePassword: false,
    addresses: vip?.virtualIps.map((v) => ({ address: v.address, prefix: v.prefix })) ?? [{ address: "", prefix: 24 }],
    members,
    checkIds: vip?.checkIds ?? [],
  };
}

function toBody(form: Form, vip?: Vip) {
  const clear = form.vrrpVersion !== 2 || form.removePassword;
  const authPass = clear ? (vip?.hasPassword ? null : undefined) : form.password || undefined;
  return {
    name: form.name.trim(),
    vrid: form.vrid,
    vrrpVersion: form.vrrpVersion,
    interface: form.interface.trim(),
    advertInt: form.advertInt,
    preempt: form.preempt,
    preemptDelay: form.preemptDelay,
    unicast: form.unicast,
    authPass,
    virtualIps: form.addresses
      .filter((a) => a.address.trim())
      .map((a) => ({ address: a.address.trim(), prefix: a.prefix })),
    members: Object.entries(form.members)
      .filter(([, m]) => m.included)
      .map(([nodeId, m]) => ({
        nodeId,
        priority: m.priority,
        interface: m.interface.trim() || null,
        initialState: m.master ? ("MASTER" as const) : ("BACKUP" as const),
      })),
    checkIds: form.checkIds,
  };
}

/** Problems shown before saving, from the same rules the server uses. */
function problems(form: Form, vip?: Vip): string[] {
  const parsed = instanceInputSchema.safeParse(toBody(form, vip));
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "VIP"}: ${i.message}`);
  }
  return instanceInputProblems(parsed.data, vip?.hasPassword ?? false);
}

export function VipDialog({
  open,
  onOpenChange,
  cluster,
  nodes,
  vip,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cluster: Cluster;
  nodes: KeepNode[];
  vip?: Vip;
}) {
  const clusterNodes = useMemo(() => nodes.filter((n) => n.clusterId === cluster.id), [nodes, cluster.id]);
  const [form, setForm] = useState<Form>(() => toForm(cluster, clusterNodes, vip));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(toForm(cluster, clusterNodes, vip));
      setTouched(false);
    }
  }, [open, cluster, clusterNodes, vip]);

  const save = useAction(
    () =>
      vip
        ? api.put(`/clusters/${cluster.id}/instances/${vip.id}`, toBody(form, vip))
        : api.post(`/clusters/${cluster.id}/instances`, toBody(form)),
    { invalidate: [["clusters"], ["nodes"], ["overview"]], success: vip ? "VIP saved" : "VIP added" },
  );
  const issues = problems(form, vip);
  const setMember = (id: string, patch: Partial<MemberForm>) =>
    setForm((f) => ({ ...f, members: { ...f.members, [id]: { ...f.members[id]!, ...patch } } }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{vip ? `Edit ${vip.name}` : "Add VIP"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={async (e) => {
            e.preventDefault();
            setTouched(true);
            if (issues.length) return;
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="vip-name" className="sm:col-span-2">
              <Input id="vip-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="VRID" htmlFor="vip-vrid">
              <Input
                id="vip-vrid"
                type="number"
                min={1}
                max={255}
                value={form.vrid}
                onChange={(e) => setForm({ ...form, vrid: Number(e.target.value) })}
              />
            </Field>
            <Field label="Interface" htmlFor="vip-iface">
              <Input
                id="vip-iface"
                value={form.interface}
                onChange={(e) => setForm({ ...form, interface: e.target.value })}
              />
            </Field>
            <Field label="VRRP version">
              <Select
                value={String(form.vrrpVersion)}
                onValueChange={(v) => setForm({ ...form, vrrpVersion: Number(v) as 2 | 3 })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Advert interval (s)" htmlFor="vip-advert">
              <Input
                id="vip-advert"
                type="number"
                min={1}
                max={255}
                value={form.advertInt}
                onChange={(e) => setForm({ ...form, advertInt: Number(e.target.value) })}
              />
            </Field>
          </div>

          <Field label="Addresses">
            <div className="grid gap-2">
              {form.addresses.map((a, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    aria-label="Address"
                    placeholder="10.0.0.10"
                    value={a.address}
                    onChange={(e) => {
                      const addresses = [...form.addresses];
                      addresses[i] = { ...a, address: e.target.value };
                      setForm({ ...form, addresses });
                    }}
                  />
                  <Input
                    aria-label="Prefix length"
                    className="w-20"
                    type="number"
                    min={0}
                    max={128}
                    value={a.prefix}
                    onChange={(e) => {
                      const addresses = [...form.addresses];
                      addresses[i] = { ...a, prefix: Number(e.target.value) };
                      setForm({ ...form, addresses });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove address"
                    disabled={form.addresses.length === 1}
                    onClick={() => setForm({ ...form, addresses: form.addresses.filter((_, j) => j !== i) })}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => setForm({ ...form, addresses: [...form.addresses, { address: "", prefix: 24 }] })}
              >
                <Plus />
                Address
              </Button>
            </div>
          </Field>

          <Field label="Members">
            {clusterNodes.length === 0 ? (
              <p className="text-muted-foreground text-sm">Add nodes to this cluster first.</p>
            ) : (
              <div className="grid gap-2">
                {clusterNodes.map((n) => {
                  const m = form.members[n.id]!;
                  return (
                    <div key={n.id} className="grid grid-cols-[1fr_5rem_7rem_auto] items-center gap-2">
                      <label className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={m.included}
                          onCheckedChange={(c) => setMember(n.id, { included: c === true })}
                        />
                        <span className="truncate">{n.name}</span>
                      </label>
                      <Input
                        aria-label={`Priority of ${n.name}`}
                        type="number"
                        min={1}
                        max={254}
                        value={m.priority}
                        disabled={!m.included}
                        onChange={(e) => setMember(n.id, { priority: Number(e.target.value) })}
                      />
                      <Input
                        aria-label={`Interface on ${n.name}`}
                        placeholder={form.interface}
                        value={m.interface}
                        disabled={!m.included}
                        onChange={(e) => setMember(n.id, { interface: e.target.value })}
                      />
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={m.master}
                          disabled={!m.included || !form.preempt}
                          onCheckedChange={(c) => {
                            const members = Object.fromEntries(
                              Object.entries(form.members).map(([id, x]) => [id, { ...x, master: false }]),
                            );
                            members[n.id] = { ...m, master: c === true };
                            setForm({ ...form, members });
                          }}
                        />
                        Starts as master
                      </label>
                    </div>
                  );
                })}
                <p className="text-muted-foreground text-xs">
                  The member with the highest priority holds the VIP. Interface overrides the VIP interface.
                </p>
              </div>
            )}
          </Field>

          <div className="grid gap-2">
            <SwitchRow label="Preempt" help="A member with a higher priority takes the VIP back when it returns">
              <Switch
                checked={form.preempt}
                onCheckedChange={(preempt) => {
                  const members = preempt
                    ? form.members
                    : Object.fromEntries(Object.entries(form.members).map(([id, x]) => [id, { ...x, master: false }]));
                  setForm({ ...form, preempt, members });
                }}
              />
            </SwitchRow>
            {form.preempt && (
              <Field label="Preempt delay (s)" htmlFor="vip-delay">
                <Input
                  id="vip-delay"
                  type="number"
                  min={0}
                  max={1000}
                  value={form.preemptDelay}
                  onChange={(e) => setForm({ ...form, preemptDelay: Number(e.target.value) })}
                />
              </Field>
            )}
            <SwitchRow label="Unicast" help="Send adverts straight to the other members instead of multicast">
              <Switch checked={form.unicast} onCheckedChange={(unicast) => setForm({ ...form, unicast })} />
            </SwitchRow>
          </div>

          {form.vrrpVersion === 2 && (
            <Field
              label="VRRP password"
              htmlFor="vip-pass"
              help={vip?.hasPassword ? "A password is set. Leave empty to keep it." : "Optional, at most 8 characters"}
            >
              <div className="grid gap-2">
                <Input
                  id="vip-pass"
                  value={form.password}
                  maxLength={8}
                  autoComplete="off"
                  disabled={form.removePassword}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                {vip?.hasPassword && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.removePassword}
                      onCheckedChange={(c) => setForm({ ...form, removePassword: c === true })}
                    />
                    Remove the password
                  </label>
                )}
              </div>
            </Field>
          )}

          {cluster.checks.length > 0 && (
            <Field label="Health checks">
              <MultiCheck
                options={cluster.checks.map((c) => ({ value: c.id, label: c.name }))}
                value={form.checkIds}
                onChange={(checkIds) => setForm({ ...form, checkIds })}
              />
            </Field>
          )}

          {touched && issues.length > 0 && (
            <ul className="text-destructive list-disc pl-5 text-sm">
              {issues.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {vip ? "Save" : "Add VIP"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
