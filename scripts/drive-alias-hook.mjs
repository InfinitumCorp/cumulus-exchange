import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function aliasHref(specifier) {
  const base = join(root, "src", specifier.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.js`, `${base}.mjs`]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const href = aliasHref(specifier);
    if (href) return nextResolve(href, context);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL &&
    context.parentURL.includes("/src/")
  ) {
    const exact = new URL(specifier, context.parentURL);
    if (existsSync(fileURLToPath(exact))) return nextResolve(exact.href, context);
    for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
      const withExt = new URL(`${specifier}${ext}`, context.parentURL);
      if (existsSync(fileURLToPath(withExt))) return nextResolve(withExt.href, context);
    }
  }
  return nextResolve(specifier, context);
}
