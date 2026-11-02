// Wire types, validation rules and shared constants for the hub and its clients.

export const VERSION = "1.0.0";

export const BROADCAST = "all";
export const DEFAULT_THREAD = "main";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_WAIT_SECONDS = 120;
export const HEADER_PEER = "x-parley-peer";

export const NAME_RE = /^[a-z0-9_-]{1,32}$/;
export const THREAD_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface Envelope {
  seq: number;
  id: string;
  ts: number;
  thread: string;
  from: string;
  to: string;
  body: string;
}

export interface SendResult {
  id: string;
  seq: number;
  thread: string;
  to: string;
  /** For direct messages: has the recipient ever connected? For broadcasts: always true. */
  peerKnown: boolean;
  /** Number of known peers this message is addressed to right now. */
  recipients: number;
}

export interface InboxResult {
  messages: Envelope[];
  /** Unread messages that matched but were not returned because of the limit. */
  remaining: number;
}

export interface UnreadSummary {
  total: number;
  threads: { thread: string; unread: number }[];
}

export interface ThreadInfo {
  thread: string;
  unread: number;
  total: number;
  last: { seq: number; from: string; to: string; ts: number; preview: string };
}

export interface PeerInfo {
  name: string;
  firstSeen: number;
  lastSeen: number;
  online: boolean;
}

export class RelayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export function parseName(raw: unknown, label = "name"): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new RelayError(400, "bad_name", `${label} is required`);
  }
  const v = raw.trim().toLowerCase();
  if (!NAME_RE.test(v)) {
    throw new RelayError(
      400,
      "bad_name",
      `${label} "${v.slice(0, 40)}" is invalid: use 1-32 lowercase letters, digits, "-" or "_"`,
    );
  }
  if (v === BROADCAST) {
    throw new RelayError(400, "bad_name", `"${BROADCAST}" is reserved for broadcasts and cannot be a peer name`);
  }
  return v;
}

export function parseRecipient(raw: unknown): string {
  if (typeof raw === "string" && raw.trim().toLowerCase() === BROADCAST) return BROADCAST;
  return parseName(raw, "recipient");
}

export function parseThread(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_THREAD;
  if (typeof raw !== "string") throw new RelayError(400, "bad_thread", "thread must be a string");
  const v = raw.trim().toLowerCase();
  if (v === "") return DEFAULT_THREAD;
  if (!THREAD_RE.test(v)) {
    throw new RelayError(
      400,
      "bad_thread",
      `thread "${v.slice(0, 70)}" is invalid: use up to 64 lowercase letters, digits, ".", "-" or "_" (starting with a letter or digit)`,
    );
  }
  return v;
}

export function parseThreadList(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new RelayError(400, "bad_thread", "threads must be an array of strings");
  return [...new Set(raw.map((t) => parseThread(t)))];
}

export function previewOf(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
