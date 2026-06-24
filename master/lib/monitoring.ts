import { ensureSchema, getPool, OFFLINE_AFTER_MS, pruneHistory, writeAudit } from "./db";
import { pruneAuthAttempts } from "./auth";
import { notify } from "./notify";
import { isPrivate } from "./net";
import type {
  AlertMetric,
  AlertRule,
  OfflineSetting,
  PingResult,
  PingTask,
  PingType,
} from "./types";

// Map a rule's metric to the metrics_history column it evaluates against.
const METRIC_COLUMN: Record<AlertMetric, string> = {
  cpu: "cpu",
  ram: "mem_pct",
  disk: "disk_pct",
};

const VALID_METRICS: readonly AlertMetric[] = ["cpu", "ram", "disk"];

// Reject targets that resolve to private / loopback / link-local space so a
// compromised admin can't weaponise the node fleet as an internal port scanner.
// Self-hosted deployments that legitimately probe LAN services can opt out via
// WOLF_ALLOW_INTERNAL_PROBE_TARGETS=1.
function validatePingTarget(raw: string, type: PingType): string {
  const t = (raw ?? "").trim();
  if (!t) throw new Error("target required");
  if (t.length > 253) throw new Error("target too long");
  let host = t;
  if (type === "tcp") {
    // Accept host:port, [v6]:port, or bare host (probe defaults to :80 node-side).
    const v6 = t.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      host = v6[1];
      if (v6[2] && (Number(v6[2]) < 1 || Number(v6[2]) > 65535))
        throw new Error("invalid port");
    } else {
      const idx = t.lastIndexOf(":");
      if (idx > 0 && /^\d+$/.test(t.slice(idx + 1))) {
        const port = Number(t.slice(idx + 1));
        if (port < 1 || port > 65535) throw new Error("invalid port");
        host = t.slice(0, idx);
      }
    }
  }
  if (!/^[a-zA-Z0-9._:\-]+$/.test(host)) throw new Error("invalid host");
  if (process.env.WOLF_ALLOW_INTERNAL_PROBE_TARGETS === "1") return t;
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "0.0.0.0" ||
    lower === "::" ||
    lower === "::0" ||
    isPrivate(host)
  ) {
    throw new Error("internal/private targets are not allowed");
  }
  return t;
}

// Re-notify an already-firing alert / still-offline node at most this often,
// so a sustained problem reminds without spamming every cron tick.
const RENOTIFY_MS = 30 * 60 * 1000;

function rid(prefix: string): string {
  // Deterministic-enough unique id without Math.random/Date (unavailable in
  // workflow scripts but fine here; still avoid for consistency): use a counter
  // seeded by hrtime-ish process value.
  return `${prefix}_${process.hrtime.bigint().toString(36)}`;
}

// ── Alert rules CRUD ────────────────────────────────────────────────────────

export async function listAlertRules(): Promise<AlertRule[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, name, metric, threshold, ratio, window_minutes, targets, exclude, enabled
       FROM alert_rules ORDER BY name`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    metric: r.metric as AlertMetric,
    threshold: r.threshold,
    ratio: r.ratio,
    windowMinutes: r.window_minutes,
    targets: r.targets ?? [],
    exclude: r.exclude ?? false,
    enabled: r.enabled,
  }));
}

export async function upsertAlertRule(
  rule: Partial<AlertRule>
): Promise<AlertRule> {
  await ensureSchema();
  const id = rule.id || rid("alert");
  const metric: AlertMetric = VALID_METRICS.includes(rule.metric as AlertMetric)
    ? (rule.metric as AlertMetric)
    : "cpu";
  const row: AlertRule = {
    id,
    name: rule.name?.trim() || "rule",
    metric,
    threshold: clamp(rule.threshold ?? 80, 0, 100),
    ratio: clamp(rule.ratio ?? 0.8, 0, 1),
    windowMinutes: Math.max(1, Math.round(rule.windowMinutes ?? 15)),
    targets: rule.targets ?? [],
    exclude: rule.exclude ?? false,
    enabled: rule.enabled ?? true,
  };
  await getPool().query(
    `INSERT INTO alert_rules (id, name, metric, threshold, ratio, window_minutes, targets, exclude, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, metric=EXCLUDED.metric, threshold=EXCLUDED.threshold,
       ratio=EXCLUDED.ratio, window_minutes=EXCLUDED.window_minutes,
       targets=EXCLUDED.targets, exclude=EXCLUDED.exclude, enabled=EXCLUDED.enabled`,
    [
      row.id,
      row.name,
      row.metric,
      row.threshold,
      row.ratio,
      row.windowMinutes,
      JSON.stringify(row.targets),
      row.exclude,
      row.enabled,
    ]
  );
  await writeAudit("alert_rule.upsert", {
    target: row.id,
    details: { name: row.name, metric: row.metric, threshold: row.threshold },
  }).catch(() => {});
  return row;
}

export async function deleteAlertRule(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM alert_rules WHERE id=$1`, [id]);
  await getPool().query(`DELETE FROM alert_state WHERE rule_id=$1`, [id]);
  await writeAudit("alert_rule.delete", { target: id }).catch(() => {});
}

