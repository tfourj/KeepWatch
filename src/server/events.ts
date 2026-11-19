import { db } from "./db/client";
import { events } from "./db/schema";
import { createLogger } from "./logger";
import { DEFAULT_EVENT_SEVERITY, type EventType, type Severity } from "../shared/events";

const log = createLogger("events");

/** Values for template variables. Keys match TEMPLATE_VARIABLES; extra keys are kept for the event log. */
export type EventData = {
  cluster?: string | null;
  vip?: string | null;
  address?: string | null;
  node?: string | null;
  from?: string | null;
  to?: string | null;
  state?: string | null;
  priority?: number | null;
  check?: string | null;
  reason?: string | null;
  version?: string | null;
  error?: string | null;
  [key: string]: unknown;
};

export type EmitInput = {
  type: EventType;
  title: string;
  message: string;
  nodeId?: string | null;
  clusterId?: string | null;
  instanceId?: string | null;
  severity?: Severity;
  data?: EventData;
};

export type EventRow = typeof events.$inferSelect;

type Listener = (event: EventRow) => void | Promise<void>;
const listeners: Listener[] = [];

export function onEvent(listener: Listener) {
  listeners.push(listener);
}

/** Record an event and hand it to listeners (the notification dispatcher). */
export function emitEvent(input: EmitInput): EventRow {
  const row = db
    .insert(events)
    .values({
      type: input.type,
      severity: input.severity ?? DEFAULT_EVENT_SEVERITY[input.type],
      nodeId: input.nodeId ?? null,
      clusterId: input.clusterId ?? null,
      instanceId: input.instanceId ?? null,
      title: input.title,
      message: input.message,
      data: input.data ?? {},
    })
    .returning()
    .get();
  log.info(input.message, { event: input.type, nodeId: input.nodeId, clusterId: input.clusterId });
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(row))
      .catch((error) => log.error("event listener failed", { error }));
  }
  return row;
}
