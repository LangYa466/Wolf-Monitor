// Centralized error logging. Prevents pg / DB error objects from leaking
// sensitive fields (detail, where, internalQuery, schema, table, column,
// constraint, etc.) into stdout / log aggregators. Also strips CR/LF/NUL/ANSI
// control bytes so attacker-controlled error messages can't forge log lines.

const STRIP_CTRL = /[\r\n\x00-\x1f\x7f]/g;

// pg `DatabaseError` carries these extras beyond Error's name/message; any of
// them can reveal schema internals or echo node-controlled bytes.
const PG_SENSITIVE_KEYS = [
  "detail",
  "where",
  "internalQuery",
  "internalPosition",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "file",
  "line",
  "routine",
  "hint",
  "position",
  "query",
];

export function safeErr(e: unknown, max = 500): string {
  let msg: string;
  if (e instanceof Error) {
    const code = (e as any).code;
    msg = code ? `${e.name}[${code}]: ${e.message}` : `${e.name}: ${e.message}`;
  } else {
    msg = String(e);
  }
  return msg.replace(STRIP_CTRL, " ").slice(0, max);
}

export function logError(label: string, e: unknown): void {
  const safeLabel = String(label).replace(STRIP_CTRL, " ").slice(0, 200);
  // Strip pg-specific leak fields before logging. We deliberately do NOT
  // forward the raw error object to console.error.
  if (e && typeof e === "object") {
    for (const k of PG_SENSITIVE_KEYS) {
      if (k in (e as any)) {
        try { delete (e as any)[k]; } catch { /* frozen — ignore */ }
      }
    }
  }
  // eslint-disable-next-line no-console
  console.error(safeLabel, safeErr(e));
}
