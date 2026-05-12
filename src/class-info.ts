import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import { JavapMissingError, parseJavap, runJavap } from "./javap.js";

export interface ClassInfo {
  className: string;
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

export type InspectResult =
  | { found: true; info: ClassInfo }
  | { found: false; error: string };

function fqcnToEntry(fqcn: string): string {
  return fqcn.replace(/\./g, "/") + ".class";
}

export async function inspectClassInJar(
  jarPath: string,
  className: string,
  includePrivate: boolean
): Promise<InspectResult> {
  if (!existsSync(jarPath)) {
    return { found: false, error: `JAR not found: ${jarPath}` };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(jarPath);
  } catch (e) {
    return { found: false, error: `Could not read JAR ${jarPath}: ${(e as Error).message}` };
  }

  const classEntry = zip.getEntry(fqcnToEntry(className));
  if (!classEntry) {
    return { found: false, error: `Class ${className} not found in ${jarPath}` };
  }

  const builderEntry = zip.getEntry(fqcnToEntry(`${className}$Builder`));

  try {
    const output = await runJavap(jarPath, className, includePrivate);
    const parsed = parseJavap(output, className);
    return {
      found: true,
      info: {
        className,
        jarPath,
        isRecord: parsed.isRecord,
        isInterface: parsed.isInterface,
        isAbstract: parsed.isAbstract,
        isFinal: parsed.isFinal,
        superclass: parsed.superclass,
        hasBuilder: !!builderEntry || parsed.hasBuilderMethod,
        fields: parsed.fields,
        methods: parsed.methods,
      },
    };
  } catch (e) {
    if (e instanceof JavapMissingError) {
      return { found: false, error: e.message };
    }
    return { found: false, error: (e as Error).message };
  }
}
