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
import { runJavap, parseJavap, JavapMissingError } from "./javap.js";

const TOOL_NAME = "resolve_external_class";

const TOOL_DESCRIPTION =
  "Use this instead of find, grep, jar, or javap commands when looking up classes from external Gradle dependencies. Given a fully-qualified class name, returns which artifact provides it plus its complete field and method structure.";

const InputSchema = z.object({
  projectPath: z.string().min(1).describe("Absolute path to the Gradle project root"),
  className: z.string().min(1).describe("Fully-qualified class name, e.g. com.example.Foo"),
  includePrivate: z.boolean().optional().default(false),
});

type Input = z.infer<typeof InputSchema>;

interface SuccessResponse {
  found: true;
  className: string;
  artifact: string;
  jarPath: string;
  isRecord: boolean;
  isInterface: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  superclass: string | null;
  hasBuilder: boolean;
  fields: Array<{ name: string; type: string; access: string; modifiers: string[] }>;
  methods: Array<{
    name: string;
    returnType: string;
    parameters: string[];
    access: string;
    modifiers: string[];
    isConstructor: boolean;
  }>;
}

interface MissResponse {
  found: false;
  className: string;
  searched?: number;
  error?: string;
}

async function resolveExternalClass(input: Input): Promise<SuccessResponse | MissResponse> {
  const { projectPath, className, includePrivate } = input;

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
      error:
        "No external compileClasspath entries resolved. Is this a Gradle project with dependencies?",
    };
  }

  const { hit, searched } = findJarForClass(classpath, className);
  if (!hit) {
    return { found: false, className, searched };
  }

  let parsed;
  try {
    const output = await runJavap(hit.entry.jarPath, className, includePrivate);
    parsed = parseJavap(output, className);
  } catch (e) {
    if (e instanceof JavapMissingError) {
      return { found: false, className, error: e.message };
    }
    return { found: false, className, error: (e as Error).message };
  }

  const { entry } = hit;
  return {
    found: true,
    className,
    artifact: `${entry.group}:${entry.artifact}:${entry.version}`,
    jarPath: entry.jarPath,
    isRecord: parsed.isRecord,
    isInterface: parsed.isInterface,
    isAbstract: parsed.isAbstract,
    isFinal: parsed.isFinal,
    superclass: parsed.superclass,
    hasBuilder: hit.hasBuilderNested || parsed.hasBuilderMethod,
    fields: parsed.fields,
    methods: parsed.methods,
  };
}

async function main() {
  const server = new Server(
    { name: "gradle-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "Absolute path to the Gradle project root",
            },
            className: {
              type: "string",
              description: "Fully-qualified class name, e.g. com.example.Foo",
            },
            includePrivate: {
              type: "boolean",
              description: "Include private members in the output",
              default: false,
            },
          },
          required: ["projectPath", "className"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }
    const parsed = InputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [
          { type: "text", text: `Invalid arguments: ${parsed.error.message}` },
        ],
        isError: true,
      };
    }
    const result = await resolveExternalClass(parsed.data);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
