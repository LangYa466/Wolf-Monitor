// Wire contract with the Go node. Field names MUST match the JSON tags in
// node/collector/types.go.

export interface HostInfo {
  hostname: string;
  os: string;
  platform: string;
  platformVersion: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  memTotal: number;
  swapTotal: number;
  diskTotal: number;
  bootTime: number;
}

export interface Metrics {
  uptime: number;
  cpuUsage: number;
  memUsed: number;
  memPercent: number;
  swapUsed: number;
  diskUsed: number;
  diskPercent: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  diskReadSpeed: number;
  diskWriteSpeed: number;
  netSent: number;
  netRecv: number;
  netUpSpeed: number;
  netDownSpeed: number;
  load1: number;
  load5: number;
  load15: number;
  tcpConns: number;
  procs: number;
}

export interface Report {
  token: string;
  host: HostInfo;
  metrics: Metrics;
  clientTs: number;
}

// ── Monitoring: load alerts / offline / latency ────────────────────────────

export type AlertMetric = "cpu" | "ram" | "disk";

// A load-notification rule: fire when `metric` stays >= `threshold` for at
// least `ratio` of the samples in the trailing `windowMinutes` window.
export interface AlertRule {
  id: string;
  name: string;
  metric: AlertMetric;
  threshold: number; // percent, e.g. 80
  ratio: number; // 0..1, e.g. 0.8
  windowMinutes: number; // e.g. 15
  targets: string[]; // node ids; empty = all nodes
  // When true, `targets` is a blacklist (rule applies to all nodes EXCEPT
  // those listed); when false (default), it's an allowlist.
  exclude: boolean;
  enabled: boolean;
}

// Per-server offline notification config + live episode state.
export interface OfflineSetting {
  nodeId: string;
  enabled: boolean;
  graceSeconds: number; // e.g. 180
  lastNotified: number | null; // unix millis
  offline: boolean; // current episode state
}

export type PingType = "tcp" | "icmp";

// A latency-monitoring task: the listed nodes probe `target` every
// `intervalSeconds` and report round-trip latency.
export interface PingTask {
  id: string;
  name: string;
  target: string; // host / ip[:port]
  type: PingType;
  intervalSeconds: number;
  // Node selection. When `exclude` is false, `nodeIds` is an allowlist (empty =
  // all nodes). When `exclude` is true, `nodeIds` is a blacklist — every node
  // probes the target EXCEPT those listed.
  nodeIds: string[];
  exclude: boolean;
  enabled: boolean;
}

// One latency sample reported by a node for a task.
export interface PingResult {
  taskId: string;
  nodeId: string;
  ts: number; // unix millis
  latencyMs: number; // -1 when unreachable
  success: boolean;
}

// Notification configuration (stored in app_settings under key "notify").
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  messageThreadId: string; // optional, for supergroup topics
  endpoint: string; // e.g. https://api.telegram.org/bot
}

export interface NotifyConfig {
  enabled: boolean;
  // Template with {{emoji}} {{event}} {{client}} {{message}} {{time}}.
  template: string;
  telegram: TelegramConfig;
  webhookUrl: string;
}

// What the dashboard consumes: static host info + the latest sample + liveness.
// Note: the auto-increment `seq` is never exposed here — only its encrypted
// `opaqueId` (used in URLs). `name` is an optional admin-set display name.
export interface NodeView {
  id: string; // hostname (internal identity, used for history/admin ops)
  opaqueId: string; // format-preserving-encrypted seq — the URL id
  name: string | null; // admin display name (falls back to hostname)
  host: HostInfo;
  metrics: Metrics;
  lastSeen: number; // unix millis (server time)
  online: boolean;
  ip: string | null;
  country: string | null; // ISO 3166-1 alpha-2 (lowercase), for flagcdn
  sortOrder: number;
}
