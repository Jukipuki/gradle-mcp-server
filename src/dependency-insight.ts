import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const INSIGHT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface DependencyInsightResult {
  found: boolean;
  dependency: string;
  subproject: string | null;
  raw: string;
  truncated: boolean;
  requestedBy: string[];
  error?: string;
}

function parseRequestedBy(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("\\---") && !line.startsWith("+---")) continue;
    // dependencyInsight output uses arrows; just collect candidate lines
    out.push(line);
  }
  return out;
}

export async function runDependencyInsight(
  projectPath: string,
  dependency: string,
  subproject: string | null
): Promise<DependencyInsightResult> {
  const gradlewPath = join(projectPath, "gradlew");
  if (!existsSync(gradlewPath)) {
    return {
      found: false,
      dependency,
      subproject,
      raw: "",
      truncated: false,
      requestedBy: [],
      error: `Gradle wrapper not found at ${gradlewPath}`,
    };
  }

  const task = subproject ? `${subproject}:dependencyInsight` : "dependencyInsight";
  const args = [
    "-q",
    task,
    "--configuration",
    "compileClasspath",
    "--dependency",
    dependency,
  ];

  return new Promise((resolvePromise) => {
    execFile(
      gradlewPath,
      args,
      {
        cwd: projectPath,
        timeout: INSIGHT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            resolvePromise({
              found: false,
              dependency,
              subproject,
              raw: "",
              truncated: false,
              requestedBy: [],
              error: `dependencyInsight timed out after ${INSIGHT_TIMEOUT_MS / 1000}s`,
            });
            return;
          }
          const msg = stderr?.toString().trim() || err.message;
          resolvePromise({
            found: false,
            dependency,
            subproject,
            raw: "",
            truncated: false,
            requestedBy: [],
            error: `dependencyInsight failed: ${msg}`,
          });
          return;
        }
        const full = stdout.toString();
        const truncated = full.length > MAX_OUTPUT_BYTES;
        const raw = truncated ? full.slice(0, MAX_OUTPUT_BYTES) : full;
        resolvePromise({
          found: true,
          dependency,
          subproject,
          raw,
          truncated,
          requestedBy: parseRequestedBy(full),
        });
      }
    );
  });
}
