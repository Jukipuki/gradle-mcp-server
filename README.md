# gradle-mcp-server

A Model Context Protocol (MCP) server that lets AI agents look up external Java/Kotlin classes in a Gradle project in a single tool call — no more chains of `find`, `grep`, `jar`, and `javap`.

Given a fully-qualified class name, it:

1. Resolves every source set's compile classpath via Gradle — `main`, `test`, and any custom source sets — so `testImplementation` / `testFixtures` deps are included. Uses a bundled init script; your project is not modified.
2. Locates the JAR containing the class.
3. Runs `javap` and parses the output.
4. Returns the artifact coordinates plus the class's fields, methods, and modifiers.

## Requirements

- Node.js 18+
- A JDK on `PATH` (so `javap` is available)
- The target project must have a Gradle wrapper (`./gradlew` on macOS/Linux, `gradlew.bat` on Windows)
- macOS, Linux, or Windows

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

## Tools

The server exposes six tools. All take `projectPath` as an absolute path to the Gradle project root (except `inspect_class`, which takes a `jarPath` directly).

### Picking the right tool

| If you want to… | Use |
| --- | --- |
| Look up a class by FQCN when you don't know the JAR | `resolve_external_class` |
| Inspect a class when you already know the JAR path | `inspect_class` |
| List everything on the classpath | `list_dependencies` |
| Check "what version of X do I have?" | `find_dependency_version` |
| Understand why a dependency was pulled in | `dependency_insight` |
| See which dependencies have newer versions | `check_outdated` |

### `resolve_external_class`

Resolve and inspect a class from external dependencies when you DON'T know which JAR contains it. Replaces manual `find` / `grep` / `jar` / `javap` chains.

**Input:** `projectPath`, `className` (FQCN), `includePrivate` (default `false`).

**Example response:**

```json
{
  "found": true,
  "artifact": "com.elevate:commons-workflow:1.390.1",
  "className": "com.elevate.workflows.prefund.dto.VoidPrefundReturnInvoicesDto",
  "jarPath": "/Users/.../commons-workflow-1.390.1.jar",
  "isRecord": true,
  "isInterface": false,
  "isAbstract": false,
  "isFinal": true,
  "superclass": "Record",
  "hasBuilder": true,
  "fields": [
    { "name": "organizationIds", "type": "List<Long>", "access": "private", "modifiers": ["final"] }
  ],
  "methods": [
    { "name": "organizationIds", "returnType": "List<Long>", "parameters": [], "access": "public", "modifiers": [], "isConstructor": false }
  ]
}
```

Miss: `{ "found": false, "className": "...", "searched": 142 }`
Error: `{ "found": false, "className": "...", "error": "Gradle wrapper not found at ..." }`

### `inspect_class`

Same class structure as `resolve_external_class`, but takes a `jarPath` directly — skips Gradle classpath resolution. Use this when the JAR path is already known (e.g. from a previous `resolve_external_class` result or `list_dependencies`).

**Input:** `jarPath`, `className` (FQCN), `includePrivate` (default `false`).

Response shape is identical to `resolve_external_class` minus the `artifact` field.

### `list_dependencies`

List all resolved external dependencies across every source set's compile classpath (main + test + custom). Each entry includes `sourceSets`, e.g. `["main"]`, `["test"]`, or `["main","test"]`.

**Input:** `projectPath`, `directOnly` (default `false`).

**Example response:**

```json
{
  "count": 142,
  "totalResolved": 142,
  "dependencies": [
    { "group": "com.fasterxml.jackson.core", "artifact": "jackson-databind", "version": "2.17.1", "jarPath": "/Users/.../jackson-databind-2.17.1.jar", "direct": true, "sourceSets": ["main", "test"] }
  ]
}
```

### `find_dependency_version`

Substring-match against group / artifact and return resolved versions. Case-insensitive.

**Input:** `projectPath`, `query`.

**Example:** `query: "jackson"` →

```json
{
  "query": "jackson",
  "count": 6,
  "matches": [
    { "group": "com.fasterxml.jackson.core", "artifact": "jackson-databind", "version": "2.17.1", "direct": true, "sourceSets": ["main", "test"] },
    { "group": "com.fasterxml.jackson.core", "artifact": "jackson-annotations", "version": "2.17.1", "direct": false, "sourceSets": ["main", "test"] }
  ]
}
```

### `dependency_insight`

Wraps `./gradlew dependencyInsight --configuration compileClasspath --dependency <query>`. Returns the raw resolution chain and a parsed `requestedBy` list.

**Input:** `projectPath`, `dependency` (artifact name or `group:artifact`), optional `subproject` (e.g. `":app"` — defaults to root).

**Example response:**

```json
{
  "found": true,
  "dependency": "jackson-databind",
  "subproject": null,
  "raw": "...full dependencyInsight output...",
  "truncated": false,
  "requestedBy": ["+--- com.example:my-lib:1.0", "\\--- com.example:other-lib:2.3"]
}
```

### `check_outdated`

Compares resolved versions against Maven Central's `latestVersion`. Checks direct deps only by default.

**Input:** `projectPath`, `includeTransitive` (default `false`), `limit` (optional cap).

**Example response:**

```json
{
  "checked": 24,
  "outdatedCount": 3,
  "outdated": [
    { "group": "com.fasterxml.jackson.core", "artifact": "jackson-databind", "current": "2.17.1", "latest": "2.18.2", "outdated": true }
  ]
}
```

Pre-release `latestVersion` values (SNAPSHOT, alpha, beta, rc, M*) are filtered out when the current version is stable.

## How it works

The server invokes:

```
./gradlew -q --init-script <bundled-init-script> printGradleMcpInfo
```

The bundled Groovy init script registers `printGradleMcpInfo` on every project. For each resolvable `*CompileClasspath` configuration (so `main`, `test`, and any custom source sets), it emits `GMCP|D|group:artifact:version|sourceSet1,sourceSet2|/path/to.jar` for direct deps and `GMCP|T|...` for transitive. Entries appearing in multiple source sets are merged. Classpath output is cached per `projectPath` and invalidated when any of `build.gradle.kts`, `build.gradle`, `settings.gradle.kts`, or `settings.gradle` change.

`dependency_insight` is a separate `./gradlew dependencyInsight` invocation. `check_outdated` queries `https://search.maven.org/solrsearch/select` (results cached in-memory for 10 minutes).

## Caveats

- Only compile classpaths are resolved (every source set's `*CompileClasspath`). `runtimeClasspath` is out of scope, so runtime-only deps may be missing.
- Source / Javadoc JARs are not used; class info comes from `javap`.
- Cache is in-memory (process-lifetime).
- `check_outdated` version comparison is a simple numeric-aware split, not full Maven `ComparableVersion`. Edge cases (timestamped snapshots, qualifier ordering) may be misclassified.

## License

MIT
