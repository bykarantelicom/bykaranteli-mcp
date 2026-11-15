import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { nodeVersionProblem } from "../dist/node-version.js";
import { registerByKaranteliTools } from "../dist/tools.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FAKE_NODE_18 = fileURLToPath(new URL("./fixtures/fake-node-18.mjs", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const line = (needed, running) =>
  `bykaranteli-mcp needs Node.js ${needed} or newer, and this is Node.js ${running}. Install a current Node.js (https://nodejs.org) and start the server again.`;

test("nodeVersionProblem names the needed and the running Node.js, and stays quiet when it cannot read either", () => {
  assert.equal(nodeVersionProblem("18.19.1", ">=20"), line(20, "18.19.1"));
  assert.equal(nodeVersionProblem("v18.0.0", ">=20"), line(20, "18.0.0"));
  assert.equal(nodeVersionProblem("20.0.0", ">=20"), null);
  assert.equal(nodeVersionProblem("22.3.0", ">=20"), null);
  assert.equal(nodeVersionProblem("20.11.1", ">=20.11.0"), null);
  assert.equal(nodeVersionProblem("19.9.0", ">=20.11.0"), line(20, "19.9.0"));
  assert.equal(nodeVersionProblem("", ">=20"), null);
  assert.equal(nodeVersionProblem("abc", ">=20"), null);
  assert.equal(nodeVersionProblem("18.0.0", "^20"), null);
  assert.equal(nodeVersionProblem("18.0.0", ""), null);
  const text = line(20, "18.19.1");
  assert.ok(!/[\u2013\u2014\n]/.test(text), "one line, no long or middle dash");
});

test("package.json engines.node has the >=N form the check reads, so the check is live", () => {
  assert.match(PKG.engines?.node ?? "", /^\s*>=\s*\d+/);
  assert.notEqual(nodeVersionProblem("1.0.0", PKG.engines.node), null);
});

function run(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit within 10 s; stderr: ${stderr}`));
    }, 10_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

test("on an old Node.js the server says one line on stderr, writes nothing on stdout and exits 1", async () => {
  const { code, stdout, stderr } = await run(["--import", FAKE_NODE_18, ENTRY], { input: "" });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr.replace(/\r?\n$/, ""), line(20, "18.19.1"));
});

test("on a current Node.js the server answers initialize and tools/list with every registered tool", async () => {
  let registered = 0;
  registerByKaranteliTools({ registerTool: () => { registered += 1; } }, { baseUrl: "http://127.0.0.1:1", publicUrl: "https://bykaranteli.com", version: "test" });
  assert.ok(registered > 0);

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BYKARANTELI_BASE_URL: "http://127.0.0.1:1" },
  });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr}`)), 10_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "entry-test", version: "0.0.0" } });
    assert.equal(init.result?.serverInfo?.name, "bykaranteli");
    assert.equal(init.result?.serverInfo?.version, PKG.version);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const list = await rpc("tools/list", {});
    assert.equal(list.result?.tools?.length, registered);
    assert.match(stderr, /bykaranteli-mcp ready \(base: /);
  } finally {
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(killer);
  }
});

const staticSpecifiers = (src) =>
  [...src.matchAll(/^\s*(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);

test("dist/index.js imports nothing statically beyond node:module and ./node-version.js; dist/node-version.js imports nothing", () => {
  const entry = readFileSync(ENTRY, "utf8");
  assert.deepEqual([...new Set(staticSpecifiers(entry))].sort(), ["./node-version.js", "node:module"]);
  const check = readFileSync(new URL("../dist/node-version.js", import.meta.url), "utf8");
  assert.ok(!/\bimport\b/.test(check), "dist/node-version.js carries no import");
});
