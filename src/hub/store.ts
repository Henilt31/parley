import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BROADCAST,
  RelayError,
  previewOf,
  type Envelope,
  type InboxResult,
  type PeerInfo,
  type SendResult,
  type ThreadInfo,
  type UnreadSummary,
} from "../shared/protocol.js";

interface PeerRecord {
  name: string;
  firstSeen: number;
  lastSeen: number;
  /** Broadcasts sent at or before this sequence number predate the peer and are not delivered. */
  joinSeq: number;
  /** Highest delivered sequence number per thread. */
  cursors: Record<string, number>;
}

type LogRecord =
  | ({ t: "m" } & Envelope)
  | { t: "p"; name: string; firstSeen: number; lastSeen: number; joinSeq: number; cursors: Record<string, number> }
  | { t: "r"; name: string; thread: string; seq: number };

export interface StoreOptions {
  /** Append-only journal. Omit for a purely in-memory hub. */
  file?: string;
  maxMessages: number;
  now?: () => number;
  /** A peer counts as online if it was heard from within this many ms. */
  onlineWindowMs?: number;
  onWarn?: (msg: string) => void;
}

/**
 * In-memory message log with per-peer, per-thread read cursors, persisted as an append-only
 * JSONL journal that is compacted into a snapshot once it grows too long.
 *
 * Events: "message" (Envelope) is emitted after every accepted message.
 */
export class Store extends EventEmitter {
  private msgs: Envelope[] = [];
  private readonly peers = new Map<string, PeerRecord>();
  private seq = 0;
  private journalLines = 0;
  private readonly now: () => number;
  private readonly onlineWindowMs: number;

  constructor(private readonly opts: StoreOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.onlineWindowMs = opts.onlineWindowMs ?? 90_000;
    this.setMaxListeners(0);
    if (opts.file) this.load(opts.file);
  }

  // ───────────────────────────── persistence ─────────────────────────────

  private warn(msg: string): void {
    this.opts.onWarn?.(msg);
  }

