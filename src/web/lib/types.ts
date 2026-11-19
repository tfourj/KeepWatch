import type { ChannelType } from "@shared/channels";
import type { EventType, Severity } from "@shared/events";
import type { CheckParams, KaStatus, VirtualIp, VrrpState } from "@shared/keepalived";
import type { TimePreferences } from "@shared/time";

export type AgentInterface = { name: string; mac: string; cidrs: string[] };

export type Agent = {
  id: string;
  nodeId: string;
  version: string | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  interfaces: AgentInterface[] | null;
  connected: boolean;
  lastSeenAt: string | null;
  enrolledAt: string;
  autoUpdate: boolean;
  updateStatus: string | null;
  latestVersion: string | null;
  lastUpdateError: string | null;
  updateAvailable: boolean;
  keyFingerprint: string;
};

export type ConfigMode = "managed" | "monitor";

export type NodeMember = {
  instanceId: string;
  name: string;
  service: string | null;
  priority: number;
  state: VrrpState | null;
  maintenance: boolean;
  stateSince: string | null;
};

export type KeepNode = {
  id: string;
  name: string;
  description: string | null;
  clusterId: string | null;
  cluster: { id: string; name: string } | null;
  configMode: ConfigMode | null;
  online: boolean;
  lastSeenAt: string | null;
  status: (KaStatus & { reportedAt: number }) | null;
  problems: string[] | null;
  migrateInstances: string[] | null;
  appliedSpecHash: string | null;
  appliedAt: string | null;
  agent: Agent | null;
  interfaces: AgentInterface[];
  members: NodeMember[];
  behind: boolean;
  createdAt: string;
};

export type Enrollment = {
  expiresAt: string;
  serverUrl: string;
  insecure: boolean;
  command: string;
  uninstallCommand: string;
};

export type Member = {
  instanceId: string;
  nodeId: string;
  priority: number;
  interface: string | null;
  initialState: "MASTER" | "BACKUP";
  state: VrrpState | null;
  reportedPriority: number | null;
  stateSince: string | null;
  maintenance: boolean;
  holdsVips: boolean;
  reportedAt: string | null;
};

export type Vip = {
  id: string;
  clusterId: string;
  name: string;
  /** What runs behind the addresses, for example "AdGuard Home". */
  service: string | null;
  vrid: number;
  vrrpVersion: 2 | 3;
  interface: string;
  advertInt: number;
  preempt: boolean;
  preemptDelay: number;
  unicast: boolean;
  hasPassword: boolean;
  virtualIps: VirtualIp[];
  masterNodeId: string | null;
  masterSince: string | null;
  splitBrainSince: string | null;
  splitBrainNotified: boolean;
  noMasterSince: string | null;
  noMasterNotified: boolean;
  members: Member[];
  checkIds: string[];
};

export type Check = {
  id: string;
  clusterId: string;
  name: string;
  key: string;
  params: CheckParams;
  intervalSec: number;
  timeoutSec: number;
  fall: number;
  rise: number;
  weight: number;
};

export type Cluster = {
  id: string;
  name: string;
  description: string | null;
  instances: Vip[];
  checks: Check[];
  nodeIds: string[];
};

export type ImportedInstance = {
  name: string;
  vrid: number;
  vrrpVersion: number;
  interface: string;
  state: string;
  priority: number;
  advertInt: number;
  preempt: boolean;
  preemptDelay: number;
  unicastSrcIp?: string;
  unicastPeers: string[];
  virtualIps: VirtualIp[];
  hasPassword: boolean;
  unsupported: string[];
};

export type Detected = {
  installed: boolean;
  version: string;
  configTest: boolean;
  packageManager: string;
  service: string;
  mode: ConfigMode | "";
  managed: boolean;
  existing: ImportedInstance[];
  conflict: string;
  customScripts: boolean;
};

export type NodePlan = {
  nodeId: string;
  name: string;
  ok: boolean;
  error?: string;
  problems: string[];
  skipped?: string;
  plan?: {
    current: string;
    next: string;
    mainCurrent: string;
    mainNext: string;
    changed: boolean;
    hash: string;
    instances: string[];
    migratedFrom: string[] | null;
  };
};

export type RolloutNodeStatus = "pending" | "applying" | "applied" | "unchanged" | "failed" | "rolled_back" | "skipped";

export type Rollout = {
  id: string;
  clusterId: string;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  nodes: {
    nodeId: string;
    name: string;
    position: number;
    status: RolloutNodeStatus;
    error: string | null;
    output: string[];
  }[];
};

export type Delivery = {
  id: number;
  channelId: string;
  channelName: string;
  channelType: ChannelType;
  status: "pending" | "success" | "failed";
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

export type EventItem = {
  id: number;
  type: EventType;
  severity: Severity;
  nodeId: string | null;
  clusterId: string | null;
  instanceId: string | null;
  nodeName?: string | null;
  clusterName?: string | null;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  deliveries?: Delivery[];
};

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  events: EventType[];
  clusterIds: string[] | null;
  nodeIds: string[] | null;
  titleTemplate: string | null;
  bodyTemplate: string | null;
  config: Record<string, string | number>;
  secretsSet: Record<string, boolean>;
};

export type Overview = {
  clusters: Cluster[];
  nodes: {
    id: string;
    name: string;
    clusterId: string | null;
    online: boolean;
    configMode: ConfigMode | null;
    service: string | null;
    drift: boolean;
    problems: string[];
  }[];
  counts: {
    clusters: number;
    vips: number;
    nodes: number;
    nodesOnline: number;
    agents: number;
    agentsConnected: number;
    splitBrain: number;
    noMaster: number;
    eventsToday: number;
  };
  failovers: { day: number; failovers: number }[];
  recentEvents: EventItem[];
};

export type AppSettings = {
  agentUpdateCheckMinutes: number;
  alertGraceSec: number;
  flapWindowSec: number;
  eventRetentionDays: number;
  historyRetentionDays: number;
  time: TimePreferences;
  templates: Record<string, { title: string; body: string }>;
};

export type LatestRelease = { version: string; url: string; checkedAt: number } | null;

export type SystemInfo = {
  version: string;
  /** Short commit for builds that are not a stable release. */
  commit: string | null;
  baseUrl: string;
  agentRepo: string;
  timezone: string;
  latestAgent: LatestRelease;
  latestAgentError: string | null;
  agentReleaseCheckedAt: number | null;
};

export type CommandState = {
  status: "running" | "done" | "failed";
  lines: string[];
  result?: Record<string, unknown>;
  error?: string | null;
};

export type SecurityStatus = { twoFactorEnabled: boolean; loginChannelIds: string[] };

export type SignedInDevice = {
  id: string;
  name: string;
  userAgent: string | null;
  ip: string | null;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
};

export type LoginTestResult = { results: { id: string; name: string; ok: boolean; error: string | null }[] };
