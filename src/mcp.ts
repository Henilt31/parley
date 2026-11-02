#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { envThreads, loadClientConfig } from "./shared/config.js";
import { HubClient } from "./client/hub-client.js";
import { Session } from "./client/session.js";
import { createMcpServer } from "./client/mcp-server.js";

const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  // stdout belongs to the MCP protocol; everything human-readable goes to stderr.
  let cfg;
  let initial: string[];
  try {
    cfg = loadClientConfig();
    initial = envThreads();
  } catch (e) {
    console.error(`[parley] ${(e as Error).message}`);
    process.exit(1);
  }
  const client = new HubClient(cfg);
  const session = new Session(initial);
  const server = createMcpServer(client, session);
  await server.connect(new StdioServerTransport());

  // Announce ourselves so peers see us online before our first tool call, then keep presence fresh.
  client.hello().catch((e: Error) => console.error(`[parley] hub not reachable yet: ${e.message}`));
  setInterval(() => client.hello().catch(() => {}), HEARTBEAT_MS).unref();
  process.stdin.on("close", () => process.exit(0));
}

main().catch((e) => {
  console.error("[parley] fatal:", e);
  process.exit(1);
});