// ── Offline settings CRUD ───────────────────────────────────────────────────

export async function listOfflineSettings(): Promise<OfflineSetting[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT node_id, enabled, grace_seconds, last_notified, offline
       FROM offline_settings ORDER BY node_id`
  );
  return rows.map((r) => ({
    nodeId: r.node_id,
    enabled: r.enabled,
    graceSeconds: r.grace_seconds,
    lastNotified: r.last_notified ? Number(r.last_notified) : null,
    offline: r.offline,
  }));
}

export async function upsertOfflineSetting(
  nodeId: string,
  enabled: boolean,
  graceSeconds: number
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO offline_settings (node_id, enabled, grace_seconds)
     VALUES ($1,$2,$3)
     ON CONFLICT (node_id) DO UPDATE SET
       enabled=EXCLUDED.enabled, grace_seconds=EXCLUDED.grace_seconds`,
    [nodeId, enabled, Math.max(0, Math.round(graceSeconds))]
  );
  await writeAudit("offline.upsert", {
    target: nodeId,
    details: { enabled, graceSeconds },
  }).catch(() => {});
}

// ── Ping tasks CRUD ─────────────────────────────────────────────────────────

export async function listPingTasks(): Promise<PingTask[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, name, target, type, interval_seconds, node_ids, exclude, enabled
       FROM ping_tasks ORDER BY name`
  );
  return rows.map(mapTask);
}

// Tasks a specific node should run. Allowlist mode (exclude=false): node_ids
// empty OR contains this node. Blacklist mode (exclude=true): node_ids does NOT
// contain this node.
export async function pingTasksForNode(nodeId: string): Promise<PingTask[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, name, target, type, interval_seconds, node_ids, exclude, enabled
       FROM ping_tasks
      WHERE enabled = TRUE
        AND (
          (exclude = FALSE AND (node_ids = '[]'::jsonb OR node_ids ? $1))
          OR
          (exclude = TRUE AND NOT (node_ids ? $1))
        )`,
    [nodeId]
  );
  return rows.map(mapTask);
}

function mapTask(r: any): PingTask {
  return {
    id: r.id,
    name: r.name,
    target: r.target,
    type: r.type as PingType,
    intervalSeconds: r.interval_seconds,
    nodeIds: r.node_ids ?? [],
    exclude: r.exclude ?? false,
    enabled: r.enabled,
  };
}

export async function upsertPingTask(
  task: Partial<PingTask>
): Promise<PingTask> {
  await ensureSchema();
  const id = task.id || rid("ping");
  const type: PingType = (task.type as PingType) === "icmp" ? "icmp" : "tcp";
  const target = validatePingTarget(task.target ?? "", type);
  const row: PingTask = {
    id,
    name: task.name?.trim() || "monitor",
    target,
    type,
    intervalSeconds: Math.max(5, Math.round(task.intervalSeconds ?? 60)),
    nodeIds: task.nodeIds ?? [],
    exclude: task.exclude ?? false,
    enabled: task.enabled ?? true,
  };
  await getPool().query(
    `INSERT INTO ping_tasks (id, name, target, type, interval_seconds, node_ids, exclude, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, target=EXCLUDED.target, type=EXCLUDED.type,
       interval_seconds=EXCLUDED.interval_seconds, node_ids=EXCLUDED.node_ids,
       exclude=EXCLUDED.exclude, enabled=EXCLUDED.enabled`,
    [
      row.id,
      row.name,
      row.target,
      row.type,
      row.intervalSeconds,
      JSON.stringify(row.nodeIds),
      row.exclude,
      row.enabled,
    ]
  );
  await writeAudit("ping_task.upsert", {
    target: row.id,
    details: { name: row.name, target: row.target },
  }).catch(() => {});
  return row;
}

