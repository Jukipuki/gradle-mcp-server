# gradle-mcp-server

A Model Context Protocol (MCP) server that lets AI agents look up external Java/Kotlin classes in a Gradle project in a single tool call — no more chains of `find`, `grep`, `jar`, and `javap`.

Given a fully-qualified class name, it:

1. Resolves the project's `compileClasspath` via Gradle (using a bundled init script — your project is not modified).
2. Locates the JAR containing the class.
3. Runs `javap` and parses the output.
4. Returns the artifact coordinates plus the class's fields, methods, and modifiers.

## Requirements

- Node.js 18+
- A JDK on `PATH` (so `javap` is available)
- The target project must have a Gradle wrapper (`./gradlew`)
- macOS or Linux (Windows is not supported in v1)

## Install / run

Three ways to run it, in order of stability:

**1. From npm (once published):**
```sh
npx -y gradle-mcp-server
```

**2. Directly from GitHub (no npm publish required):**
```sh
npx -y github:Jukipuki/gradle-mcp-server
```
npm clones the repo, runs the `prepare` script (which builds `dist/`), and executes the `bin` entry. First run is slower (clone + tsc); subsequent runs reuse the npx cache. Pin to a tag/commit with `github:Jukipuki/gradle-mcp-server#v0.1.0`.

**3. From a local checkout:**
```sh
git clone https://github.com/Jukipuki/gradle-mcp-server.git
cd gradle-mcp-server && npm install && npm run build
node /absolute/path/to/gradle-mcp-server/dist/index.js
```

## Wire into Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gradle": {
      "command": "npx",
      "args": ["-y", "gradle-mcp-server"]
    }
  }
}
```

Or, to run straight from GitHub without publishing:

```json
{
  "mcpServers": {
    "gradle": {
      "command": "npx",
      "args": ["-y", "github:Jukipuki/gradle-mcp-server"]
    }
  }
}
```

Or, from a local checkout:

```json
{
  "mcpServers": {
    "gradle": {
      "command": "node",
      "args": ["/absolute/path/to/gradle-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. The agent will see a tool named `resolve_external_class`.

## Wire into Kiro

Kiro uses the same MCP server schema as Claude Desktop. Put the config in either:

- **Workspace:** `.kiro/settings/mcp.json` (committed per-repo)
- **User-global:** `~/.kiro/settings/mcp.json`

```json
{
  "mcpServers": {
    "gradle": {
      "command": "npx",
      "args": ["-y", "github:Jukipuki/gradle-mcp-server"],
      "disabled": false,
      "autoApprove": ["resolve_external_class"]
    }
  }
}
```

`autoApprove` lets the tool run without a per-call confirmation prompt — useful since `resolve_external_class` is read-only. Remove that field if you'd rather approve each call. Reload the MCP servers from the Kiro command palette (or restart Kiro) after editing.

## Tool: `resolve_external_class`

**Description (shown to the agent):**
> Use this instead of find, grep, jar, or javap commands when looking up classes from external Gradle dependencies. Given a fully-qualified class name, returns which artifact provides it plus its complete field and method structure.

**Input:**

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `projectPath` | string | — | Absolute path to the Gradle project root |
| `className` | string | — | Fully-qualified class name, e.g. `com.example.Foo` |
| `includePrivate` | boolean | `false` | Include private members in the output |

**Example response:**

```json
{
  "found": true,
  "className": "com.elevate.workflows.prefund.dto.VoidPrefundReturnInvoicesDto",
  "artifact": "com.elevate:commons-workflow:1.390.1",
  "jarPath": "/Users/.../.gradle/caches/.../commons-workflow-1.390.1.jar",
  "isRecord": true,
  "isInterface": false,
  "isAbstract": false,
  "isFinal": true,
  "superclass": "Record",
  "hasBuilder": true,
  "fields": [
    { "name": "organizationIds", "type": "List<Long>", "access": "private", "modifiers": ["final"] },
    { "name": "planId", "type": "Long", "access": "private", "modifiers": ["final"] }
  ],
  "methods": [
    {
      "name": "organizationIds",
      "returnType": "List<Long>",
      "parameters": [],
      "access": "public",
      "modifiers": [],
      "isConstructor": false
    }
  ]
}
```

**Miss / error response:**

```json
{ "found": false, "className": "com.example.Missing", "searched": 142 }
```

```json
{ "found": false, "className": "com.example.Foo", "error": "Gradle wrapper not found at /path/gradlew" }
```

## How it works

The server invokes:

```
./gradlew -q --init-script <bundled-init-script> printClasspathExternal
```

The bundled init script (Groovy) registers a `printClasspathExternal` task on every project that prints `group:artifact:version=/abs/path/to.jar` for each resolved artifact on `compileClasspath`. Output is cached per `projectPath` and invalidated when any of `build.gradle.kts`, `build.gradle`, `settings.gradle.kts`, or `settings.gradle` change.

## Caveats

- Only `compileClasspath` is resolved. `runtimeClasspath` and `testCompileClasspath` are out of scope for v1.
- Source / Javadoc JARs are not used; output comes from class file metadata via `javap`.
- Cache is in-memory (process-lifetime).

## License

MIT
