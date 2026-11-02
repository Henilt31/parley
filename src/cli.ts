#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, configPath, loadClientConfig, validateConfig, writeClientConfig } from "./shared/config.js";
import { VERSION, RelayError, parseRecipient, parseThread } from "./shared/protocol.js";
import { HubClient } from "./client/hub-client.js";
import { fmtTime, renderPeers, renderThreads } from "./client/format.js";
import { addHook, claudeSettingsPath, hookCommand, isHookInstalled, readSettings, removeHook, writeSettings } from "./install.js";
import { runHub } from "./hub/run.js";

const DIST = dirname(fileURLToPath(import.meta.url));
const MCP_NAME = "parley";

const USAGE = `parley ${VERSION}: let Claude Code sessions message each other

Hub (one person runs this):
  parley token                    print a fresh random token
  parley hub                      start the hub (env: PARLEY_TOKEN, PORT, HOST, PARLEY_DATA,
                                  PARLEY_MAX_MESSAGES, PARLEY_RATE_LIMIT, PARLEY_TRUST_PROXY)

Each teammate:
  parley init [--url U --token T --name N]   write ~/.parley.json (prompts for anything missing)
  parley install [--no-mcp] [--no-hook] [--dry-run]
                                  register the MCP server with Claude Code and add the unread hook
  parley uninstall                undo \`install\`
  parley doctor                   check config, hub, token and Claude Code wiring

From a terminal (no Claude needed):
  parley send <peer|all> <message...> [--thread T]
  parley inbox [--thread T[,T2]] [--wait SECONDS] [--peek]
  parley threads
  parley peers

Config file: ${configPath()}  (override with PARLEY_CONFIG; PARLEY_URL / PARLEY_TOKEN / PARLEY_NAME win over it)
`;

class UsageError extends Error {}

function client(): HubClient {
  return new HubClient(loadClientConfig());
}

function suggestName(): string {
  try {
    const n = userInfo().username.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
    return n || "me";
  } catch {
    return "me";
  }
}

async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, token: { type: "string" }, name: { type: "string" }, force: { type: "boolean" } },
  });
  const path = configPath();
  if (existsSync(path) && !values.force && !(values.url && values.token && values.name)) {
    throw new UsageError(`${path} already exists. Re-run with --force to overwrite, or pass --url, --token and --name together.`);
  }
  let { url, token, name } = values;
  if (!url || !token || !name) {
    if (!process.stdin.isTTY) throw new UsageError("missing --url, --token or --name (and stdin is not interactive)");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      url ||= (await rl.question("Hub URL (e.g. https://hub.example.com): ")).trim();
      token ||= (await rl.question("Shared token: ")).trim();
      const def = suggestName();
      name ||= (await rl.question(`Your name [${def}]: `)).trim() || def;
    } finally {
      rl.close();
    }
  }
  const cfg = validateConfig({ url, token, name });
  const written = writeClientConfig(cfg, path);
  console.log(`Wrote ${written} (owner-only permissions).`);
  if (new URL(cfg.url).protocol === "http:" && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(new URL(cfg.url).hostname)) {
    console.log("Warning: the hub URL is plain http on a public-looking host. Use https when the hub is on the internet.");
  }
  console.log("Next: `parley install` to wire it into Claude Code, then `parley doctor` to verify.");
}

function claudeCli(args: string[]): { ok: boolean; missing: boolean; output: string } {
  const win = process.platform === "win32";
  const res = win
    ? spawnSync(["claude", ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" "), { shell: true, encoding: "utf8" })
    : spawnSync("claude", args, { encoding: "utf8" });
  const missing = (res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (win && res.status === 1 && /not recognized/i.test(res.stderr ?? ""));
  return { ok: res.status === 0, missing: Boolean(missing), output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

async function cmdInstall(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { "no-mcp": { type: "boolean" }, "no-hook": { type: "boolean" }, "dry-run": { type: "boolean" } },
  });
  loadClientConfig(); // fail early with a helpful message if `parley init` has not been run
  const mcpPath = join(DIST, "mcp.js");
  const cmd = hookCommand(DIST);
  const addArgs = ["mcp", "add", "--scope", "user", MCP_NAME, "--", "node", mcpPath];
  const manual = `claude ${addArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;

  if (!values["no-mcp"]) {
    if (values["dry-run"]) {
      console.log(`[dry-run] would run: ${manual}`);
    } else {
      claudeCli(["mcp", "remove", "--scope", "user", MCP_NAME]); // ignore result: refresh if it was already registered
      const r = claudeCli(addArgs);
      if (r.missing) console.log(`The \`claude\` command was not found. Register the MCP server yourself:\n  ${manual}`);
      else if (!r.ok) console.log(`\`claude mcp add\` failed:\n${r.output}\nTry it manually:\n  ${manual}`);
      else console.log(`Registered MCP server "${MCP_NAME}" with Claude Code (user scope).`);
    }
  }

  if (!values["no-hook"]) {
    const path = claudeSettingsPath();
    const { settings, changed } = addHook(readSettings(path), cmd);
    if (values["dry-run"]) {
      console.log(`[dry-run] would ${changed ? "update" : "leave"} ${path} with hook: ${cmd}`);
    } else if (!changed) {
      console.log(`Unread-message hook already present in ${path}.`);
    } else {
      const { backup } = writeSettings(path, settings);
      console.log(`Added the unread-message hook to ${path}${backup ? ` (backup: ${backup})` : ""}.`);
    }
  }
  console.log("Restart Claude Code (or run /mcp) so it picks up the changes, then try: \"list my relay peers\".");
}

