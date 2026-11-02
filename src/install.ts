import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type HookEntry = { type?: string; command?: string; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
export type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

const EVENT = "UserPromptSubmit";

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
}

export function hookCommand(distDir: string): string {
  return `node "${join(distDir, "hook.js")}"`;
}

/** Recognises a hook we installed, even if the checkout has moved since. */
function isParleyHook(h: HookEntry): boolean {
  const c = h.command ?? "";
  return c.includes("hook.js") && c.toLowerCase().includes("parley");
}

export function isHookInstalled(settings: Settings, command: string): boolean {
  return (settings.hooks?.[EVENT] ?? []).some((g) => (g.hooks ?? []).some((h) => h.command === command));
}

/** Adds (or refreshes) our UserPromptSubmit hook without touching anyone else's. Pure: returns a new object. */
export function addHook(settings: Settings, command: string): { settings: Settings; changed: boolean } {
  const next: Settings = structuredClone(settings);
  next.hooks ??= {};
  const groups = (next.hooks[EVENT] ??= []);
  let found = false;
  let changed = false;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (!isParleyHook(h)) continue;
      found = true;
      if (h.command !== command || h.type !== "command") {
        h.type = "command";
        h.command = command;
        changed = true;
      }
    }
  }
  if (!found) {
    groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    changed = true;
  }
  return { settings: next, changed };
}

export function removeHook(settings: Settings): { settings: Settings; changed: boolean } {
  const next: Settings = structuredClone(settings);
  const groups = next.hooks?.[EVENT];
  if (!groups) return { settings: next, changed: false };
  let changed = false;
  const kept: HookGroup[] = [];
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    const hooks = (g.hooks ?? []).filter((h) => !isParleyHook(h));
    if (hooks.length !== before) changed = true;
    if (hooks.length > 0 || before === 0) kept.push({ ...g, hooks });
  }
  if (kept.length) next.hooks![EVENT] = kept;
  else delete next.hooks![EVENT];
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed };
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("top level is not an object");
    return parsed as Settings;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}); fix it or remove it, then retry. Nothing was changed.`);
  }
}

export function writeSettings(path: string, settings: Settings): { backup?: string } {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.parley-backup`;
    if (!existsSync(backup)) copyFileSync(path, backup);
    else backup = undefined;
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { backup };
}