export async function deletePingTask(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM ping_tasks WHERE id=$1`, [id]);
  await getPool().query(`DELETE FROM ping_results WHERE task_id=$1`, [id]);
  await writeAudit("ping_task.delete", { target: id }).catch(() => {});
}

// Cap rows per batch well under pg's 65535-parameter wire limit and keep
// memory bounded. Callers should pre-filter further; we re-cap defensively
// here so a single misbehaving node can't blow up the DB or this process.
const PING_BATCH_MAX = 500;
const PING_ID_MAX = 128;

export async function savePingResults(results: PingResult[]): Promise<void> {
  if (results.length === 0) return;
  await ensureSchema();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const clean = results.filter(
    (r) =>
      r &&
      typeof r.taskId === "string" &&
      r.taskId.length > 0 && r.taskId.length <= PING_ID_MAX &&
      typeof r.nodeId === "string" &&
      r.nodeId.length > 0 && r.nodeId.length <= PING_ID_MAX &&
      typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) &&
      typeof r.ts === "number" && r.ts > now - DAY && r.ts < now + 5 * 60 * 1000,
  );
  if (clean.length === 0) return;
  const pool = getPool();
  for (let off = 0; off < clean.length; off += PING_BATCH_MAX) {
    const slice = clean.slice(off, off + PING_BATCH_MAX);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((r, i) => {
      const b = i * 5;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
      params.push(r.taskId, r.nodeId, r.ts, r.latencyMs, r.success);
    });
    await pool.query(
      `INSERT INTO ping_results (task_id, node_id, ts, latency_ms, success)
       VALUES ${values.join(",")}`,
      params,
    );
  }
}

// Latency history for ONE node, grouped by task. Each task gets the newest
// `limitPerTask` points within the window, returned in chronological order.
// Using ROW_NUMBER PARTITION keeps one busy task from starving the others
// under a global LIMIT.
//
// Important: filtered to the tasks this node is CURRENTLY assigned to (per
// pingTasksForNode — respects enabled + allowlist/blacklist mode). Tasks the
// node used to run before its assignment changed leave orphan rows in
// ping_results; without this filter those would resurface on the detail page.
export async function latencyHistoryForNode(
  nodeId: string,
  sinceMs: number | undefined,
  limitPerTask: number,
): Promise<Record<string, { ts: number; latencyMs: number; success: boolean }[]>> {
  await ensureSchema();
  const activeTasks = await pingTasksForNode(nodeId);
  if (activeTasks.length === 0) return {};
  const taskIds = activeTasks.map((t) => t.id);

  const params: (string | number | string[])[] = [nodeId, taskIds, limitPerTask];
  let timeFilter = "";
  if (sinceMs && sinceMs > 0) {
    params.push(sinceMs);
    timeFilter = ` AND ts >= $${params.length}`;
  }
  const { rows } = await getPool().query<{
    task_id: string;
    ts: string;
    latency_ms: number;
    success: boolean;
  }>(
    `WITH ranked AS (
       SELECT task_id, ts, latency_ms, success,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY ts DESC) AS rn
         FROM ping_results
        WHERE node_id = $1
          AND task_id = ANY($2::text[])
          ${timeFilter}
     )
     SELECT task_id, ts, latency_ms, success
       FROM ranked
      WHERE rn <= $3
      ORDER BY task_id, ts ASC`,
    params,
  );
  const out: Record<string, { ts: number; latencyMs: number; success: boolean }[]> = {};
  for (const r of rows) {
    const key = r.task_id;
    (out[key] ??= []).push({
      ts: Number(r.ts),
      latencyMs: r.latency_ms,
      success: r.success,
    });
  }
  return out;
}

// Latest latency per (task, node) for the dashboard / /latency view.
//
// Filtered to (task, node) pairs that match the task's CURRENT assignment
// (enabled + allowlist/blacklist), so rows recorded before a task's targets
// changed don't keep showing up. Also joins `nodes` to drop results for
// servers that have been deleted (defense in depth — delete cascade should
// have removed them, but this is cheap and guards against drift).
export async function latestPingResults(): Promise<PingResult[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (pr.task_id, pr.node_id)
        pr.task_id, pr.node_id, pr.ts, pr.latency_ms, pr.success
       FROM ping_results pr
       JOIN ping_tasks pt ON pt.id = pr.task_id
       JOIN nodes n ON n.id = pr.node_id
      WHERE pt.enabled = TRUE
        AND (
          (pt.exclude = FALSE AND (pt.node_ids = '[]'::jsonb OR pt.node_ids ? pr.node_id))
          OR
          (pt.exclude = TRUE AND NOT (pt.node_ids ? pr.node_id))
        )
      ORDER BY pr.task_id, pr.node_id, pr.ts DESC`
  );
  return rows.map((r) => ({
    taskId: r.task_id,
    nodeId: r.node_id,
    ts: Number(r.ts),
    latencyMs: r.latency_ms,
    success: r.success,
  }));
}

