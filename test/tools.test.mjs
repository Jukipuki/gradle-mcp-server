import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient } from "./helpers/mcp-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(here, "..", "dist", "index.js");
// Fixture is selectable so the same suite runs against multiple Gradle/JDK
// combinations in CI (e.g. Gradle 8.5/JDK17 and Gradle 9.5.1/JDK25). Both
// fixtures declare the same guava + junit dependencies, so every assertion
// below is fixture-agnostic.
const FIXTURE = resolve(here, "fixtures", process.env.GMCP_FIXTURE ?? "sample-project");

const GUAVA_CLASS = "com.google.common.collect.ImmutableList";
const GUAVA_GROUP = "com.google.guava";
const GUAVA_ARTIFACT = "guava";

let client;
let guavaJarPath;

before(async () => {
  client = new McpClient(process.execPath, [SERVER_ENTRY]);
  await client.start();
});

after(async () => {
  await client?.close();
});

test("resolve_external_class finds guava class with main source set", async () => {
  const res = await client.callTool("resolve_external_class", {
    projectPath: FIXTURE,
    className: GUAVA_CLASS,
  });
  assert.equal(res.found, true, `expected found, got ${JSON.stringify(res)}`);
  assert.equal(res.className, GUAVA_CLASS);
  assert.match(res.artifact, /^com\.google\.guava:guava:/);
  assert.ok(res.jarPath.endsWith(".jar"));
  assert.ok(Array.isArray(res.methods) && res.methods.length > 0);
  assert.ok(Array.isArray(res.fields));
  assert.equal(typeof res.isInterface, "boolean");
  guavaJarPath = res.jarPath;
});

test("inspect_class returns same structure given a known JAR", async () => {
  assert.ok(guavaJarPath, "expected guavaJarPath from previous test");
  const res = await client.callTool("inspect_class", {
    jarPath: guavaJarPath,
    className: GUAVA_CLASS,
  });
  assert.equal(res.found, true);
  assert.equal(res.className, GUAVA_CLASS);
  assert.ok(res.methods.length > 0);
  assert.equal(res.jarPath, guavaJarPath);
});

test("list_dependencies includes guava on main source set (regression: CompileClasspath case bug)", async () => {
  const res = await client.callTool("list_dependencies", { projectPath: FIXTURE });
  assert.ok(res.count > 0, "expected at least one dependency");
  const guava = res.dependencies.find(
    (d) => d.group === GUAVA_GROUP && d.artifact === GUAVA_ARTIFACT
  );
  assert.ok(guava, `guava missing from list_dependencies: ${JSON.stringify(res.dependencies.map((d) => d.artifact))}`);
  assert.equal(guava.direct, true);
  assert.ok(
    guava.sourceSets.includes("main"),
    `guava missing 'main' source set — got ${JSON.stringify(guava.sourceSets)}`
  );
  // Broader regression guard: at least one entry must have 'main'. If none do,
  // the init script silently dropped compileClasspath (the original bug).
  assert.ok(
    res.dependencies.some((d) => d.sourceSets.includes("main")),
    "no dependency has 'main' source set — compileClasspath was silently dropped"
  );
  assert.ok(!res.warnings, `unexpected warnings: ${JSON.stringify(res.warnings)}`);
});

test("list_dependencies with directOnly returns only declared deps", async () => {
  const res = await client.callTool("list_dependencies", { projectPath: FIXTURE, directOnly: true });
  for (const d of res.dependencies) {
    assert.equal(d.direct, true, `non-direct dep leaked in directOnly: ${d.group}:${d.artifact}`);
  }
  assert.ok(res.dependencies.some((d) => d.artifact === GUAVA_ARTIFACT));
});

test("find_dependency_version matches by artifact substring", async () => {
  const res = await client.callTool("find_dependency_version", {
    projectPath: FIXTURE,
    query: "guava",
  });
  assert.equal(res.query, "guava");
  assert.ok(res.count >= 1);
  const guava = res.matches.find((m) => m.artifact === GUAVA_ARTIFACT);
  assert.ok(guava, "guava missing from find_dependency_version result");
  assert.match(guava.version, /^\d+\.\d+/);
});

test("find_dependency_version matches by group substring (case-insensitive)", async () => {
  const res = await client.callTool("find_dependency_version", {
    projectPath: FIXTURE,
    query: "GOOGLE",
  });
  assert.ok(res.matches.some((m) => m.group.startsWith("com.google")));
});

test("dependency_insight reports resolution chain for guava", async () => {
  const res = await client.callTool("dependency_insight", {
    projectPath: FIXTURE,
    dependency: "guava",
  });
  assert.equal(res.found, true, `dependency_insight failed: ${JSON.stringify(res)}`);
  assert.equal(res.dependency, "guava");
  assert.match(res.raw, /guava/);
});

test("check_outdated returns a well-formed response for direct deps", async () => {
  const res = await client.callTool("check_outdated", { projectPath: FIXTURE });
  assert.equal(typeof res.checked, "number");
  assert.equal(typeof res.outdatedCount, "number");
  assert.ok(Array.isArray(res.outdated));
  // Don't assert outdatedCount > 0 — pins are deliberate; just verify shape.
  for (const o of res.outdated) {
    assert.equal(typeof o.group, "string");
    assert.equal(typeof o.artifact, "string");
    assert.equal(typeof o.current, "string");
    assert.equal(typeof o.latest, "string");
    assert.equal(o.outdated, true);
  }
});
