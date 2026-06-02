import { ensureSchema, getPool, OFFLINE_AFTER_MS, pruneHistory } from "./db";
import { pruneAuthAttempts } from "./auth";
import { notify } from "./notify";
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
  const row: AlertRule = {
    id,
    name: rule.name?.trim() || "rule",
    metric: (rule.metric as AlertMetric) || "cpu",
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
  return row;
}

export async function deleteAlertRule(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM alert_rules WHERE id=$1`, [id]);
  await getPool().query(`DELETE FROM alert_state WHERE rule_id=$1`, [id]);
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
  const row: PingTask = {
    id,
    name: task.name?.trim() || "monitor",
    target: task.target?.trim() || "",
    type: (task.type as PingType) === "icmp" ? "icmp" : "tcp",
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
  return row;
}

export async function deletePingTask(id: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM ping_tasks WHERE id=$1`, [id]);
  await getPool().query(`DELETE FROM ping_results WHERE task_id=$1`, [id]);
}

export async function savePingResults(results: PingResult[]): Promise<void> {
  if (results.length === 0) return;
  await ensureSchema();
  const pool = getPool();
  const values: string[] = [];
  const params: unknown[] = [];
  results.forEach((r, i) => {
    const b = i * 5;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
    params.push(r.taskId, r.nodeId, r.ts, r.latencyMs, r.success);
  });
  await pool.query(
    `INSERT INTO ping_results (task_id, node_id, ts, latency_ms, success)
     VALUES ${values.join(",")}`,
    params
  );
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

// Latest latency per (task, node) for the dashboard.
export async function latestPingResults(): Promise<PingResult[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (task_id, node_id)
        task_id, node_id, ts, latency_ms, success
       FROM ping_results
      ORDER BY task_id, node_id, ts DESC`
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

// maybeEvaluate is the self-contained scheduler: node reports call it, and it
// runs evaluate() at most once per EVAL_MIN_INTERVAL_MS (plus hourly retention
// cleanup), claiming each slot atomically so concurrent reports don't double-run.
// This is why alerts need no external cron — as long as any node reports,
// evaluation keeps ticking. Returns true if this call performed the evaluation.
export async function maybeEvaluate(): Promise<boolean> {
  await ensureSchema();
  if (await claimSlot("lastPruneAt", PRUNE_MIN_INTERVAL_MS)) {
    await pruneHistory();
    await pruneAuthAttempts();
  }
  if (!(await claimSlot("lastEvalAt", EVAL_MIN_INTERVAL_MS))) return false;
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
    const col = METRIC_COLUMN[rule.metric];
    // Allowlist (exclude=false): match nodes in `targets`, or all if empty.
    // Blacklist (exclude=true): match every node EXCEPT those in `targets`.
    const targetSet = new Set(rule.targets);
    const targets = rule.exclude
      ? nodes.filter((n) => !targetSet.has(n.id))
      : rule.targets.length > 0
        ? nodes.filter((n) => targetSet.has(n.id))
        : nodes;
    const since = now - rule.windowMinutes * 60 * 1000;

    for (const node of targets) {
      // Fraction of window samples at/above threshold.
      const { rows } = await pool.query<{ total: string; over: string }>(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ${col} >= $3) AS over
           FROM metrics_history
          WHERE node_id = $1 AND ts >= $2`,
        [node.id, since, rule.threshold]
      );
      const total = Number(rows[0].total);
      const over = Number(rows[0].over);
      // Need a minimum of samples to make a call; skip if no data.
      const fraction = total > 0 ? over / total : 0;
      const shouldFire = total >= 2 && fraction >= rule.ratio;

      const state = await getAlertState(rule.id, node.id);
      if (shouldFire) {
        const due =
          !state.firing ||
          !state.lastNotified ||
          now - state.lastNotified >= RENOTIFY_MS;
        if (due) {
          await notify(
            "alert",
            rule.name,
            node.id,
            `${rule.metric.toUpperCase()} ≥ ${rule.threshold}% for ${(fraction * 100).toFixed(0)}% of the last ${rule.windowMinutes}m (threshold ${(rule.ratio * 100).toFixed(0)}%).`
          );
          summary.alertsFired++;
        }
        await setAlertState(rule.id, node.id, true, due ? now : state.lastNotified);
      } else if (state.firing) {
        await notify(
          "recovery",
          rule.name,
          node.id,
          `${rule.metric.toUpperCase()} back to normal.`
        );
        summary.recoveries++;
        await setAlertState(rule.id, node.id, false, now);
      }
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

async function getAlertState(ruleId: string, nodeId: string) {
  const { rows } = await getPool().query<{
    firing: boolean;
    last_notified: string | null;
  }>(`SELECT firing, last_notified FROM alert_state WHERE rule_id=$1 AND node_id=$2`, [
    ruleId,
    nodeId,
  ]);
  if (rows.length === 0) return { firing: false, lastNotified: null as number | null };
  return {
    firing: rows[0].firing,
    lastNotified: rows[0].last_notified ? Number(rows[0].last_notified) : null,
  };
}

async function setAlertState(
  ruleId: string,
  nodeId: string,
  firing: boolean,
  lastNotified: number | null
) {
  await getPool().query(
    `INSERT INTO alert_state (rule_id, node_id, firing, last_notified)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (rule_id, node_id) DO UPDATE SET
       firing=EXCLUDED.firing, last_notified=EXCLUDED.last_notified`,
    [ruleId, nodeId, firing, lastNotified]
  );
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
