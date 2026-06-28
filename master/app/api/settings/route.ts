import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  createUnboundToken,
  deleteNodeToken,
  ensureNodeToken,
  ensureTokenForNode,
  findUser,
  listNodeTokens,
  rotateTokenForNode,
  verifyUserPassword,
} from "@/lib/auth";
import { getPool, getSetting, setSetting, PUBLIC_DASHBOARD_KEY } from "@/lib/db";
import { getOpaqueIdConfig, setOpaqueIdConfig, rotateOpaqueId } from "@/lib/opaqueid";
import { randomBytes } from "crypto";

// General settings: per-node admission tokens (one per server, embedded in
// that server's install command), ipinfo.io token, public-dashboard flag,
// GitHub-mirror, opaque-id cipher. Admin only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SettingsResponse {
  // Legacy shared admission token. Kept so unmigrated nodes keep reporting;
  // remove once every server has been reinstalled with its own token.
  nodeToken: string;
  ipinfoToken: string;
  publicDashboard: boolean;
  ghProxyEnabled: boolean;
  ghProxyUrl: string;
  // Empty (default) = don't push updates. When set to e.g. "v1.5.7" the
  // master tells every node polling /api/tasks to self-update via install.sh
  // if its reported agentVersion doesn't match.
  desiredAgentVersion: string;
  // hostname → currently-reported agentVersion (read from nodes.host->>'agentVersion')
  // so the admin UI can show drift.
  nodeAgentVersions: Record<string, string>;
  // Fingerprints only — the raw key/tweak are secrets equivalent to a
  // password hash (anyone with them can enumerate every node id), so we
  // never echo them back over the wire. Operators verify rotation by
  // watching the fingerprint change.
  idCipherKeyFingerprint: string;
  idCipherTweakFingerprint: string;
  // hostname → that node's unique token (auto-created on first read so the
  // admin always has a copy-paste install command available).
  nodeTokens: Record<string, string>;
  // Pre-created tokens not yet bound to any node — handed to fresh servers
  // before they've first reported.
  unboundTokens: Array<{ token: string; createdAt: number }>;
  // The DATABASE_URL the worker is using right now, so the admin can verify
  // which DB is connected from the UI. Password is redacted server-side so
  // the credential never crosses the wire / lands in HARs / extensions.
  databaseUrl: string;
}

function redactDatabaseUrl(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}

async function buildResponse(): Promise<SettingsResponse> {
  const nodeToken = await ensureNodeToken();
  const ipinfoToken = (await getSetting<string>("ipinfoToken")) ?? "";
  const publicDashboard = (await getSetting<boolean>(PUBLIC_DASHBOARD_KEY)) === true;
  const ghProxyEnabled = (await getSetting<boolean>("ghProxyEnabled")) === true;
  const ghProxyUrl = (await getSetting<string>("ghProxyUrl")) ?? "";
  const desiredAgentVersion = (await getSetting<string>("desiredAgentVersion")) ?? "";
  const idCipher = await getOpaqueIdConfig();

  // Ensure every known node has its own token (lazy migration on read).
  // Also pull the host->>'agentVersion' so the UI shows version drift.
  const { rows } = await getPool().query<{ id: string; agent_version: string | null }>(
    `SELECT id, host->>'agentVersion' AS agent_version FROM nodes`,
  );
  const nodeTokens: Record<string, string> = {};
  const nodeAgentVersions: Record<string, string> = {};
  for (const r of rows) {
    nodeTokens[r.id] = await ensureTokenForNode(r.id);
    nodeAgentVersions[r.id] = r.agent_version ?? "";
  }
  const all = await listNodeTokens();
  // "Unbound" in the UI = a token the admin can hand to a fresh server. Two
  // shapes qualify: legacy NULL-bound tokens (pre-v1.6.1) and the new
  // pre-assigned slug tokens that haven't yet received their first /api/report
  // (no row in `nodes` for the slug).
  const knownNodeIds = new Set(rows.map((r) => r.id));
  const unboundTokens = all
    .filter((t) => t.nodeId === null || !knownNodeIds.has(t.nodeId))
    .map(({ token, createdAt }) => ({ token, createdAt }));

  return {
    nodeToken,
    ipinfoToken,
    publicDashboard,
    ghProxyEnabled,
    ghProxyUrl,
    desiredAgentVersion,
    nodeAgentVersions,
    idCipherKeyFingerprint: idCipher.keyFingerprint,
    idCipherTweakFingerprint: idCipher.tweakFingerprint,
    nodeTokens,
    unboundTokens,
    databaseUrl: redactDatabaseUrl(process.env.DATABASE_URL),
  };
}

