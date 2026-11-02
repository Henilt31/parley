import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../dist/hub/server.js";

export const TOKEN = "t".repeat(48);

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), "parley-test-"));
}

export async function startHub(extra = {}) {
  const hub = createHub({ token: TOKEN, port: 0, host: "127.0.0.1", ...extra });
  const { port } = await hub.listen();
  return { hub, url: `http://127.0.0.1:${port}` };
}

export function cfg(url, name) {
  return { url, token: TOKEN, name };
}

export async function raw(url, path, { method = "GET", peer, token = TOKEN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (peer) h["x-parley-peer"] = peer;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, headers: res.headers };
}
