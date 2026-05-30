// Custom Next.js server that adds a WebSocket endpoint for nodes running with
// `transport: ws`. Use this when self-hosting (`npm run dev:ws` / `start:ws`).
//
// Vercel does NOT run this file (serverless functions only) — there, nodes use
// `transport: http` -> /api/report instead. The websocket path is purely for
// self-hosted deployments that can keep a long-lived connection open.

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "8080", 10);

const WS_PATH = "/api/ws/node";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Real client IP for the websocket connection (honours an upstream proxy/CDN
// in front of the self-host server), forwarded so the report route can geo-locate.
function connIp(request) {
  const xff = request.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const cf = request.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  return request.socket?.remoteAddress || "";
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url, true));
  });

  // Persist a report by forwarding to the existing /api/report route so all
  // storage + token validation logic lives in one place (lib/db.ts, lib/auth.ts).
  async function persist(report, ip) {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${report.token || ""}`,
    };
    if (ip) headers["x-real-ip"] = ip;
    const res = await fetch(`http://127.0.0.1:${port}/api/report`, {
      method: "POST",
      headers,
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      throw new Error(`report route ${res.status}`);
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  // The shared node token is validated by /api/report (DB-backed); the ws layer
  // just relays frames. Unauthorized reports are rejected downstream.
  wss.on("connection", (ws, request) => {
    const ip = connIp(request);

    ws.on("message", async (data) => {
      let report;
      try {
        report = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }
      if (!report?.host?.hostname || !report?.metrics) return;
      try {
        await persist(report, ip);
      } catch (err) {
        console.error("[ws] persist failed:", err.message);
      }
    });

    ws.on("error", () => {});
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parse(request.url, true);
    if (pathname === WS_PATH) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Self-host evaluation loop: drive /api/cron/check so load + offline alerts
  // fire without an external scheduler. On Vercel this is done by Cron instead.
  const EVAL_INTERVAL_MS = parseInt(process.env.EVAL_INTERVAL_MS || "30000", 10);
  const cronSecret = process.env.CRON_SECRET || "";
  async function tick() {
    try {
      await fetch(`http://127.0.0.1:${port}/api/cron/check`, {
        headers: cronSecret ? { authorization: `Bearer ${cronSecret}` } : {},
      });
    } catch (err) {
      console.error("[eval] tick failed:", err.message);
    }
  }
  setInterval(tick, EVAL_INTERVAL_MS);

  server.listen(port, hostname, () => {
    console.log(`> Wolf-Monitor master ready on http://${hostname}:${port}`);
    console.log(`> node websocket endpoint: ws://${hostname}:${port}${WS_PATH}`);
    console.log(`> evaluation loop every ${EVAL_INTERVAL_MS / 1000}s`);
  });
});