export async function GET() {
  if (!(await currentUser()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await buildResponse(), {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (err) {
    console.error("settings GET failed:", errCode(err));
    return NextResponse.json({ error: "storage error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (typeof body.ipinfoToken === "string") {
      await setSetting("ipinfoToken", body.ipinfoToken.trim());
    }
    // rotateNodeToken === true → rotate the legacy shared admission token.
    // rotateNodeToken === { hostname } → rotate that node's per-node token.
    if (body.rotateNodeToken === true) {
      await setSetting("nodeToken", randomBytes(18).toString("base64url"));
    } else if (
      body.rotateNodeToken &&
      typeof body.rotateNodeToken === "object" &&
      typeof body.rotateNodeToken.hostname === "string"
    ) {
      await rotateTokenForNode(body.rotateNodeToken.hostname);
    }
    if (body.createUnboundToken === true) {
      await createUnboundToken();
    }
    if (typeof body.deleteToken === "string") {
      await deleteNodeToken(body.deleteToken);
    }
    if (typeof body.publicDashboard === "boolean") {
      await setSetting(PUBLIC_DASHBOARD_KEY, body.publicDashboard);
    }
    if (typeof body.ghProxyEnabled === "boolean") {
      await setSetting("ghProxyEnabled", body.ghProxyEnabled);
    }
    if (typeof body.ghProxyUrl === "string") {
      await setSetting("ghProxyUrl", body.ghProxyUrl.trim());
    }
    // Target node binary version. Whitelist semver-ish strings only —
    // anything else and the install.sh -V argument becomes a shell injection.
    // Empty string clears the directive (nodes stop self-updating).
    if (typeof body.desiredAgentVersion === "string") {
      const v = body.desiredAgentVersion.trim();
      if (v === "" || /^v?\d{1,3}(\.\d{1,3}){2}$/.test(v)) {
        await setSetting("desiredAgentVersion", v);
      } else {
        return NextResponse.json(
          { error: "desiredAgentVersion must look like v1.2.3" },
          { status: 400 },
        );
      }
    }
    // Cipher key/tweak are equivalent to a password hash: anyone with them
    // can derive every node's opaque id. Require a fresh-auth confirmation
    // (current admin's password) before rotating or setting them, so a
    // stolen session cookie alone can't pivot to silent enumeration.
    const wantsCipherWrite =
      body.rotateIdCipher === true ||
      typeof body.idCipherKey === "string" ||
      typeof body.idCipherTweak === "string";
    if (wantsCipherWrite) {
      if (typeof body.password !== "string" || body.password.length === 0) {
        return NextResponse.json(
          { error: "password required" },
          { status: 403 },
        );
      }
      const fresh = await findUser(user.email);
      if (!(await verifyUserPassword(fresh, body.password))) {
        return NextResponse.json({ error: "bad password" }, { status: 403 });
      }
      if (body.rotateIdCipher === true) {
        await rotateOpaqueId();
      } else {
        await setOpaqueIdConfig(
          typeof body.idCipherKey === "string" ? body.idCipherKey.trim() : undefined,
          typeof body.idCipherTweak === "string" ? body.idCipherTweak.trim() : undefined,
        );
      }
    }
    return NextResponse.json(await buildResponse(), {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (err) {
    console.error("settings POST failed:", errCode(err));
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}

// errCode extracts only the error name/code/status — never the message or pg
// `detail` field, which can echo offending column values into logs.
function errCode(e: unknown): string {
  if (!e || typeof e !== "object") return "unknown";
  const r = e as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : "Error";
  const code = r.code != null ? String(r.code) : "";
  return code ? `${name}(${code})` : name;
}
