#!/usr/bin/env node
import { runHub } from "./hub/run.js";

runHub().catch((e) => {
  console.error(e);
  process.exit(1);
});
