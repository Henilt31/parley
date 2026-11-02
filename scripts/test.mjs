import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).sort().map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