// ── Evaluation engine (run by cron / server loop) ───────────────────────────

export interface EvalSummary {
  alertsFired: number;
  recoveries: number;
  offline: number;
  online: number;
}

// Minimum spacing between report-triggered evaluations. Node ingestion is
// frequent (seconds); this throttles the actual alert evaluation to ~once a
// minute regardless of how many reports arrive.
const EVAL_MIN_INTERVAL_MS = 45_000;

const PRUNE_MIN_INTERVAL_MS = 60 * 60 * 1000; // hourly retention cleanup

// claimSlot atomically reserves a time-spaced slot: it returns true to at most
// one concurrent caller per `intervalMs`. Used to throttle report-driven work.
async function claimSlot(key: string, intervalMs: number): Promise<boolean> {
  const now = Date.now();
  const { rows } = await getPool().query(
    `INSERT INTO app_settings (key, value)
       VALUES ($1, to_jsonb($2::bigint))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
       WHERE (app_settings.value #>> '{}')::bigint < $3
     RETURNING key`,
    [key, now, now - intervalMs]
  );
  return rows.length > 0;
}

// Process-local short-circuit so a fleet of frequent reports doesn't hammer
// pg with INSERT...ON CONFLICT on every tick. The DB claimSlot remains the
// cross-instance authority; this just collapses redundant attempts within a
// single instance. globalThis survives HMR / warm serverless invocations.
type SlotCache = { [key: string]: number };
const __slotCache: SlotCache = ((globalThis as unknown as { __wolfSlotCache?: SlotCache })
  .__wolfSlotCache ??= {});

async function tryClaimSlot(key: string, intervalMs: number): Promise<boolean> {
  const now = Date.now();
  const last = __slotCache[key] ?? 0;
  if (now - last < intervalMs * 0.9) return false;
  const won = await claimSlot(key, intervalMs);
  __slotCache[key] = won ? now : now - intervalMs * 0.5;
  return won;
}

// maybeEvaluate is the self-contained scheduler: node reports call it, and it
// runs evaluate() at most once per EVAL_MIN_INTERVAL_MS (plus hourly retention
// cleanup), claiming each slot atomically so concurrent reports don't double-run.
// This is why alerts need no external cron — as long as any node reports,
// evaluation keeps ticking. Returns true if this call performed the evaluation.
export async function maybeEvaluate(): Promise<boolean> {
  await ensureSchema();
  if (await tryClaimSlot("lastPruneAt", PRUNE_MIN_INTERVAL_MS)) {
    await pruneHistory();
    await pruneAuthAttempts();
  }
  if (!(await tryClaimSlot("lastEvalAt", EVAL_MIN_INTERVAL_MS))) return false;
  await evaluate();
  return true;
}

// evaluate checks every alert rule and offline setting against current data and
// dispatches notifications on state transitions. Idempotent per tick.
export async function evaluate(): Promise<EvalSummary> {
  await ensureSchema();
  const summary: EvalSummary = {
    alertsFired: 0,
    recoveries: 0,
    offline: 0,
    online: 0,
  };
  const pool = getPool();
  const now = Date.now();

  // Current node list (id + last_seen) for both checks.
  const { rows: nodeRows } = await pool.query<{
    id: string;
    last_seen: string;
  }>(`SELECT id, last_seen FROM nodes`);
  const nodes = nodeRows.map((r) => ({
    id: r.id,
    lastSeen: Number(r.last_seen),
  }));

  await evaluateLoadAlerts(nodes, now, summary);
  await evaluateOffline(nodes, now, summary);
  return summary;
}

