import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./helpers/mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(here, "..", "dist", "index.js");
const PACKAGE_JSON = resolve(here, "..", "package.json");

const EXPECTED_TOOLS = [
  "resolve_external_class",
  "inspect_class",
  "list_dependencies",
  "find_dependency_version",
  "dependency_insight",
  "check_outdated",
];

let client;

before(async () => {
  client = new McpClient(process.execPath, [SERVER_ENTRY]);
  await client.start();
});

after(async () => {
  await client?.close();
});

test("serverInfo.version matches package.json", async () => {
  const init = await client.initializeResponse();
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  assert.equal(init.serverInfo.name, pkg.name);
  assert.equal(init.serverInfo.version, pkg.version);
});

test("tools/list returns all expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 0, `${t.name} missing description`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(Array.isArray(t.inputSchema.required), `${t.name} missing required[]`);
  }
});
