import type { ClientConfig } from "../shared/config.js";
import {
  HEADER_PEER,
  MAX_WAIT_SECONDS,
  RelayError,
  clamp,
  type Envelope,
  type InboxResult,
  type PeerInfo,
  type SendResult,
  type ThreadInfo,
  type UnreadSummary,
} from "../shared/protocol.js";

/** Long polls are split into segments so proxies with idle timeouts (often ~60-100s) never cut us off. */
const POLL_SEGMENT_SECONDS = 25;

interface CallOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class HubClient {
  constructor(
    private readonly cfg: ClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get name(): string {
    return this.cfg.name;
  }

  get url(): string {
    return this.cfg.url;
  }

  private async call<T>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
    const url = new URL(this.cfg.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 15_000)];
    if (opts.signal) signals.push(opts.signal);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          [HEADER_PEER]: this.cfg.name,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new RelayError(0, "timeout", `The hub at ${this.cfg.url} did not answer in time`);
      }
      const why = err.cause?.code ?? err.cause?.message ?? err.message;
      throw new RelayError(0, "unreachable", `Cannot reach the hub at ${this.cfg.url} (${why})`);
    }

    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error page from a proxy */
    }
    if (!res.ok) {
      const server = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      let message = server?.message ?? `Hub returned HTTP ${res.status}`;
      if (res.status === 401) message = "The hub rejected the token. Check `token` in your parley config.";
      const retry = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      throw new RelayError(res.status, server?.code ?? "http_error", message, Number.isFinite(retry) ? retry : undefined);
    }
    return data as T;
  }

  hello(): Promise<{ peer: string; serverTime: number; version: string }> {
    return this.call("POST", "/v1/hello");
  }

  send(to: string, body: string, thread?: string): Promise<SendResult> {
    return this.call("POST", "/v1/messages", { body: { to, body, thread } });
  }

  /** One request. Pass `waitSeconds` to long-poll (the hub caps it at 120). */
  inboxOnce(opts: { threads?: string[] | null; waitSeconds?: number; peek?: boolean; limit?: number; signal?: AbortSignal }): Promise<InboxResult> {
    const wait = opts.waitSeconds ?? 0;
    return this.call("GET", "/v1/inbox", {
      query: {
        thread: opts.threads?.length ? opts.threads.join(",") : undefined,
        wait: wait > 0 ? wait.toFixed(1) : undefined,
        peek: opts.peek ? "1" : undefined,
        limit: opts.limit !== undefined ? String(opts.limit) : undefined,
      },
      timeoutMs: (wait + 15) * 1000,
      signal: opts.signal,
    });
  }

  /** Reads unread mail, optionally waiting up to `waitSeconds` for some to arrive. */
  async inbox(opts: { threads?: string[] | null; waitSeconds?: number; limit?: number; signal?: AbortSignal }): Promise<InboxResult> {
    const total = clamp(opts.waitSeconds ?? 0, 0, MAX_WAIT_SECONDS);
    const deadline = Date.now() + total * 1000;
    for (;;) {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      const result = await this.inboxOnce({
        threads: opts.threads,
        waitSeconds: Math.min(remaining, POLL_SEGMENT_SECONDS),
        limit: opts.limit,
        signal: opts.signal,
      });
      if (result.messages.length > 0 || Date.now() >= deadline - 250) return result;
    }
  }

  unread(threads?: string[] | null, timeoutMs = 5_000): Promise<UnreadSummary> {
    return this.call("GET", "/v1/unread", {
      query: { thread: threads?.length ? threads.join(",") : undefined },
      timeoutMs,
    });
  }

  async threads(): Promise<ThreadInfo[]> {
    return (await this.call<{ threads: ThreadInfo[] }>("GET", "/v1/threads")).threads;
  }

  async peers(): Promise<{ peers: PeerInfo[]; serverTime: number }> {
    return this.call("GET", "/v1/peers");
  }

  async health(): Promise<{ ok: boolean; version: string; uptimeSec: number }> {
    const res = await this.fetchImpl(new URL(this.cfg.url + "/health"), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new RelayError(res.status, "unhealthy", `Hub health check returned HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; version: string; uptimeSec: number };
  }
}

export type { Envelope };
