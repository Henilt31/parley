import test from "node:test";
import assert from "node:assert/strict";
import { startHub, raw, cfg, TOKEN } from "./helpers.mjs";
import { HubClient } from "../dist/client/hub-client.js";

test("health is open, v1 requires the token", async () => {
  const { hub, url } = await startHub();
  try {
    assert.equal((await raw(url, "/health", { token: null })).json.ok, true);
    assert.equal((await raw(url, "/v1/peers", { token: null, peer: "a" })).status, 401);
    assert.equal((await raw(url, "/v1/peers", { token: "wrong".repeat(10), peer: "a" })).status, 401);
    const noPeer = await raw(url, "/v1/peers");
    assert.equal(noPeer.status, 400);
    const badPeer = await raw(url, "/v1/peers", { peer: "Bad Name!" });
    assert.equal(badPeer.status, 400);
    assert.equal((await raw(url, "/v1/peers", { peer: "all" })).status, 400, "'all' is reserved");
    assert.equal((await raw(url, "/v1/peers", { peer: "ok_name-1" })).status, 200);
    assert.equal((await raw(url, "/nope", { token: null })).status, 404);
    assert.equal((await raw(url, "/v1/messages", { peer: "a" })).status, 405);
  } finally { await hub.close(); }
});

test("direct messages, replies and read state", async () => {
  const { hub, url } = await startHub();
  try {
    const alice = new HubClient(cfg(url, "alice"));
    const bob = new HubClient(cfg(url, "bob"));
    await alice.hello();
    await bob.hello();
    const sent = await alice.send("bob", "which branch?", "auth");
    assert.equal(sent.thread, "auth");
    assert.equal(sent.peerKnown, true);

    assert.equal((await alice.inbox({})).messages.length, 0, "sender does not receive own message");
    const peek = await bob.inboxOnce({ peek: true });
    assert.equal(peek.messages.length, 1);
    assert.equal((await bob.unread()).total, 1, "peek does not mark read");

    const got = await bob.inbox({});
    assert.deepEqual(got.messages.map((m) => [m.from, m.thread, m.body]), [["alice", "auth", "which branch?"]]);
    assert.equal((await bob.inbox({})).messages.length, 0, "consumed");
    assert.equal((await bob.unread()).total, 0);

    await bob.send("alice", "feat/x", "auth");
    assert.equal((await alice.inbox({})).messages[0].body, "feat/x");
  } finally { await hub.close(); }
});

test("default thread is main; invalid names rejected; self-send rejected", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await b.hello();
    assert.equal((await a.send("b", "hi")).thread, "main");
    await assert.rejects(a.send("b", "x", "Bad Thread!"), /thread/);
    await assert.rejects(a.send("a", "me"), /yourself/);
    await assert.rejects(a.send("", "x"), /recipient/);
    await assert.rejects(a.send("b", "   "), /non-empty/);
    assert.equal((await raw(url, "/v1/messages", { method: "POST", peer: "a", body: "{not json" })).status, 400);
    assert.equal((await raw(url, "/v1/messages", { method: "POST", peer: "a", body: [] })).status, 400);
  } finally { await hub.close(); }
});

test("broadcast reaches others but not the sender or peers who joined later", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await a.hello(); await b.hello();
    const r = await a.send("all", "migrating DB", "deploy");
    assert.equal(r.recipients, 1);
    const late = new HubClient(cfg(url, "late"));
    await late.hello();
    assert.equal((await late.inbox({})).messages.length, 0, "no history replay for new peers");
    assert.equal((await a.inbox({})).messages.length, 0);
    assert.equal((await b.inbox({})).messages[0].body, "migrating DB");
    await a.send("all", "done", "deploy");
    assert.equal((await late.inbox({})).messages[0].body, "done");
  } finally { await hub.close(); }
});

test("direct message to a peer who has not connected yet is held for them", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const r = await a.send("carol", "welcome");
    assert.equal(r.peerKnown, false);
    const carol = new HubClient(cfg(url, "carol"));
    assert.equal((await carol.inbox({})).messages[0].body, "welcome");
  } finally { await hub.close(); }
});

test("thread filtering keeps other threads unread; threads listing reports counts", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await b.hello();
    await a.send("b", "one", "auth");
    await a.send("b", "two", "deploy");
    await a.send("b", "three", "auth");
    const onlyAuth = await b.inbox({ threads: ["auth"] });
    assert.deepEqual(onlyAuth.messages.map((m) => m.body), ["one", "three"]);
    const summary = await b.unread();
    assert.deepEqual(summary.threads, [{ thread: "deploy", unread: 1 }]);
    const threads = await b.threads();
    const deploy = threads.find((t) => t.thread === "deploy");
    assert.equal(deploy.unread, 1);
    assert.equal(deploy.last.preview, "two");
    const auth = threads.find((t) => t.thread === "auth");
    assert.equal(auth.unread, 0);
    assert.equal(auth.total, 2);
    assert.equal((await b.inbox({ threads: ["deploy"] })).messages[0].body, "two");
    // sender sees threads it started, with no unread
    const mine = (await a.threads()).find((t) => t.thread === "auth");
    assert.equal(mine.total, 2);
    assert.equal(mine.unread, 0);
  } finally { await hub.close(); }
});

