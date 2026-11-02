import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHub, cfg, tmpDir, TOKEN } from "./helpers.mjs";
import { HubClient } from "../dist/client/hub-client.js";
import { addHook, removeHook, isHookInstalled, readSettings, hookCommand } from "../dist/install.js";
import { loadClientConfig, validateConfig, writeClientConfig, envThreads } from "../dist/shared/config.js";

// Async on purpose: the hub runs inside this process and must keep serving while the child runs.
function run(file, args, { env = {}, input } = {}) {
  return new Promise((res) => {
    const child = execFile(process.execPath, [resolve(file), ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 15000 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function writeCfg(dir, url, name, file = "cfg.json") {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ url, token: TOKEN, name }));
  return path;
}

test("hook nudges Claude when mail is waiting, without marking it read", async () => {
  const { hub, url } = await startHub();
  const dir = tmpDir();
  try {
    const env = { PARLEY_CONFIG: writeCfg(dir, url, "bob") };
    const bob = new HubClient(cfg(url, "bob"));
    await bob.hello();

    const quiet = await run("dist/hook.js", [], { env, input: '{"prompt":"hi"}' });
    assert.equal(quiet.code, 0);
    assert.equal(quiet.stdout, "", "silent with an empty inbox");

    const alice = new HubClient(cfg(url, "alice"));
    await alice.send("bob", "one", "auth");
    await alice.send("bob", "two", "auth");
    await alice.send("bob", "three", "deploy");

    const out = await run("dist/hook.js", [], { env, input: '{"prompt":"hi"}' });
    assert.equal(out.code, 0);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.match(ctx, /3 unread relay messages/);
    assert.match(ctx, /auth: 2, deploy: 1/);
    assert.match(ctx, /check_messages/);
    assert.equal((await bob.unread()).total, 3, "hook only peeks");

    const scoped = await run("dist/hook.js", [], { env: { ...env, PARLEY_THREADS: "deploy" }, input: "{}" });
    assert.match(JSON.parse(scoped.stdout).hookSpecificOutput.additionalContext, /1 unread relay message from teammates \(deploy: 1\)/);
  } finally { await hub.close(); }
});

test("hook never fails the user's prompt (hub down / not configured)", async () => {
  const dir = tmpDir();
  const down = await run("dist/hook.js", [], { env: { PARLEY_CONFIG: writeCfg(dir, "http://127.0.0.1:1", "bob") }, input: "{}" });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "");
  const none = await run("dist/hook.js", [], { env: { PARLEY_CONFIG: join(dir, "nope.json") }, input: "{}" });
  assert.equal(none.code, 0);
  assert.equal(none.stdout, "");
});

test("settings merge: adds once, keeps other hooks, removes cleanly", () => {
  const cmd = hookCommand("/opt/parley/dist");
  const existing = {
    theme: "dark",
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] }],
    },
  };
  const a = addHook(existing, cmd);
  assert.equal(a.changed, true);
  assert.equal(a.settings.theme, "dark");
  assert.equal(a.settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(isHookInstalled(a.settings, cmd), true);
  assert.deepEqual(existing.hooks.UserPromptSubmit.length, 1, "input not mutated");

  const again = addHook(a.settings, cmd);
  assert.equal(again.changed, false);
  assert.equal(again.settings.hooks.UserPromptSubmit.length, 2, "idempotent");

  const moved = addHook(a.settings, hookCommand("/new/place/parley/dist"));
  assert.equal(moved.changed, true);
  assert.equal(moved.settings.hooks.UserPromptSubmit.length, 2, "path refreshed, not duplicated");

  const r = removeHook(a.settings);
  assert.equal(r.changed, true);
  assert.deepEqual(r.settings.hooks.UserPromptSubmit, existing.hooks.UserPromptSubmit);
  assert.ok(r.settings.hooks.PreToolUse);

  const empty = removeHook(addHook({}, cmd).settings);
  assert.deepEqual(empty.settings, {});
});

test("invalid settings.json is never overwritten", () => {
  const f = join(tmpDir(), "settings.json");
  writeFileSync(f, "{ not json");
  assert.throws(() => readSettings(f), /not valid JSON/);
});

test("config: file, env overrides, validation, owner-only permissions", () => {
  const dir = tmpDir();
  const path = join(dir, "c.json");
  writeClientConfig({ url: "https://hub.example.com/", token: "secret-token-123", name: "Hardy" }, path);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const c = loadClientConfig({ PARLEY_CONFIG: path });
  assert.deepEqual(c, { url: "https://hub.example.com", token: "secret-token-123", name: "hardy" });
  assert.equal(loadClientConfig({ PARLEY_CONFIG: path, PARLEY_NAME: "other", PARLEY_URL: "http://localhost:9" }).name, "other");
  assert.throws(() => validateConfig({ url: "ftp://x", token: "t", name: "a" }), /http/);
  assert.throws(() => validateConfig({ url: "https://x", token: "t", name: "bad name" }), /invalid/);
  assert.throws(() => validateConfig({ url: "https://x", token: "t", name: "all" }), /reserved/);
  assert.throws(() => loadClientConfig({ PARLEY_CONFIG: join(dir, "missing.json") }), /parley init/);
  writeFileSync(join(dir, "broken.json"), "{");
  assert.throws(() => loadClientConfig({ PARLEY_CONFIG: join(dir, "broken.json") }), /could not parse/);
  assert.deepEqual(envThreads({ PARLEY_THREADS: "Auth-Refactor, deploy ,," }), ["auth-refactor", "deploy"]);
  assert.deepEqual(envThreads({}), []);
});

