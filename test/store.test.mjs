import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../dist/hub/store.js";
import { SlidingWindowLimiter } from "../dist/hub/limiter.js";
import { tmpDir } from "./helpers.mjs";

test("keeps only the newest maxMessages", () => {
  const s = new Store({ maxMessages: 3 });
  s.touch("b");
  for (let i = 1; i <= 6; i++) s.send("a", "b", "main", `m${i}`);
  assert.equal(s.messageCount, 3);
  assert.deepEqual(s.consume("b", null, 50).messages.map((m) => m.body), ["m4", "m5", "m6"]);
});

test("state survives a restart (messages, peers, read cursors)", () => {
  const file = join(tmpDir(), "data.jsonl");
  let s = new Store({ file, maxMessages: 100 });
  s.touch("a"); s.touch("b");
  s.send("a", "b", "auth", "one");
  s.send("a", "b", "auth", "two");
  s.send("a", "all", "deploy", "bcast");
  assert.equal(s.consume("b", ["auth"], 1).messages[0].body, "one");

  s = new Store({ file, maxMessages: 100 });
  assert.deepEqual(s.listPeers().map((p) => p.name), ["a", "b"]);
  assert.deepEqual(s.consume("b", null, 50).messages.map((m) => m.body), ["two", "bcast"]);
  assert.equal(s.send("a", "b", "auth", "three").seq, 4, "sequence numbers continue");
});

test("tolerates a torn last line and garbage in the journal", () => {
  const file = join(tmpDir(), "data.jsonl");
  const s = new Store({ file, maxMessages: 100 });
  s.touch("b");
  s.send("a", "b", "main", "ok");
  appendFileSync(file, 'this is not json\n{"t":"m","seq":99,"id":"x","ts":1,"thread":"main","from":"a","to":"b","bo');
  const warnings = [];
  const again = new Store({ file, maxMessages: 100, onWarn: (m) => warnings.push(m) });
  assert.equal(again.consume("b", null, 10).messages.length, 1);
  assert.equal(warnings.length, 1);
});

test("journal compacts itself and still replays correctly", () => {
  const file = join(tmpDir(), "data.jsonl");
  const s = new Store({ file, maxMessages: 5 });
  s.touch("b");
  for (let i = 0; i < 2100; i++) s.send("a", "b", "main", `m${i}`);
  const lines = readFileSync(file, "utf8").trim().split("\n").length;
  assert.ok(lines < 2100, `journal compacted (${lines} lines)`);
  assert.ok(!existsSync(file + ".tmp"));
  const again = new Store({ file, maxMessages: 5 });
  assert.deepEqual(again.consume("b", null, 50).messages.map((m) => m.body), ["m2095", "m2096", "m2097", "m2098", "m2099"]);
});

test("limiter allows `limit` per window then recovers", () => {
  let t = 0;
  const l = new SlidingWindowLimiter(3, 1000, () => t);
  assert.deepEqual([l.hit("k"), l.hit("k"), l.hit("k")], [0, 0, 0]);
  assert.ok(l.hit("k") > 0);
  t += 1001;
  assert.equal(l.hit("k"), 0);
  assert.equal(l.hit("other"), 0);
});
