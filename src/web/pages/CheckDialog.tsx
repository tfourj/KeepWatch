import { useState } from "react";
import { CHECK_PRESETS } from "@shared/check-presets";
import { checkInputSchema } from "@shared/clusters";
import { CHECK_TYPE_LABELS, CHECK_TYPES, SCRIPT_DIR, type CheckParams, type CheckType } from "@shared/keepalived";
import { Field, SwitchRow } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAction } from "@/lib/mutations";
import { useOnOpen } from "@/lib/use-on-open";
import type { Check, Cluster } from "@/lib/types";

type Form = {
  name: string;
  key: string;
  type: CheckType;
  host: string;
  port: number;
  url: string;
  expectStatus: number;
  insecureTls: boolean;
  process: string;
  path: string;
  intervalSec: number;
  timeoutSec: number;
  fall: number;
  rise: number;
  weight: number;
};

const keyFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

function toForm(check?: Check): Form {
  const p = check?.params;
  return {
    name: check?.name ?? "",
    key: check?.key ?? "",
    type: p?.type ?? "tcp",
    host: p && "host" in p ? p.host : "127.0.0.1",
    port: p?.type === "tcp" ? p.port : 80,
    url: p?.type === "http" ? p.url : "http://127.0.0.1/",
    expectStatus: p?.type === "http" ? p.expectStatus : 200,
    insecureTls: p?.type === "http" ? p.insecureTls : false,
    process: p?.type === "process" ? p.process : "",
    path: p?.type === "script" ? p.path : SCRIPT_DIR,
    intervalSec: check?.intervalSec ?? 2,
    timeoutSec: check?.timeoutSec ?? 2,
    fall: check?.fall ?? 2,
    rise: check?.rise ?? 2,
    weight: check?.weight ?? 0,
  };
}

const DEFAULT_TIMING = { intervalSec: 2, timeoutSec: 2, fall: 2, rise: 2 };

function params(f: Form): CheckParams {
  switch (f.type) {
    case "tcp":
      return { type: "tcp", host: f.host.trim(), port: f.port };
    case "http":
      return { type: "http", url: f.url.trim(), expectStatus: f.expectStatus, insecureTls: f.insecureTls };
    case "ping":
      return { type: "ping", host: f.host.trim() };
    case "process":
      return { type: "process", process: f.process.trim() };
    case "script":
      return { type: "script", path: f.path.trim() };
  }
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const id = `check-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

export function CheckDialog({
  open,
  onOpenChange,
  cluster,
  check,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cluster: Cluster;
  check?: Check;
}) {
  const [form, setForm] = useState<Form>(toForm(check));
  const [keyEdited, setKeyEdited] = useState(!!check);
  useOnOpen(open, () => {
    setForm(toForm(check));
    setKeyEdited(!!check);
  });
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const body = {
    name: form.name.trim(),
    key: form.key,
    params: params(form),
    intervalSec: form.intervalSec,
    timeoutSec: form.timeoutSec,
    fall: form.fall,
    rise: form.rise,
    weight: form.weight,
  };
  const parsed = checkInputSchema.safeParse(body);
  const save = useAction(
    () =>
      check
        ? api.put(`/clusters/${cluster.id}/checks/${check.id}`, body)
        : api.post(`/clusters/${cluster.id}/checks`, body),
    { invalidate: [["clusters"], ["nodes"]], success: check ? "Check saved" : "Check added" },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{check ? `Edit ${check.name}` : "Add health check"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!parsed.success) return;
            await save.mutateAsync(undefined);
            onOpenChange(false);
          }}
        >
          {!check && (
            <Field label="Start from">
              <Select
                value=""
                onValueChange={(id) => {
                  const p = CHECK_PRESETS.find((x) => x.id === id);
                  if (!p) return;
                  setKeyEdited(true);
                  setForm({ ...toForm({ ...p, id: "", clusterId: "", ...DEFAULT_TIMING }), name: p.name });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="A common service" />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.service}: {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="check-name">
              <Input
                id="check-name"
                value={form.name}
                onChange={(e) => set({ name: e.target.value, ...(keyEdited ? {} : { key: keyFrom(e.target.value) }) })}
              />
            </Field>
            <Field label="Id in the config" htmlFor="check-key">
              <Input
                id="check-key"
                className="font-mono"
                value={form.key}
                onChange={(e) => {
                  setKeyEdited(true);
                  set({ key: e.target.value });
                }}
              />
            </Field>
          </div>
          <Field label="Type">
            <Select value={form.type} onValueChange={(type) => set({ type: type as CheckType })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHECK_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {CHECK_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {(form.type === "tcp" || form.type === "ping") && (
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="Host" htmlFor="check-host">
                <Input id="check-host" value={form.host} onChange={(e) => set({ host: e.target.value })} />
              </Field>
              {form.type === "tcp" && (
                <NumberInput label="Port" value={form.port} min={1} max={65535} onChange={(port) => set({ port })} />
              )}
            </div>
          )}
          {form.type === "http" && (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                <Field label="URL" htmlFor="check-url">
                  <Input id="check-url" value={form.url} onChange={(e) => set({ url: e.target.value })} />
                </Field>
                <NumberInput
                  label="Status"
                  value={form.expectStatus}
                  min={100}
                  max={599}
                  onChange={(expectStatus) => set({ expectStatus })}
                />
              </div>
              <SwitchRow label="Skip certificate check" help="For self-signed certificates on the node itself">
                <Switch checked={form.insecureTls} onCheckedChange={(insecureTls) => set({ insecureTls })} />
              </SwitchRow>
            </>
          )}
          {form.type === "process" && (
            <Field label="Process name" htmlFor="check-process" help="As shown by ps, for example nginx or haproxy">
              <Input id="check-process" value={form.process} onChange={(e) => set({ process: e.target.value })} />
            </Field>
          )}
          {form.type === "script" && (
            <Field
              label="Script"
              htmlFor="check-path"
              help="Root owned and not writable by others. Only runs on nodes installed with --allow-custom-scripts."
            >
              <Input
                id="check-path"
                className="font-mono"
                value={form.path}
                onChange={(e) => set({ path: e.target.value })}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <NumberInput
              label="Every (s)"
              value={form.intervalSec}
              min={1}
              max={3600}
              onChange={(intervalSec) => set({ intervalSec })}
            />
            <NumberInput
              label="Timeout (s)"
              value={form.timeoutSec}
              min={1}
              max={60}
              onChange={(timeoutSec) => set({ timeoutSec })}
            />
            <NumberInput label="Fail after" value={form.fall} min={1} max={10} onChange={(fall) => set({ fall })} />
            <NumberInput label="Pass after" value={form.rise} min={1} max={10} onChange={(rise) => set({ rise })} />
          </div>
          <Field
            label="Priority change while failing"
            htmlFor="check-weight"
            help="0 puts the VIP in FAULT on this node. A negative value lowers its priority so a backup takes over."
          >
            <Input
              id="check-weight"
              type="number"
              min={-254}
              max={254}
              value={form.weight}
              onChange={(e) => set({ weight: Number(e.target.value) })}
            />
          </Field>
          {!parsed.success && form.name && (
            <ul className="text-destructive list-disc pl-5 text-sm">
              {parsed.error.issues.map((i) => (
                <li key={i.path.join(".") + i.message}>{i.message}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!parsed.success || save.isPending}>
              {check ? "Save" : "Add check"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
