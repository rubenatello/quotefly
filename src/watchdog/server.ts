import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authorized, receiveSignal, selfHealthy, type WatchdogConfig } from "./core";
import { WatchdogStore } from "./store";

export function createWatchdogServer(config: WatchdogConfig, store: WatchdogStore, now = Date.now) {
  let windowAt = now();
  let requests = 0;
  let active = 0;
  const roles = { api: 0, worker: 0 };
  const end = (res: ServerResponse, status: number) => {
    res.writeHead(status, { "cache-control": "no-store", "referrer-policy": "no-referrer", "connection": "close" });
    res.end();
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (now() - windowAt >= 60_000) { windowAt = now(); requests = 0; roles.api = 0; roles.worker = 0; }
    if (req.method === "GET" && req.url === "/health") return end(res, 204);
    if (req.method === "GET" && req.url === "/ready") {
      return end(res, store.healthy && selfHealthy(store.snapshot(), now()) ? 204 : 503);
    }
    const role = req.url === "/signals/api" ? "api" : req.url === "/signals/worker" ? "worker" : null;
    if (!role || req.method !== "POST") return end(res, 404);
    if (!authorized(req.headers.authorization, role === "api" ? config.apiToken : config.workerToken)) return end(res, 401);
    // Anonymous traffic must not consume the trusted emitters' budget or liveness.
    if (++requests > 200 || active >= 8) return end(res, 429);
    if (++roles[role] > 100) return end(res, 429);
    if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"]) return end(res, 415);
    if (req.headers["content-length"] && Number(req.headers["content-length"]) > 8192) return end(res, 413);
    if (!store.healthy) return end(res, 503);
    active++;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 8192) return end(res, 413);
        chunks.push(bytes);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return end(res, 400); }
      const accepted = store.change(state => receiveSignal(state, body, role, now()));
      return end(res, accepted ? 204 : 400);
    } finally { active--; }
  };
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) end(res, 503); else res.destroy(); });
  });
  server.maxConnections = 32;
  server.maxHeadersCount = 20;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(5000, socket => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
