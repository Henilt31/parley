import { resolve } from "node:path";
import { createHub } from "./server.js";

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer (got "${raw}")`);
  return n;
}

/** Starts the hub from environment variables and keeps it running until SIGINT/SIGTERM. */
export async function runHub(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = env.PARLEY_TOKEN;
  if (!token) {
    console.error("PARLEY_TOKEN is not set. Generate one with `parley token` (or `openssl rand -hex 24`) and export it.");
    process.exit(1);
  }
  const dataFile = resolve(env.PARLEY_DATA ?? "parley-data.jsonl");
  let hub;
  try {
    hub = createHub({
      token,
      port: intEnv(env, "PORT", 8787),
      host: env.HOST || "0.0.0.0",
      dataFile,
      maxMessages: intEnv(env, "PARLEY_MAX_MESSAGES", 2000),
      rateLimitPerMinute: intEnv(env, "PARLEY_RATE_LIMIT", 120),
      trustProxy: env.PARLEY_TRUST_PROXY === "1",
      log: (line) => console.error(`[parley-hub] ${new Date().toISOString()} ${line}`),
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { host, port } = await hub.listen();
  console.error(`[parley-hub] listening on http://${host}:${port}  (journal: ${dataFile}, ${hub.store.messageCount} stored messages)`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[parley-hub] ${signal} received, shutting down`);
    hub.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