async function cmdUninstall(): Promise<void> {
  const r = claudeCli(["mcp", "remove", "--scope", "user", MCP_NAME]);
  if (r.missing) console.log(`\`claude\` not found; remove the "${MCP_NAME}" MCP server manually if you added it.`);
  else console.log(r.ok ? `Removed MCP server "${MCP_NAME}".` : `MCP server "${MCP_NAME}" was not registered (or could not be removed).`);
  const path = claudeSettingsPath();
  if (existsSync(path)) {
    const { settings, changed } = removeHook(readSettings(path));
    if (changed) {
      writeSettings(path, settings);
      console.log(`Removed the unread-message hook from ${path}.`);
    } else console.log("No parley hook found in Claude settings.");
  }
  console.log(`Your config at ${configPath()} was left in place.`);
}

async function cmdDoctor(): Promise<void> {
  let failures = 0;
  const pass = (msg: string) => console.log(`  ok    ${msg}`);
  const warn = (msg: string) => console.log(`  warn  ${msg}`);
  const bad = (msg: string) => {
    failures++;
    console.log(`  FAIL  ${msg}`);
  };

  console.log(`parley ${VERSION} doctor`);
  let cfg;
  try {
    cfg = loadClientConfig();
    pass(`config loaded from ${configPath()} (name: ${cfg.name}, hub: ${cfg.url})`);
  } catch (e) {
    bad((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const hubUrl = new URL(cfg.url);
  if (hubUrl.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hubUrl.hostname)) {
    warn("hub URL uses plain http; use https if it is reachable from the internet");
  }
  const c = new HubClient(cfg);
  try {
    const h = await c.health();
    pass(`hub is up (version ${h.version}, uptime ${h.uptimeSec}s)`);
    try {
      await c.hello();
      pass("token accepted and peer name registered");
      const { peers, serverTime } = await c.peers();
      pass(`${peers.length} peer(s) known: ${peers.map((p) => `${p.name}${p.online ? "*" : ""}`).join(", ") || "none"} (* = online, now ${fmtTime(serverTime)})`);
    } catch (e) {
      bad((e as Error).message);
    }
  } catch (e) {
    bad(`cannot reach hub: ${(e as Error).message}`);
  }
  for (const f of ["mcp.js", "hook.js"]) {
    if (existsSync(join(DIST, f))) pass(`dist/${f} present`);
    else bad(`dist/${f} missing; run \`npm run build\``);
  }
  const settingsPath = claudeSettingsPath();
  try {
    const installed = isHookInstalled(readSettings(settingsPath), hookCommand(DIST));
    if (installed) pass("unread-message hook registered in Claude settings");
    else warn("unread-message hook not registered (optional); run `parley install`");
  } catch (e) {
    warn((e as Error).message);
  }
  const list = claudeCli(["mcp", "list"]);
  if (list.missing) warn("`claude` command not found on PATH; skipped MCP registration check");
  else if (new RegExp(`^${MCP_NAME}\\b`, "m").test(list.output)) pass(`MCP server "${MCP_NAME}" is registered with Claude Code`);
  else warn(`MCP server "${MCP_NAME}" not found in \`claude mcp list\`; run \`parley install\``);
  console.log(failures ? `\n${failures} problem(s) found.` : "\nAll good.");
  if (failures) process.exitCode = 1;
}

async function cmdSend(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, options: { thread: { type: "string", short: "t" } }, allowPositionals: true });
  const [to, ...rest] = positionals;
  if (!to || rest.length === 0) throw new UsageError("usage: parley send <peer|all> <message...> [--thread T]");
  const r = await client().send(parseRecipient(to), rest.join(" "), parseThread(values.thread));
  console.log(`sent #${r.seq} to ${r.to} in thread "${r.thread}"${r.peerKnown ? "" : " (peer has not connected yet)"}`);
}

async function cmdInbox(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { thread: { type: "string", short: "t" }, wait: { type: "string", short: "w" }, peek: { type: "boolean" } },
  });
  const c = client();
  const threads = values.thread ? values.thread.split(",").map((t) => parseThread(t)) : null;
  const wait = values.wait ? Number.parseFloat(values.wait) : 0;
  if (!Number.isFinite(wait) || wait < 0) throw new UsageError("--wait must be a non-negative number of seconds");
  const res = values.peek ? await c.inboxOnce({ threads, peek: true, waitSeconds: wait }) : await c.inbox({ threads, waitSeconds: wait });
  if (res.messages.length === 0) {
    console.log("no unread messages");
    return;
  }
  for (const m of res.messages) console.log(`#${m.seq} [${fmtTime(m.ts)}] ${m.from} → ${m.to} (${m.thread})\n${m.body}\n`);
  if (res.remaining) console.log(`${res.remaining} more unread; run again.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "token":
      console.log(randomBytes(24).toString("hex"));
      return;
    case "hub":
      return runHub();
    case "init":
      return cmdInit(rest);
    case "install":
      return cmdInstall(rest);
    case "uninstall":
      return cmdUninstall();
    case "doctor":
      return cmdDoctor();
    case "send":
      return cmdSend(rest);
    case "inbox":
      return cmdInbox(rest);
    case "threads": {
      const c = client();
      console.log(renderThreads(await c.threads(), () => true));
      return;
    }
    case "peers": {
      const c = client();
      const { peers, serverTime } = await c.peers();
      console.log(renderPeers(peers, c.name, serverTime));
      return;
    }
    default:
      throw new UsageError(`unknown command "${cmd}". Run \`parley help\`.`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof UsageError || e instanceof ConfigError || e instanceof RelayError) {
    console.error(`parley: ${(e as Error).message}`);
  } else if ((e as { code?: string })?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (e as { code?: string })?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    console.error(`parley: ${(e as Error).message}`);
  } else {
    console.error("parley: unexpected error:", e);
  }
  process.exit(1);
});