  private load(file: string): void {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      return;
    }
    const text = readFileSync(file, "utf8");
    let bad = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      this.journalLines++;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        bad++;
        continue;
      }
      switch (rec.t) {
        case "m":
          this.msgs.push({ seq: rec.seq, id: rec.id, ts: rec.ts, thread: rec.thread, from: rec.from, to: rec.to, body: rec.body });
          this.seq = Math.max(this.seq, rec.seq);
          break;
        case "p": {
          const existing = this.peers.get(rec.name);
          const cursors = { ...(existing?.cursors ?? {}) };
          for (const [t, s] of Object.entries(rec.cursors ?? {})) cursors[t] = Math.max(cursors[t] ?? 0, s);
          this.peers.set(rec.name, {
            name: rec.name,
            firstSeen: rec.firstSeen,
            lastSeen: Math.max(rec.lastSeen, existing?.lastSeen ?? 0),
            joinSeq: rec.joinSeq,
            cursors,
          });
          this.seq = Math.max(this.seq, rec.joinSeq);
          break;
        }
        case "r": {
          const p = this.peers.get(rec.name);
          if (p) p.cursors[rec.thread] = Math.max(p.cursors[rec.thread] ?? 0, rec.seq);
          this.seq = Math.max(this.seq, rec.seq);
          break;
        }
        default:
          bad++;
      }
    }
    if (bad) this.warn(`journal ${file}: skipped ${bad} unreadable line(s)`);
    this.msgs.sort((a, b) => a.seq - b.seq);
    this.trim();
    if (this.journalLines > this.compactThreshold()) this.compact();
  }

  private compactThreshold(): number {
    return Math.max(2000, this.opts.maxMessages * 4);
  }

  private append(rec: LogRecord): void {
    const file = this.opts.file;
    if (!file) return;
    try {
      appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
      this.journalLines++;
    } catch (e) {
      this.warn(`could not write journal: ${(e as Error).message}`);
      return;
    }
    if (this.journalLines > this.compactThreshold()) this.compact();
  }

  /** Rewrites the journal as a minimal snapshot (peers first, then messages). */
  compact(): void {
    const file = this.opts.file;
    if (!file) return;
    const lines: string[] = [];
    for (const p of this.peers.values()) lines.push(JSON.stringify({ t: "p", ...p }));
    for (const m of this.msgs) lines.push(JSON.stringify({ t: "m", ...m }));
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
      renameSync(tmp, file);
      this.journalLines = lines.length;
    } catch (e) {
      this.warn(`could not compact journal: ${(e as Error).message}`);
    }
  }

  private trim(): void {
    const extra = this.msgs.length - this.opts.maxMessages;
    if (extra > 0) this.msgs.splice(0, extra);
  }

  // ───────────────────────────── peers ─────────────────────────────

  /** Registers the peer on first contact and refreshes its last-seen time. */
  touch(name: string): PeerRecord {
    const now = this.now();
    let p = this.peers.get(name);
    if (!p) {
      p = { name, firstSeen: now, lastSeen: now, joinSeq: this.seq, cursors: {} };
      this.peers.set(name, p);
      this.append({ t: "p", ...p });
    } else {
      p.lastSeen = now;
    }
    return p;
  }

  isKnown(name: string): boolean {
    return this.peers.has(name);
  }

  listPeers(): PeerInfo[] {
    const now = this.now();
    return [...this.peers.values()]
      .map((p) => ({
        name: p.name,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        online: now - p.lastSeen <= this.onlineWindowMs,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ───────────────────────────── messages ─────────────────────────────

  send(from: string, to: string, thread: string, body: string): SendResult {
    if (to === from) throw new RelayError(400, "self_message", "You cannot send a message to yourself");
    this.touch(from);
    const msg: Envelope = { seq: ++this.seq, id: randomUUID(), ts: this.now(), thread, from, to, body };
    this.msgs.push(msg);
    this.trim();
    this.append({ t: "m", ...msg });
    const recipients =
      to === BROADCAST ? [...this.peers.keys()].filter((n) => n !== from).length : this.peers.has(to) ? 1 : 0;
    this.emit("message", msg);
    return { id: msg.id, seq: msg.seq, thread, to, peerKnown: to === BROADCAST ? true : this.peers.has(to), recipients };
  }

  private deliverable(m: Envelope, p: PeerRecord): boolean {
    if (m.from === p.name) return false;
    if (m.to === p.name) return true;
    return m.to === BROADCAST && m.seq > p.joinSeq;
  }

  private unreadFor(name: string, threads: string[] | null): Envelope[] {
    const p = this.peers.get(name);
    if (!p) return [];
    const set = threads && threads.length ? new Set(threads) : null;
    const out: Envelope[] = [];
    for (const m of this.msgs) {
      if (set && !set.has(m.thread)) continue;
      if (!this.deliverable(m, p)) continue;
      if (m.seq > (p.cursors[m.thread] ?? 0)) out.push(m);
    }
    return out;
  }

  hasUnread(name: string, threads: string[] | null): boolean {
    return this.unreadFor(name, threads).length > 0;
  }

  /** Reads unread messages without marking them as read. */
  peek(name: string, threads: string[] | null, limit: number): InboxResult {
    const all = this.unreadFor(name, threads);
    return { messages: all.slice(0, limit), remaining: Math.max(0, all.length - limit) };
  }

  /** Reads unread messages and advances the peer's cursors past them. */
  consume(name: string, threads: string[] | null, limit: number): InboxResult {
    const all = this.unreadFor(name, threads);
    const batch = all.slice(0, limit);
    const p = this.peers.get(name);
    if (p) {
      const advanced = new Map<string, number>();
      for (const m of batch) advanced.set(m.thread, Math.max(advanced.get(m.thread) ?? 0, m.seq));
      for (const [thread, seq] of advanced) {
        p.cursors[thread] = Math.max(p.cursors[thread] ?? 0, seq);
        this.append({ t: "r", name, thread, seq });
      }
    }
    return { messages: batch, remaining: Math.max(0, all.length - batch.length) };
  }

  summary(name: string, threads: string[] | null): UnreadSummary {
    const counts = new Map<string, number>();
    for (const m of this.unreadFor(name, threads)) counts.set(m.thread, (counts.get(m.thread) ?? 0) + 1);
    const list = [...counts.entries()].map(([thread, unread]) => ({ thread, unread })).sort((a, b) => a.thread.localeCompare(b.thread));
    return { total: list.reduce((n, t) => n + t.unread, 0), threads: list };
  }

  threadsFor(name: string): ThreadInfo[] {
    const p = this.peers.get(name);
    if (!p) return [];
    const byThread = new Map<string, { total: number; unread: number; last: Envelope }>();
    for (const m of this.msgs) {
      const mine = m.from === name;
      if (!mine && !this.deliverable(m, p)) continue;
      const entry = byThread.get(m.thread) ?? { total: 0, unread: 0, last: m };
      entry.total++;
      entry.last = m;
      if (!mine && m.seq > (p.cursors[m.thread] ?? 0)) entry.unread++;
      byThread.set(m.thread, entry);
    }
    return [...byThread.entries()]
      .map(([thread, e]) => ({
        thread,
        unread: e.unread,
        total: e.total,
        last: { seq: e.last.seq, from: e.last.from, to: e.last.to, ts: e.last.ts, preview: previewOf(e.last.body) },
      }))
      .sort((a, b) => b.last.seq - a.last.seq);
  }

  get messageCount(): number {
    return this.msgs.length;
  }
}