async function evaluateLoadAlerts(
  nodes: { id: string; lastSeen: number }[],
  now: number,
  summary: EvalSummary
) {
  const pool = getPool();
  const rules = await listAlertRules();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    // SQL-boundary guard: never interpolate an unknown column even if validation
    // upstream regresses (defense in depth against latent CWE-89).
    const col = METRIC_COLUMN[rule.metric];
    if (!col) {
      console.warn(`alert rule ${rule.id} has invalid metric ${rule.metric}; skipping`);
      continue;
    }
    // Allowlist (exclude=false): match nodes in `targets`, or all if empty.
    // Blacklist (exclude=true): match every node EXCEPT those in `targets`.
    const targetSet = new Set(rule.targets);
    const targets = rule.exclude
      ? nodes.filter((n) => !targetSet.has(n.id))
      : rule.targets.length > 0
        ? nodes.filter((n) => targetSet.has(n.id))
        : nodes;
    if (targets.length === 0) continue;
    const since = now - rule.windowMinutes * 60 * 1000;
    const ids = targets.map((t) => t.id);

    try {
      // One aggregate round-trip per rule (was per rule × node).
      const { rows: aggRows } = await pool.query<{
        node_id: string;
        total: string;
        over: string;
      }>(
        `SELECT node_id,
                COUNT(*)                              AS total,
                COUNT(*) FILTER (WHERE ${col} >= $3)  AS over
           FROM metrics_history
          WHERE node_id = ANY($1::text[]) AND ts >= $2
          GROUP BY node_id`,
        [ids, since, rule.threshold],
      );
      const aggByNode = new Map(aggRows.map((r) => [r.node_id, r]));

      // One round-trip for all states this rule cares about.
      const { rows: stateRows } = await pool.query<{
        node_id: string;
        firing: boolean;
        last_notified: string | null;
      }>(
        `SELECT node_id, firing, last_notified
           FROM alert_state
          WHERE rule_id = $1 AND node_id = ANY($2::text[])`,
        [rule.id, ids],
      );
      const stateByNode = new Map(stateRows.map((s) => [s.node_id, s]));

      const upserts: { nodeId: string; firing: boolean; lastNotified: number | null }[] = [];
      for (const node of targets) {
        const agg = aggByNode.get(node.id);
        const total = agg ? Number(agg.total) : 0;
        const over = agg ? Number(agg.over) : 0;
        const fraction = total > 0 ? over / total : 0;
        const shouldFire = total >= 2 && fraction >= rule.ratio;
        const prev = stateByNode.get(node.id);
        const wasFiring = prev?.firing ?? false;
        const lastNotified = prev?.last_notified ? Number(prev.last_notified) : null;

        if (shouldFire) {
          const due = !wasFiring || !lastNotified || now - lastNotified >= RENOTIFY_MS;
          if (due) {
            await notify(
              "alert",
              rule.name,
              node.id,
              `${rule.metric.toUpperCase()} ≥ ${rule.threshold}% for ${(fraction * 100).toFixed(0)}% of the last ${rule.windowMinutes}m (threshold ${(rule.ratio * 100).toFixed(0)}%).`,
            );
            summary.alertsFired++;
          }
          upserts.push({ nodeId: node.id, firing: true, lastNotified: due ? now : lastNotified });
        } else if (wasFiring) {
          await notify("recovery", rule.name, node.id, `${rule.metric.toUpperCase()} back to normal.`);
          summary.recoveries++;
          upserts.push({ nodeId: node.id, firing: false, lastNotified: now });
        }
      }

      // Batched state persistence: one round-trip for this rule's edges.
      if (upserts.length > 0) {
        const values: string[] = [];
        const params: (string | number | boolean | null)[] = [rule.id];
        upserts.forEach((u, i) => {
          const base = i * 3 + 2;
          values.push(`($1,$${base},$${base + 1},$${base + 2})`);
          params.push(u.nodeId, u.firing, u.lastNotified);
        });
        await pool.query(
          `INSERT INTO alert_state (rule_id, node_id, firing, last_notified)
           VALUES ${values.join(",")}
           ON CONFLICT (rule_id, node_id) DO UPDATE SET
             firing=EXCLUDED.firing, last_notified=EXCLUDED.last_notified`,
          params,
        );
      }
    } catch (e) {
      // One bad rule shouldn't blind the rest of the tick.
      console.error(`rule ${rule.id} eval failed`, e);
    }
  }
}

async function evaluateOffline(
  nodes: { id: string; lastSeen: number }[],
  now: number,
  summary: EvalSummary
) {
  const settings = await listOfflineSettings();
  const byId = new Map(settings.map((s) => [s.nodeId, s]));

  for (const node of nodes) {
    const s = byId.get(node.id);
    if (!s || !s.enabled) continue;
    const isOffline = now - node.lastSeen > s.graceSeconds * 1000;

    if (isOffline && !s.offline) {
      await notify(
        "offline",
        "Offline",
        node.id,
        `No report for ${Math.round((now - node.lastSeen) / 1000)}s (grace ${s.graceSeconds}s).`
      );
      summary.offline++;
      await setOfflineState(node.id, true, now);
    } else if (!isOffline && s.offline) {
      await notify("online", "Online", node.id, `Reporting again.`);
      summary.online++;
      await setOfflineState(node.id, false, now);
    }
  }
}

async function setOfflineState(nodeId: string, offline: boolean, ts: number) {
  await getPool().query(
    `UPDATE offline_settings SET offline=$2, last_notified=$3 WHERE node_id=$1`,
    [nodeId, offline, ts]
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export { OFFLINE_AFTER_MS };
