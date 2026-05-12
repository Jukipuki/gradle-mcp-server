#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { resolveClasspath } from "./classpath.js";
import { findJarForClass } from "./jar-scanner.js";
import { inspectClassInJar } from "./class-info.js";
import { runDependencyInsight } from "./dependency-insight.js";
import { checkOutdated } from "./maven-central.js";

// ---------- Schemas ----------

const ResolveExternalClassInput = z.object({
  projectPath: z.string().min(1),
  className: z.string().min(1),
  includePrivate: z.boolean().optional().default(false),
});

const InspectClassInput = z.object({
  jarPath: z.string().min(1),
  className: z.string().min(1),
  includePrivate: z.boolean().optional().default(false),
});

const ListDependenciesInput = z.object({
  projectPath: z.string().min(1),
  directOnly: z.boolean().optional().default(false),
});

const FindDependencyVersionInput = z.object({
  projectPath: z.string().min(1),
  query: z.string().min(1),
});

const DependencyInsightInput = z.object({
  projectPath: z.string().min(1),
  dependency: z.string().min(1),
  subproject: z.string().optional(),
});

const CheckOutdatedInput = z.object({
  projectPath: z.string().min(1),
  includeTransitive: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
});

// ---------- Tool definitions for ListTools ----------

const TOOL_DEFS = [
  {
    name: "resolve_external_class",
    description:
      "Resolve and inspect a class from external Gradle dependencies when you DON'T know which JAR contains it. Given a fully-qualified class name (e.g. com.example.Foo), returns artifact coordinates plus complete class structure: fields with types and access modifiers, method signatures, whether it's a record/interface/abstract class, builder detection. USE THIS INSTEAD of find/grep/jar/javap commands. If you already know the JAR path, use `inspect_class` instead to skip classpath resolution.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the Gradle project root" },
        className: { type: "string", description: "Fully-qualified class name, e.g. com.example.Foo" },
        includePrivate: { type: "boolean", description: "Include private members", default: false },
      },
      required: ["projectPath", "className"],
    },
  },
  {
    name: "inspect_class",
    description:
      "Inspect a class given a JAR path you ALREADY know. Same output as `resolve_external_class` (fields, methods, modifiers, record/interface/abstract flags, builder detection) but skips Gradle classpath resolution — much faster. Use this when you already have the JAR path from a prior `resolve_external_class` result, `list_dependencies` call, or other source. For unknown JAR locations, use `resolve_external_class` instead.",
    inputSchema: {
      type: "object",
      properties: {
        jarPath: { type: "string", description: "Absolute path to the JAR file" },
        className: { type: "string", description: "Fully-qualified class name, e.g. com.example.Foo" },
        includePrivate: { type: "boolean", description: "Include private members", default: false },
      },
      required: ["jarPath", "className"],
    },
  },
  {
    name: "list_dependencies",
    description:
      "List all resolved external dependencies on the project's compileClasspath. Returns each artifact's group, name, version, JAR path, and whether it's a direct (declared) or transitive dependency. Use this when exploring what libraries are available without a specific class name in mind, or to feed JAR paths into `inspect_class`.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the Gradle project root" },
        directOnly: { type: "boolean", description: "Only return first-level (direct) dependencies", default: false },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "find_dependency_version",
    description:
      "Find resolved versions of dependencies whose group or artifact name matches a substring query. Use to quickly answer 'what version of X do I have?' — e.g. query 'jackson' returns all jackson-* artifacts with their resolved versions. Much cheaper than `list_dependencies` when you have a specific library in mind.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the Gradle project root" },
        query: { type: "string", description: "Substring to match against group or artifact name (case-insensitive)" },
      },
      required: ["projectPath", "query"],
    },
  },
  {
    name: "dependency_insight",
    description:
      "Explain WHY a specific artifact is on the classpath. Runs Gradle's `dependencyInsight` task and returns the resolution chain — which direct dependency requested it, version conflicts, transitive paths. Use when you need to understand or debug how a particular library/version ended up in the build.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the Gradle project root" },
        dependency: { type: "string", description: "Artifact to inspect — partial name or group:artifact" },
        subproject: { type: "string", description: "Optional subproject path like ':app' (defaults to root)" },
      },
      required: ["projectPath", "dependency"],
    },
  },
  {
    name: "check_outdated",
    description:
      "Compare resolved dependency versions against the latest available on Maven Central. Returns artifacts that have newer versions. By default checks only direct (first-level) dependencies — set `includeTransitive: true` to check all. Useful for upgrade planning.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the Gradle project root" },
        includeTransitive: { type: "boolean", description: "Also check transitive dependencies", default: false },
        limit: { type: "number", description: "Cap the number of dependencies checked (useful for very large projects)" },
      },
      required: ["projectPath"],
    },
  },
] as const;

// ---------- Tool implementations ----------

