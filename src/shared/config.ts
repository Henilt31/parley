import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NAME_RE, parseName, parseThread } from "./protocol.js";

export interface ClientConfig {
  url: string;
  token: string;
  name: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PARLEY_CONFIG && env.PARLEY_CONFIG.trim() !== ""
    ? env.PARLEY_CONFIG
    : join(homedir(), ".parley.json");
}

export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError(`"${raw}" is not a valid URL (expected something like https://hub.example.com)`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ConfigError(`hub URL must start with http:// or https:// (got ${u.protocol})`);
  }
  return u.toString().replace(/\/+$/, "");
}

export function validateConfig(raw: Partial<ClientConfig>): ClientConfig {
  if (!raw.url) throw new ConfigError("hub url is missing");
  if (!raw.token) throw new ConfigError("token is missing");
  if (!raw.name) throw new ConfigError("name is missing");
  let name: string;
  try {
    name = parseName(raw.name, "name");
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  if (!NAME_RE.test(name)) throw new ConfigError("name is invalid");
  return { url: normalizeUrl(raw.url), token: String(raw.token).trim(), name };
}

/** Reads the config file (if present) and lets PARLEY_URL / PARLEY_TOKEN / PARLEY_NAME override it. */
export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const path = configPath(env);
  let fromFile: Partial<ClientConfig> = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, "utf8")) as Partial<ClientConfig>;
    } catch (e) {
      throw new ConfigError(`could not parse ${path}: ${(e as Error).message}`);
    }
  }
  const merged: Partial<ClientConfig> = {
    url: env.PARLEY_URL || fromFile.url,
    token: env.PARLEY_TOKEN || fromFile.token,
    name: env.PARLEY_NAME || fromFile.name,
  };
  if (!merged.url && !merged.token && !merged.name && !existsSync(path)) {
    throw new ConfigError(`no configuration found. Run \`parley init\` (expected ${path})`);
  }
  try {
    return validateConfig(merged);
  } catch (e) {
    throw new ConfigError(`${(e as Error).message} (config: ${path})`);
  }
}

export function writeClientConfig(cfg: ClientConfig, path = configPath()): string {
  const clean = validateConfig(cfg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return path;
}

/** Threads a session should follow from the start, from PARLEY_THREADS="a,b". Empty = all. */
export function envThreads(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PARLEY_THREADS;
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    if (part.trim() === "") continue;
    out.add(parseThread(part));
  }
  return [...out];
}