test("CLI: init, install (hook only), doctor, send/inbox/threads/peers, uninstall", async () => {
  const { hub, url } = await startHub();
  const dir = tmpDir();
  const env = { PARLEY_CONFIG: join(dir, ".parley.json"), CLAUDE_SETTINGS_PATH: join(dir, "settings.json") };
  try {
    assert.match((await run("dist/cli.js", ["token"])).stdout.trim(), /^[0-9a-f]{48}$/);
    assert.match((await run("dist/cli.js", ["help"])).stdout, /parley init/);
    assert.equal((await run("dist/cli.js", ["bogus"])).code, 1);

    const init = await run("dist/cli.js", ["init", "--url", url, "--token", TOKEN, "--name", "hardy"], { env });
    assert.equal(init.code, 0, init.stderr);
    assert.ok(existsSync(env.PARLEY_CONFIG));
    const again = await run("dist/cli.js", ["init", "--url", url], { env });
    assert.equal(again.code, 1, "refuses to clobber without --force");

    writeFileSync(env.CLAUDE_SETTINGS_PATH, JSON.stringify({ model: "x", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    const dry = await run("dist/cli.js", ["install", "--no-mcp", "--dry-run"], { env });
    assert.match(dry.stdout, /dry-run/);
    assert.equal(JSON.parse(readFileSync(env.CLAUDE_SETTINGS_PATH, "utf8")).hooks.UserPromptSubmit.length, 1, "dry run changes nothing");

    const inst = await run("dist/cli.js", ["install", "--no-mcp"], { env });
    assert.equal(inst.code, 0, inst.stderr);
    const settings = JSON.parse(readFileSync(env.CLAUDE_SETTINGS_PATH, "utf8"));
    assert.equal(settings.model, "x");
    assert.equal(settings.hooks.UserPromptSubmit.length, 2);
    assert.ok(settings.hooks.UserPromptSubmit[1].hooks[0].command.endsWith('hook.js"'));
    assert.ok(existsSync(env.CLAUDE_SETTINGS_PATH + ".parley-backup"));
    assert.match((await run("dist/cli.js", ["install", "--no-mcp"], { env })).stdout, /already present/);

    const doc = await run("dist/cli.js", ["doctor"], { env });
    assert.equal(doc.code, 0, doc.stdout + doc.stderr);
    assert.match(doc.stdout, /hub is up/);
    assert.match(doc.stdout, /token accepted/);
    assert.match(doc.stdout, /unread-message hook registered/);

    // a teammate talks to us through the CLI
    const bobEnv = { PARLEY_CONFIG: join(dir, "bob.json") };
    writeFileSync(bobEnv.PARLEY_CONFIG, JSON.stringify({ url, token: TOKEN, name: "bob" }));
    const sent = await run("dist/cli.js", ["send", "hardy", "hello", "from", "bob", "--thread", "chat"], { env: bobEnv });
    assert.match(sent.stdout, /sent #1 to hardy in thread "chat"/);
    const peek = await run("dist/cli.js", ["inbox", "--peek"], { env });
    assert.match(peek.stdout, /bob → hardy \(chat\)\nhello from bob/);
    const threads = await run("dist/cli.js", ["threads"], { env });
    assert.match(threads.stdout, /chat: 1 unread/);
    const read = await run("dist/cli.js", ["inbox"], { env });
    assert.match(read.stdout, /hello from bob/);
    assert.match((await run("dist/cli.js", ["inbox"], { env })).stdout, /no unread/);
    assert.match((await run("dist/cli.js", ["peers"], { env })).stdout, /bob: online/);

    // doctor flags a bad token
    const badEnv = { ...env, PARLEY_TOKEN: "x".repeat(40) };
    const bad = await run("dist/cli.js", ["doctor"], { env: badEnv });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /FAIL.*rejected the token/);

    const un = await run("dist/cli.js", ["uninstall"], { env });
    assert.equal(un.code, 0, un.stderr);
    const after = JSON.parse(readFileSync(env.CLAUDE_SETTINGS_PATH, "utf8"));
    assert.equal(after.hooks.UserPromptSubmit.length, 1);
    assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, "echo mine");
  } finally { await hub.close(); }
});

test("hub process: refuses to start without a token; serves, persists and shuts down gracefully", async () => {
  const noTok = await run("dist/hub.js", [], { env: {} });
  assert.equal(noTok.code, 1);
  assert.match(noTok.stderr, /PARLEY_TOKEN/);
  const short = await run("dist/hub.js", [], { env: { PARLEY_TOKEN: "short" } });
  assert.equal(short.code, 1);

  const { spawn } = await import("node:child_process");
  const dir = tmpDir();
  const data = join(dir, "d.jsonl");
  const start = async (port) => {
    const child = spawn(process.execPath, [resolve("dist/hub.js")], {
      env: { PATH: process.env.PATH, PARLEY_TOKEN: TOKEN, PORT: String(port), HOST: "127.0.0.1", PARLEY_DATA: data },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise((ok, no) => {
      child.stderr.on("data", (d) => String(d).includes("listening") && ok());
      child.once("exit", (c) => no(new Error(`hub exited early (${c})`)));
    });
    return child;
  };
  const port = 20000 + Math.floor(Math.random() * 20000);
  let child = await start(port);
  const url = `http://127.0.0.1:${port}`;
  try {
    const a = new HubClient(cfg(url, "a"));
    const b = new HubClient(cfg(url, "b"));
    await b.hello();
    await a.send("b", "survive me", "t");
    const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
    child.kill("SIGTERM");
    const { code, signal } = await exited;
    assert.ok(code === 0 || (process.platform === "win32" && (code === null || signal === "SIGTERM")), "clean exit on SIGTERM");
    child = await start(port);
    assert.equal((await b.inbox({})).messages[0].body, "survive me", "message persisted across restart");
  } finally { child.kill("SIGKILL"); }
});
