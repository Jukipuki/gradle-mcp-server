import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClasspathEntry {
  group: string;
  artifact: string;
  version: string;
  jarPath: string;
  direct: boolean;
  sourceSets: string[];
}

export interface ResolveError {
  projectPath: string;
  configuration: string;
  phase: string;
  message: string;
}

export interface ClasspathResult {
  entries: ClasspathEntry[];
  errors: ResolveError[];
  repos: string[];
}

interface CacheRecord {
  result: ClasspathResult;
  key: string;
}

const cache = new Map<string, CacheRecord>();

const here = dirname(fileURLToPath(import.meta.url));
const INIT_SCRIPT_PATH = resolve(here, "init-script.gradle");

const GRADLE_TIMEOUT_MS = 60_000;

const IS_WINDOWS = process.platform === "win32";
const WRAPPER_NAME = IS_WINDOWS ? "gradlew.bat" : "gradlew";

export function findGradleWrapper(projectPath: string): string | null {
  const candidate = join(projectPath, WRAPPER_NAME);
  return existsSync(candidate) ? candidate : null;
}

export function gradleSpawnOptions(cwd: string, timeoutMs: number = GRADLE_TIMEOUT_MS) {
  return {
    cwd,
    shell: IS_WINDOWS as boolean,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  };
}

const BUILD_FILE_RE = /\.gradle(\.kts)?$/;
const SKIP_DIRS = new Set([
  "build",
  ".gradle",
  ".git",
  "node_modules",
  "out",
  "target",
  ".idea",
]);
const MAX_SCAN_DEPTH = 8;

function collectBuildFiles(root: string, out: string[], depth: number): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      collectBuildFiles(join(root, e.name), out, depth + 1);
    } else if (e.isFile() && BUILD_FILE_RE.test(e.name)) {
      out.push(join(root, e.name));
    }
  }
}

function computeCacheKey(projectPath: string): string {
  const files: string[] = [];
  collectBuildFiles(projectPath, files, 0);
  files.sort();
  const parts: string[] = [];
  for (const f of files) {
    try {
      parts.push(`${f}:${statSync(f).mtimeMs}`);
    } catch {
      // skipped — file vanished between readdir and stat
    }
  }
  return parts.join("|");
}

function parseClasspathOutput(stdout: string): ClasspathResult {
  const byKey = new Map<string, ClasspathEntry>();
  const errors: ResolveError[] = [];
  const repoSet = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("GMCP-REPO|")) {
      const url = line.slice("GMCP-REPO|".length);
      if (url) repoSet.add(url);
      continue;
    }
    if (line.startsWith("GMCP-ERROR|")) {
      const parts = line.split("|");
      if (parts.length >= 5) {
        errors.push({
          projectPath: parts[1],
          configuration: parts[2],
          phase: parts[3],
          message: parts.slice(4).join("|"),
        });
      }
      continue;
    }
    if (!line.startsWith("GMCP|")) continue;
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const flag = parts[1];
    const coords = parts[2];
    const sourceSets = parts[3].split(",").filter((s) => s.length > 0);
    const jarPath = parts.slice(4).join("|");
    const coordParts = coords.split(":");
    if (coordParts.length !== 3) continue;
    const [group, artifact, version] = coordParts;
    const dedupKey = `${coords}|${jarPath}`;
    const existing = byKey.get(dedupKey);
    if (existing) {
      if (flag === "D") existing.direct = true;
      for (const s of sourceSets) {
        if (!existing.sourceSets.includes(s)) existing.sourceSets.push(s);
      }
      continue;
    }
    byKey.set(dedupKey, {
      group,
      artifact,
      version,
      jarPath,
      direct: flag === "D",
      sourceSets: [...sourceSets],
    });
  }
  return { entries: [...byKey.values()], errors, repos: [...repoSet] };
}

function runGradle(projectPath: string, gradlewPath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-q",
      "--init-script",
      INIT_SCRIPT_PATH,
      "printGradleMcpInfo",
    ];
    const child = execFile(
      gradlewPath,
      args,
      gradleSpawnOptions(projectPath),
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            rejectPromise(new Error(`Gradle invocation timed out after ${GRADLE_TIMEOUT_MS / 1000}s`));
            return;
          }
          const msg = stderr?.toString().trim() || err.message;
          rejectPromise(new Error(`Gradle failed: ${msg}`));
          return;
        }
        resolvePromise(stdout.toString());
      }
    );
    child.on("error", (e) => rejectPromise(e));
  });
}

export async function resolveClasspath(projectPath: string): Promise<ClasspathResult> {
  const gradlewPath = findGradleWrapper(projectPath);
  if (!gradlewPath) {
    throw new Error(
      `Gradle wrapper not found in ${projectPath} (looking for ${WRAPPER_NAME})`
    );
  }

  const key = computeCacheKey(projectPath);
  const cached = cache.get(projectPath);
  if (cached && cached.key === key) {
    return cached.result;
  }

  const stdout = await runGradle(projectPath, gradlewPath);
  const result = parseClasspathOutput(stdout);
  if (result.errors.length === 0) {
    cache.set(projectPath, { result, key });
  } else {
    cache.delete(projectPath);
  }
  return result;
}
