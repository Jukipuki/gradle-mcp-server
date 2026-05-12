import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClasspathEntry {
  group: string;
  artifact: string;
  version: string;
  jarPath: string;
}

interface CacheRecord {
  entries: ClasspathEntry[];
  key: string;
}

const cache = new Map<string, CacheRecord>();

const here = dirname(fileURLToPath(import.meta.url));
const INIT_SCRIPT_PATH = resolve(here, "init-script.gradle");

const GRADLE_TIMEOUT_MS = 60_000;

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
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const coords = line.slice(0, eq);
    const jarPath = line.slice(eq + 1);
    const parts = coords.split(":");
    if (parts.length !== 3) continue;
    const [group, artifact, version] = parts;
    const dedupKey = `${coords}|${jarPath}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ group, artifact, version, jarPath });
  }
  return out;
}

function runGradle(projectPath: string, gradlewPath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-q",
      "--init-script",
      INIT_SCRIPT_PATH,
      "printClasspathExternal",
    ];
    const child = execFile(
      gradlewPath,
      args,
      {
        cwd: projectPath,
        timeout: GRADLE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
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
  const gradlewPath = join(projectPath, "gradlew");
  if (!existsSync(gradlewPath)) {
    throw new Error(`Gradle wrapper not found at ${gradlewPath}`);
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
