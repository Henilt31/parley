import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  HEADER_PEER,
  MAX_BODY_BYTES,
  MAX_WAIT_SECONDS,
  RelayError,
  VERSION,
  clamp,
  parseName,
  parseRecipient,
  parseThread,
} from "../shared/protocol.js";
import { SlidingWindowLimiter } from "./limiter.js";
import { Store } from "./store.js";

export interface HubOptions {
  token: string;
  port?: number;
  host?: string;
  /** Journal file. Omit to keep everything in memory. */
  dataFile?: string;
  maxMessages?: number;
  /** Requests per peer per minute. */
  rateLimitPerMinute?: number;
  /** Honour X-Forwarded-For when tracking failed logins (set when running behind a proxy). */
  trustProxy?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export interface Hub {
  store: Store;
  server: http.Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

const MIN_TOKEN_LENGTH = 16;
const DRAIN_LIMIT = 1024 * 1024;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function createHub(options: HubOptions): Hub {
  if (!options.token || options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`token must be at least ${MIN_TOKEN_LENGTH} characters (try \`parley token\`)`);
  }
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimitPerMinute ?? 120;
  const store = new Store({
    file: options.dataFile,
    maxMessages: options.maxMessages ?? 2000,
    now,
    onWarn: (m) => log(`warn: ${m}`),
  });
  const tokenDigest = digest(options.token);
  const rate = new SlidingWindowLimiter(rateLimit, 60_000, now);
  const authFailures = new SlidingWindowLimiter(20, 60_000, now);
  const startedAt = now();
  let closing = false;

  const sweeper = setInterval(() => {
    rate.sweep();
    authFailures.sweep();
  }, 60_000);
  sweeper.unref();

  // ───────────── helpers ─────────────

  function send(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return;
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
      ...headers,
    });
    res.end(text);
  }

  function sendError(res: http.ServerResponse, err: RelayError): void {
    const headers: Record<string, string> = {};
    if (err.retryAfterSec !== undefined) headers["retry-after"] = String(err.retryAfterSec);
    if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="parley"';
    send(res, err.status, { error: { code: err.code, message: err.message } }, headers);
  }

  function clientIp(req: http.IncomingMessage): string {
    if (options.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function authenticate(req: http.IncomingMessage): string {
    const ip = clientIp(req);
    const blocked = authFailures.blockedFor(ip);
    if (blocked > 0) {
      throw new RelayError(429, "too_many_failures", "Too many failed authentication attempts; try again shortly", Math.ceil(blocked / 1000));
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
    const ok = match ? timingSafeEqual(digest(match[1]!), tokenDigest) : false;
    if (!ok) {
      authFailures.record(ip);
      throw new RelayError(401, "unauthorized", "Missing or invalid bearer token");
    }
    const raw = req.headers[HEADER_PEER];
    const peer = parseName(Array.isArray(raw) ? raw[0] : raw, "X-Parley-Peer header");
    const wait = rate.hit(peer);
    if (wait > 0) {
      throw new RelayError(429, "rate_limited", `Rate limit exceeded (${rateLimit} requests/minute per sender)`, Math.ceil(wait / 1000));
    }
    return peer;
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const limit = MAX_BODY_BYTES + 4096; // room for the JSON envelope around a max-size message
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > DRAIN_LIMIT) {
        throw new RelayError(413, "too_large", `Request body exceeds the 64 KB message limit`);
      }
      if (size > limit) tooBig = true;
      else chunks.push(buf);
    }
    if (tooBig) throw new RelayError(413, "too_large", `Message exceeds the 64 KB limit`);
    if (size === 0) throw new RelayError(400, "bad_json", "Request body is empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RelayError(400, "bad_json", "Request body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RelayError(400, "bad_json", "Request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  function threadFilter(raw: string | null): string[] | null {
    if (raw === null || raw.trim() === "") return null;
    return [...new Set(raw.split(",").filter((t) => t.trim() !== "").map((t) => parseThread(t)))];
  }

  /** Resolves when matching mail arrives, the timeout passes, the client leaves, or the hub shuts down. */
  function waitForMail(peer: string, threads: string[] | null, ms: number, res: http.ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        store.off("message", onMessage);
        store.off("wake", finish);
        res.off("close", finish);
        resolve();
      };
      const onMessage = () => {
        if (store.hasUnread(peer, threads)) finish();
      };
      const timer = setTimeout(finish, ms);
      store.on("message", onMessage);
      store.on("wake", finish);
      res.on("close", finish);
    });
  }

  // ───────────── routing ─────────────

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hub.local");
    const method = req.method ?? "GET";

    if (url.pathname === "/health" && (method === "GET" || method === "HEAD")) {
      send(res, 200, { ok: true, service: "parley-hub", version: VERSION, uptimeSec: Math.round((now() - startedAt) / 1000) });
      return;
    }
    if (!url.pathname.startsWith("/v1/")) throw new RelayError(404, "not_found", "No such endpoint");

    const peer = authenticate(req);
    const wasKnown = store.isKnown(peer);
    store.touch(peer);
    if (!wasKnown) log(`peer joined: ${peer}`);

    const key = `${method} ${url.pathname}`;
    switch (key) {
      case "POST /v1/hello": {
        send(res, 200, { peer, serverTime: now(), version: VERSION });
        return;
      }
      case "POST /v1/messages": {
        const body = await readJson(req);
        const to = parseRecipient(body.to);
        const thread = parseThread(body.thread);
        if (typeof body.body !== "string" || body.body.trim() === "") {
          throw new RelayError(400, "bad_body", "message body must be a non-empty string");
        }
        if (Buffer.byteLength(body.body, "utf8") > MAX_BODY_BYTES) {
          throw new RelayError(413, "too_large", `Message exceeds the 64 KB limit (${Buffer.byteLength(body.body, "utf8")} bytes)`);
        }
        send(res, 201, store.send(peer, to, thread, body.body));
        return;
      }
      case "GET /v1/inbox": {
        const q = url.searchParams;
        const threads = threadFilter(q.get("thread"));
        const waitMs = clamp(Number.parseFloat(q.get("wait") ?? "0") || 0, 0, MAX_WAIT_SECONDS) * 1000;
        const peek = q.get("peek") === "1" || q.get("peek") === "true";
        const limit = clamp(Number.parseInt(q.get("limit") ?? "50", 10) || 50, 1, 100);
        if (waitMs > 0 && !closing && !store.hasUnread(peer, threads)) {
          await waitForMail(peer, threads, waitMs, res);
        }
        // The caller hung up while waiting: leave its mail unread for the next check.
        if (res.destroyed || res.writableEnded) return;
        store.touch(peer);
        send(res, 200, peek ? store.peek(peer, threads, limit) : store.consume(peer, threads, limit));
        return;
      }
      case "GET /v1/unread": {
        send(res, 200, store.summary(peer, threadFilter(url.searchParams.get("thread"))));
        return;
      }
      case "GET /v1/threads": {
        send(res, 200, { threads: store.threadsFor(peer) });
        return;
      }
      case "GET /v1/peers": {
        send(res, 200, { peers: store.listPeers(), serverTime: now() });
        return;
      }
      default: {
        const known = ["POST /v1/hello", "POST /v1/messages", "GET /v1/inbox", "GET /v1/unread", "GET /v1/threads", "GET /v1/peers"];
        if (known.some((k) => k.endsWith(url.pathname))) {
          throw new RelayError(405, "method_not_allowed", `${method} is not allowed on ${url.pathname}`);
        }
        throw new RelayError(404, "not_found", "No such endpoint");
      }
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (e instanceof RelayError) {
        if (e.status === 413) res.setHeader("connection", "close");
        sendError(res, e);
      } else {
        log(`error: ${(e as Error)?.stack ?? String(e)}`);
        send(res, 500, { error: { code: "internal", message: "Internal hub error" } });
      }
    });
  });

  return {
    store,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 8787, options.host ?? "0.0.0.0", () => {
          server.off("error", reject);
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
        });
      });
    },
    close() {
      closing = true;
      clearInterval(sweeper);
      store.emit("wake");
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 500).unref();
      });
    },
  };
}
