import AdmZip from "adm-zip";
import { existsSync } from "node:fs";
import type { ClasspathEntry } from "./classpath.js";

export interface JarHit {
  entry: ClasspathEntry;
  classEntryPath: string;
  hasBuilderNested: boolean;
}

function fqcnToClassEntry(fqcn: string): string {
  return fqcn.replace(/\./g, "/") + ".class";
}

export function findJarForClass(
  classpath: ClasspathEntry[],
  fqcn: string
): { hit: JarHit | null; searched: number } {
  const target = fqcnToClassEntry(fqcn);
  const builderTarget = fqcnToClassEntry(`${fqcn}$Builder`);
  let searched = 0;
  for (const entry of classpath) {
    if (!existsSync(entry.jarPath)) continue;
    searched++;
    try {
      const zip = new AdmZip(entry.jarPath);
      const classEntry = zip.getEntry(target);
      if (!classEntry) continue;
      const builderEntry = zip.getEntry(builderTarget);
      return {
        hit: {
          entry,
          classEntryPath: target,
          hasBuilderNested: !!builderEntry,
        },
        searched,
      };
    } catch {
      // unreadable / corrupt jar — skip
    }
  }
  return { hit: null, searched };
}
