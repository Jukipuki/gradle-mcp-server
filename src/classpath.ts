import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClasspathEntry {
  group: string;
  artifact: string;
  version: string;
  jarPath: string;
  direct: boolean;
}

interface CacheRecord {
  entries: ClasspathEntry[];
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

const BUILD_FILES = [
  "build.gradle.kts",
  "build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
];

function computeCacheKey(projectPath: string): string {
  const parts: string[] = [];
  for (const name of BUILD_FILES) {
    const p = join(projectPath, name);
    if (existsSync(p)) {
      parts.push(`${name}:${statSync(p).mtimeMs}`);
    }
  }
  return parts.join("|");
}

function parseClasspathOutput(stdout: string): ClasspathEntry[] {
  const seen = new Set<string>();
  const out: ClasspathEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("GMCP|")) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const flag = parts[1];
    const coords = parts[2];
    const jarPath = parts.slice(3).join("|");
    const coordParts = coords.split(":");
    if (coordParts.length !== 3) continue;
    const [group, artifact, version] = coordParts;
    const dedupKey = `${coords}|${jarPath}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ group, artifact, version, jarPath, direct: flag === "D" });
  }
  return out;
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

export async function resolveClasspath(projectPath: string): Promise<ClasspathEntry[]> {
  const gradlewPath = findGradleWrapper(projectPath);
  if (!gradlewPath) {
    throw new Error(
      `Gradle wrapper not found in ${projectPath} (looking for ${WRAPPER_NAME})`
    );
  }

  const key = computeCacheKey(projectPath);
  const cached = cache.get(projectPath);
  if (cached && cached.key === key) {
    return cached.entries;
  }

  const stdout = await runGradle(projectPath, gradlewPath);
  const entries = parseClasspathOutput(stdout);
  cache.set(projectPath, { entries, key });
  return entries;
}