test("limit pages through unread mail in order without losing any", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await b.hello();
    for (let i = 1; i <= 5; i++) await a.send("b", `m${i}`, i % 2 ? "x" : "y");
    const p1 = await b.inbox({ limit: 2 });
    assert.deepEqual(p1.messages.map((m) => m.body), ["m1", "m2"]);
    assert.equal(p1.remaining, 3);
    const p2 = await b.inbox({ limit: 10 });
    assert.deepEqual(p2.messages.map((m) => m.body), ["m3", "m4", "m5"]);
  } finally { await hub.close(); }
});

test("long poll wakes when a message arrives and times out otherwise", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await a.hello(); await b.hello();
    const t0 = Date.now();
    const waiting = b.inbox({ waitSeconds: 10 });
    setTimeout(() => a.send("b", "ping"), 300);
    const res = await waiting;
    assert.equal(res.messages[0].body, "ping");
    assert.ok(Date.now() - t0 < 3000, "returned promptly after the message");

    const t1 = Date.now();
    const empty = await b.inbox({ waitSeconds: 0.6 });
    assert.equal(empty.messages.length, 0);
    assert.ok(Date.now() - t1 >= 500);

    // a waiting poll on one thread ignores traffic on another
    const t2 = Date.now();
    const onlyX = b.inbox({ waitSeconds: 1, threads: ["x"] });
    setTimeout(() => a.send("b", "other", "y"), 100);
    assert.equal((await onlyX).messages.length, 0);
    assert.ok(Date.now() - t2 >= 900);
    assert.equal((await b.inbox({ threads: ["y"] })).messages[0].body, "other");
  } finally { await hub.close(); }
});

test("a client that hangs up during a long poll does not lose its mail", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await b.hello();
    const ctl = new AbortController();
    const p = b.inboxOnce({ waitSeconds: 20, signal: ctl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 200));
    ctl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 100));
    await a.send("b", "still here");
    assert.equal((await b.inbox({})).messages[0].body, "still here");
  } finally { await hub.close(); }
});

test("long polls are released when the hub shuts down", async () => {
  const { hub, url } = await startHub();
  const b = new HubClient(cfg(url, "b"));
  await b.hello();
  const p = b.inboxOnce({ waitSeconds: 60 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 200));
  const t = Date.now();
  await hub.close();
  await p;
  assert.ok(Date.now() - t < 3000);
});

test("message size limit is 64KB", async () => {
  const { hub, url } = await startHub();
  try {
    const a = new HubClient(cfg(url, "a"));
    await a.send("b", "x".repeat(64 * 1024));
    await assert.rejects(a.send("b", "x".repeat(64 * 1024 + 1)), /64/);
    const huge = await raw(url, "/v1/messages", { method: "POST", peer: "a", body: { to: "b", body: "y".repeat(300_000) } });
    assert.equal(huge.status, 413);
    // multibyte: 30k chars * 3 bytes > 64KB
    await assert.rejects(a.send("b", "€".repeat(30_000)), /64/);
  } finally { await hub.close(); }
});

test("per-sender rate limit returns 429 with Retry-After", async () => {
  const { hub, url } = await startHub({ rateLimitPerMinute: 5 });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await raw(url, "/v1/peers", { peer: "spam" })).status, 200);
    const limited = await raw(url, "/v1/peers", { peer: "spam" });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await raw(url, "/v1/peers", { peer: "other" })).status, 200, "limit is per sender");
  } finally { await hub.close(); }
});

test("repeated bad tokens get throttled", async () => {
  const { hub, url } = await startHub();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await raw(url, "/v1/peers", { peer: "x", token: "nope".repeat(8) })).status, 401);
    assert.equal((await raw(url, "/v1/peers", { peer: "x", token: "nope".repeat(8) })).status, 429);
    assert.equal((await raw(url, "/v1/peers", { peer: "x" })).status, 429, "even the right token waits out the lockout");
  } finally { await hub.close(); }
});

test("short tokens are refused at startup", async () => {
  const { createHub } = await import("../dist/hub/server.js");
  assert.throws(() => createHub({ token: "short" }), /at least 16/);
});

test("peers list shows presence", async () => {
  let t = 1_000_000;
  const { hub, url } = await startHub({ now: () => t });
  try {
    const a = new HubClient(cfg(url, "a"));
    await a.hello();
    let { peers } = await a.peers();
    assert.deepEqual(peers.map((p) => [p.name, p.online]), [["a", true]]);
    t += 200_000;
    ({ peers } = await new HubClient(cfg(url, "b")).peers());
    assert.deepEqual(peers.map((p) => [p.name, p.online]), [["a", false], ["b", true]]);
  } finally { await hub.close(); }
});

test("client reports bad token and unreachable hub clearly", async () => {
  const { hub, url } = await startHub();
  try {
    const bad = new HubClient({ url, token: "z".repeat(40), name: "a" });
    await assert.rejects(bad.hello(), /rejected the token/);
  } finally { await hub.close(); }
  const gone = new HubClient({ url: "http://127.0.0.1:1", token: TOKEN, name: "a" });
  await assert.rejects(gone.hello(), /Cannot reach the hub/);
});