async function toolResolveExternalClass(args: z.infer<typeof ResolveExternalClassInput>) {
  const { projectPath, className, includePrivate } = args;
  if (!isAbsolute(projectPath)) {
    return { found: false, className, error: `projectPath must be absolute: ${projectPath}` };
  }
  let classpath;
  try {
    classpath = await resolveClasspath(projectPath);
  } catch (e) {
    return { found: false, className, error: (e as Error).message };
  }
  if (classpath.length === 0) {
    return {
      found: false,
      className,
      error: "No external compileClasspath entries resolved. Is this a Gradle project with dependencies?",
    };
  }
  const { hit, searched } = findJarForClass(classpath, className);
  if (!hit) {
    return { found: false, className, searched };
  }
  const result = await inspectClassInJar(hit.entry.jarPath, className, includePrivate);
  if (!result.found) {
    return { found: false, className, error: result.error };
  }
  return {
    found: true,
    artifact: `${hit.entry.group}:${hit.entry.artifact}:${hit.entry.version}`,
    ...result.info,
  };
}

async function toolInspectClass(args: z.infer<typeof InspectClassInput>) {
  const { jarPath, className, includePrivate } = args;
  if (!isAbsolute(jarPath)) {
    return { found: false, className, error: `jarPath must be absolute: ${jarPath}` };
  }
  const result = await inspectClassInJar(jarPath, className, includePrivate);
  if (!result.found) {
    return { found: false, className, error: result.error };
  }
  return { found: true, ...result.info };
}

async function toolListDependencies(args: z.infer<typeof ListDependenciesInput>) {
  const { projectPath, directOnly } = args;
  if (!isAbsolute(projectPath)) {
    return { error: `projectPath must be absolute: ${projectPath}` };
  }
  let classpath;
  try {
    classpath = await resolveClasspath(projectPath);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const filtered = directOnly ? classpath.filter((c) => c.direct) : classpath;
  return {
    count: filtered.length,
    totalResolved: classpath.length,
    dependencies: filtered.map((c) => ({
      group: c.group,
      artifact: c.artifact,
      version: c.version,
      jarPath: c.jarPath,
      direct: c.direct,
    })),
  };
}

async function toolFindDependencyVersion(args: z.infer<typeof FindDependencyVersionInput>) {
  const { projectPath, query } = args;
  if (!isAbsolute(projectPath)) {
    return { error: `projectPath must be absolute: ${projectPath}` };
  }
  let classpath;
  try {
    classpath = await resolveClasspath(projectPath);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const q = query.toLowerCase();
  const matches = classpath.filter(
    (c) =>
      c.artifact.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      `${c.group}:${c.artifact}`.toLowerCase().includes(q)
  );
  return {
    query,
    count: matches.length,
    matches: matches.map((c) => ({
      group: c.group,
      artifact: c.artifact,
      version: c.version,
      direct: c.direct,
    })),
  };
}

async function toolDependencyInsight(args: z.infer<typeof DependencyInsightInput>) {
  const { projectPath, dependency, subproject } = args;
  if (!isAbsolute(projectPath)) {
    return { error: `projectPath must be absolute: ${projectPath}` };
  }
  return runDependencyInsight(projectPath, dependency, subproject ?? null);
}

async function toolCheckOutdated(args: z.infer<typeof CheckOutdatedInput>) {
  const { projectPath, includeTransitive, limit } = args;
  if (!isAbsolute(projectPath)) {
    return { error: `projectPath must be absolute: ${projectPath}` };
  }
  let classpath;
  try {
    classpath = await resolveClasspath(projectPath);
  } catch (e) {
    return { error: (e as Error).message };
  }
  let candidates = includeTransitive ? classpath : classpath.filter((c) => c.direct);
  if (limit) candidates = candidates.slice(0, limit);
  const results = await checkOutdated(
    candidates.map((c) => ({ group: c.group, artifact: c.artifact, version: c.version }))
  );
  const outdated = results.filter((r) => r.outdated);
  return {
    checked: results.length,
    outdatedCount: outdated.length,
    outdated,
  };
}

// ---------- Server bootstrap ----------

async function main() {
  const server = new Server(
    { name: "gradle-mcp-server", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS as unknown as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    try {
      let result: unknown;
      switch (req.params.name) {
        case "resolve_external_class":
          result = await toolResolveExternalClass(ResolveExternalClassInput.parse(args));
          break;
        case "inspect_class":
          result = await toolInspectClass(InspectClassInput.parse(args));
          break;
        case "list_dependencies":
          result = await toolListDependencies(ListDependenciesInput.parse(args));
          break;
        case "find_dependency_version":
          result = await toolFindDependencyVersion(FindDependencyVersionInput.parse(args));
          break;
        case "dependency_insight":
          result = await toolDependencyInsight(DependencyInsightInput.parse(args));
          break;
        case "check_outdated":
          result = await toolCheckOutdated(CheckOutdatedInput.parse(args));
          break;
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
            isError: true,
          };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Tool error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
