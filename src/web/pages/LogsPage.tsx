import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Pause, Play, ScrollText } from "lucide-react";
import type { LogEntry, LogLevel } from "@shared/log-buffer";
import { EmptyState, ToneBadge, type Tone } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { withTimePreferences } from "@/lib/format";

type LogsResponse = { entries: LogEntry[]; lastId: number; scopes: string[]; logLevel: LogLevel };

const POLL_MS = 3_000;
const MAX_ROWS = 1_000;
const ALL = "all";
const LEVEL_TONE: Record<LogLevel, Tone> = { debug: "muted", info: "info", warn: "warning", error: "error" };

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString(
    undefined,
    withTimePreferences({ hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  );

function query(params: { after?: number; level: string; scope: string; q: string }) {
  const search = new URLSearchParams();
  if (params.after) search.set("after", String(params.after));
  if (params.level !== ALL) search.set("level", params.level);
  if (params.scope !== ALL) search.set("scope", params.scope);
  if (params.q.trim()) search.set("q", params.q.trim());
  search.set("limit", String(MAX_ROWS));
  return `/logs?${search}`;
}

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [level, setLevel] = useState(ALL);
  const [scope, setScope] = useState(ALL);
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const lastId = useRef(0);

  // Load from scratch when a filter changes, then poll for newer lines.
  useEffect(() => {
    let stopped = false;
    lastId.current = 0;
    setEntries([]);
    const load = async () => {
      const res = await api.get<LogsResponse>(query({ after: lastId.current, level, scope, q }));
      if (stopped) return;
      lastId.current = res.lastId;
      setScopes(res.scopes);
      if (res.entries.length) setEntries((prev) => [...prev, ...res.entries].slice(-MAX_ROWS));
    };
    const tick = () => (paused ? undefined : load().catch(() => {}));
    void load().catch(() => {});
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [level, scope, q, paused]);

  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);
  const download = () => {
    const blob = new Blob([entries.map((e) => JSON.stringify(e)).join("\n")], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `keepwatch-logs-${new Date().toISOString().slice(0, 19)}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All levels</SelectItem>
            <SelectItem value="info">Info and up</SelectItem>
            <SelectItem value="warn">Warnings and up</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
          </SelectContent>
        </Select>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All areas</SelectItem>
            {scopes.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input className="w-56" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => setPaused(!paused)}>
            {paused ? <Play /> : <Pause />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="outline" onClick={download} disabled={!entries.length}>
            <Download />
            Download
          </Button>
        </div>
      </div>
      {newestFirst.length === 0 ? (
        <EmptyState icon={ScrollText} title="No log lines" />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="divide-y font-mono text-xs">
            {newestFirst.map((e) => (
              <div key={e.id} className="grid gap-1 px-4 py-2 sm:grid-cols-[6rem_4.5rem_8rem_1fr] sm:gap-3">
                <time className="text-muted-foreground">{timeOf(e.time)}</time>
                <span>
                  <ToneBadge tone={LEVEL_TONE[e.level]}>{e.level}</ToneBadge>
                </span>
                <span className="text-muted-foreground truncate">{e.scope}</span>
                <span className="min-w-0 break-words">
                  {e.msg}
                  {Object.keys(e.fields).length > 0 && (
                    <span className="text-muted-foreground"> {JSON.stringify(e.fields)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
