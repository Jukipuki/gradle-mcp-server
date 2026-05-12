import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = resolve(root, "src/init-script.gradle");
const dst = resolve(root, "dist/init-script.gradle");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`[copy-assets] ${src} -> ${dst}`);
