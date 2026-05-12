import { execFile } from "node:child_process";

export interface FieldInfo {
  name: string;
  type: string;
  access: string;
  modifiers: string[];
}

export interface MethodInfo {
  name: string;
  returnType: string;
  parameters: string[];
  access: string;
  modifiers: string[];
  isConstructor: boolean;
}

export interface ParsedClass {
  header: string;
  isInterface: boolean;
  isAbstract: boolean;
  isRecord: boolean;
  isFinal: boolean;
  superclass: string | null;
  fields: FieldInfo[];
  methods: MethodInfo[];
  hasBuilderMethod: boolean;
}

export class JavapMissingError extends Error {
  constructor() {
    super("javap not on PATH — install a JDK");
  }
}

const ACCESS_KEYWORDS = new Set(["public", "protected", "private"]);
const MODIFIER_KEYWORDS = new Set([
  "static",
  "final",
  "abstract",
  "synchronized",
  "native",
  "strictfp",
  "default",
  "transient",
  "volatile",
]);

export function runJavap(
  jarPath: string,
  fqcn: string,
  includePrivate: boolean
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["-classpath", jarPath, "-s"];
    if (includePrivate) args.push("-p");
    args.push(fqcn);
    execFile("javap", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          rejectPromise(new JavapMissingError());
          return;
        }
        const msg = stderr?.toString().trim() || err.message;
        rejectPromise(new Error(`javap failed: ${msg}`));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

function splitParams(paramList: string): string[] {
  if (!paramList.trim()) return [];
  const params: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of paramList) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      params.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) params.push(buf.trim());
  return params.map(simplifyType);
}

function simplifyType(t: string): string {
  // strip java.lang. and java.util. prefixes for readability, leave others
  return t
    .replace(/\bjava\.lang\./g, "")
    .replace(/\bjava\.util\./g, "");
}

function splitLeadingModifiers(decl: string): {
  access: string;
  modifiers: string[];
  rest: string;
} {
  const tokens = decl.split(/\s+/);
  let access = "package-private";
  const modifiers: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ACCESS_KEYWORDS.has(t)) {
      access = t;
      i++;
    } else if (MODIFIER_KEYWORDS.has(t)) {
      modifiers.push(t);
      i++;
    } else {
      break;
    }
  }
  return { access, modifiers, rest: tokens.slice(i).join(" ") };
}

export function parseJavap(output: string, fqcn: string): ParsedClass {
  const lines = output.split(/\r?\n/);
  let header = "";
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith("Compiled from")) continue;
    if (t.startsWith("Classfile ")) continue;
    if (t.endsWith("{")) {
      header = t.slice(0, -1).trim();
      break;
    }
  }

  const isInterface = /\binterface\s+/.test(header);
  const isAbstract = /\babstract\s+/.test(header) && !isInterface;
  const isFinal = /\bfinal\s+/.test(header);
  const recordMatch = /extends\s+java\.lang\.Record\b/.test(header);
  const isRecord = recordMatch;
  let superclass: string | null = null;
  const extM = header.match(/\bextends\s+([\w.$<>,\s]+?)(?:\s+implements\b|$)/);
  if (extM) superclass = simplifyType(extM[1].trim());

  const fields: FieldInfo[] = [];
  const methods: MethodInfo[] = [];
  const shortName = fqcn.substring(fqcn.lastIndexOf(".") + 1);
  let hasBuilderMethod = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("descriptor:")) continue;
    if (!line.endsWith(";")) continue;
    if (line === header || line.endsWith("{")) continue;
    // skip the class header line itself defensively
    if (/\b(class|interface|enum)\s+/.test(line) && !line.includes("(")) {
      // could be a member like `public static class X;` — skip nested class summaries
      continue;
    }

    const decl = line.slice(0, -1).trim();
    const { access, modifiers, rest } = splitLeadingModifiers(decl);
    if (!rest) continue;

    const parenIdx = rest.indexOf("(");
    if (parenIdx >= 0) {
      // method or constructor
      const closeIdx = rest.lastIndexOf(")");
      if (closeIdx < 0) continue;
      const sig = rest.slice(0, parenIdx).trim();
      const paramList = rest.slice(parenIdx + 1, closeIdx);

      // sig is "<returnType> name" OR just "name" for constructors
      const sigTokens = sig.split(/\s+/);
      let name: string;
      let returnType: string;
      let isConstructor = false;
      if (sigTokens.length === 1) {
        // constructor — token is the (possibly fully qualified) class name
        const ctorName = sigTokens[0];
        const last = ctorName.substring(ctorName.lastIndexOf(".") + 1);
        if (last === shortName || ctorName === fqcn) {
          isConstructor = true;
          name = shortName;
          returnType = "void";
        } else {
          // weird — skip
          continue;
        }
      } else {
        name = sigTokens[sigTokens.length - 1];
        returnType = simplifyType(sigTokens.slice(0, -1).join(" "));
      }

      if (
        !isConstructor &&
        name === "builder" &&
        modifiers.includes("static")
      ) {
        hasBuilderMethod = true;
      }

      methods.push({
        name,
        returnType,
        parameters: splitParams(paramList),
        access,
        modifiers,
        isConstructor,
      });
    } else {
      // field: "<type> <name>"
      const tokens = rest.split(/\s+/);
      if (tokens.length < 2) continue;
      const name = tokens[tokens.length - 1];
      const type = simplifyType(tokens.slice(0, -1).join(" "));
      fields.push({ name, type, access, modifiers });
    }
  }

  return {
    header,
    isInterface,
    isAbstract,
    isRecord,
    isFinal,
    superclass,
    fields,
    methods,
    hasBuilderMethod,
  };
}
