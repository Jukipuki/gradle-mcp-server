import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Import compiled output — build must have run before this suite.
const { compareVersions, isPrerelease, checkOutdated } = await import(
  resolve(here, "..", "dist", "maven-central.js")
);

// ---------- Pure function tests (no network) ----------

test("compareVersions: equal versions return 0", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.0.1", "0.0.1"), 0);
});

test("compareVersions: older < newer (numeric ordering, not lexicographic)", () => {
  assert.ok(compareVersions("1.0.0", "2.0.0") < 0);
  assert.ok(compareVersions("1.9.0", "1.10.0") < 0, "9 < 10 numerically");
  assert.ok(compareVersions("33.0.0-jre", "33.4.8-jre") < 0);
});

test("compareVersions: newer > older", () => {
  assert.ok(compareVersions("2.0.0", "1.0.0") > 0);
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0);
});

test("isPrerelease: recognises common pre-release qualifiers", () => {
  assert.equal(isPrerelease("1.0.0-SNAPSHOT"), true);
  assert.equal(isPrerelease("1.0.0-alpha1"), true);
  assert.equal(isPrerelease("1.0.0-beta"), true);
  assert.equal(isPrerelease("1.0.0-RC1"), true);
  assert.equal(isPrerelease("1.0.0-preview"), true);
  assert.equal(isPrerelease("2.0.0.M1"), true);
});

test("isPrerelease: stable versions return false", () => {
  assert.equal(isPrerelease("1.0.0"), false);
  assert.equal(isPrerelease("33.0.0-jre"), false, "jre classifier is not a pre-release marker");
});

// ---------- checkOutdated with mocked fetch ----------
// Each test uses a unique group:artifact to avoid cross-test cache hits.

function mavenCentralHit(version) {
  return {
    ok: true,
    json: async () => ({ response: { docs: [{ latestVersion: version }] } }),
  };
}

function mavenCentralMiss() {
  return {
    ok: true,
    json: async () => ({ response: { docs: [] } }),
  };
}

function mavenMetadataHit(release) {
  return {
    ok: true,
    text: async () =>
      `<metadata><versioning><release>${release}</release></versioning></metadata>`,
  };
}

function notFound() {
  return { ok: false };
}

test("checkOutdated: returns outdated entry when Maven Central has a newer version", async () => {
  const m = mock.method(globalThis, "fetch", async () => mavenCentralHit("3.0.0"));
  try {
    const results = await checkOutdated(
      [{ group: "com.test.a", artifact: "mc-hit", version: "1.0.0" }],
      []
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].latest, "3.0.0");
    assert.equal(results[0].outdated, true);
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: falls back to declared repo when Maven Central misses", async () => {
  const REPO = "https://internal.example.com/artifactory/libs-release";
  const m = mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("search.maven.org")) return mavenCentralMiss();
    if (url.includes("internal.example.com")) return mavenMetadataHit("2.5.0");
    return notFound();
  });
  try {
    const results = await checkOutdated(
      [{ group: "com.test.b", artifact: "internal-lib", version: "1.0.0" }],
      [REPO]
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].latest, "2.5.0");
    assert.equal(results[0].outdated, true);
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: constructs correct maven-metadata.xml URL from group and artifact", async () => {
  const REPO = "https://internal.example.com/artifactory/libs-release";
  const calls = [];
  const m = mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url.includes("search.maven.org")) return mavenCentralMiss();
    return mavenMetadataHit("1.2.3");
  });
  try {
    await checkOutdated(
      [{ group: "com.example.group", artifact: "my-artifact", version: "0.9.0" }],
      [REPO]
    );
    const metadataCall = calls.find((u) => u.includes("internal.example.com"));
    assert.ok(metadataCall, "expected a call to the internal repo");
    assert.ok(
      metadataCall.endsWith("/com/example/group/my-artifact/maven-metadata.xml"),
      `unexpected URL: ${metadataCall}`
    );
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: skips file:// repos and Maven Central mirror URLs in fallback", async () => {
  const calls = [];
  const m = mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return mavenCentralMiss();
  });
  try {
    await checkOutdated(
      [{ group: "com.test.c", artifact: "skip-repos", version: "1.0.0" }],
      [
        "file:///home/user/.m2/repository",
        "https://repo.maven.apache.org/maven2/",
        "https://repo1.maven.org/maven2/",
      ]
    );
    // Only the Maven Central search API should have been called; all three
    // declared repos must be skipped (file:// and Maven Central mirrors).
    assert.equal(calls.length, 1, `expected 1 fetch call, got: ${JSON.stringify(calls)}`);
    assert.ok(calls[0].includes("search.maven.org"));
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: dep absent from all repos is excluded from results", async () => {
  const m = mock.method(globalThis, "fetch", async () => notFound());
  try {
    const results = await checkOutdated(
      [{ group: "com.test.d", artifact: "nowhere", version: "1.0.0" }],
      ["https://internal.example.com/repo"]
    );
    assert.equal(results.length, 0);
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: dep already on latest version has outdated:false", async () => {
  const m = mock.method(globalThis, "fetch", async () => mavenCentralHit("1.0.0"));
  try {
    const results = await checkOutdated(
      [{ group: "com.test.e", artifact: "up-to-date", version: "1.0.0" }],
      []
    );
    // checkOutdated returns all resolved entries; callers filter by r.outdated.
    assert.equal(results.length, 1);
    assert.equal(results[0].outdated, false);
  } finally {
    m.mock.restore();
  }
});

test("checkOutdated: pre-release latest is skipped when current is stable", async () => {
  const m = mock.method(globalThis, "fetch", async () => mavenCentralHit("2.0.0-SNAPSHOT"));
  try {
    const results = await checkOutdated(
      [{ group: "com.test.f", artifact: "stable-dep", version: "1.0.0" }],
      []
    );
    assert.equal(results.length, 0, "should not suggest a SNAPSHOT upgrade for a stable dep");
  } finally {
    m.mock.restore();
  }
});
