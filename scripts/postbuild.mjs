import { chmodSync, existsSync } from "node:fs";
for (const f of ["dist/cli.js", "dist/hub.js", "dist/mcp.js", "dist/hook.js"]) {
  if (existsSync(f)) {
    try { chmodSync(f, 0o755); } catch { /* not supported on this platform */ }
  }
}
