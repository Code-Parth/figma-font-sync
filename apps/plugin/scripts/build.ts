// Builds the two files manifest.json points at: dist/code.js (main thread) and dist/ui.html (UI iframe).
//   bun scripts/build.ts            build once, exit 1 on any error
//   bun scripts/build.ts --watch    rebuild both on every change under src/

import { watch } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");
const DEBOUNCE_MS = 150;

// Figma reads these files whenever the plugin runs, which in watch mode can be mid-write.
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await Bun.write(temp, contents);
  await rename(temp, path);
}

function describeLog(log: BuildMessage | ResolveMessage): string {
  if (!log.position) return log.message;
  const { file, line, column } = log.position;
  return `${relative(root, file)}:${line}:${column}: ${log.message}`;
}

async function buildMain(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(src, "main/code.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    throw: false,
  });
  if (!result.success) throw new Error(`main: ${result.logs.map(describeLog).join("\n")}`);
  if (result.outputs.length !== 1 || !result.outputs[0]) {
    throw new Error(`main: expected one output file, got ${result.outputs.length}`);
  }
  const code = await result.outputs[0].text();
  // Figma runs the main file as a classic script, so any import or export left in it is a syntax error.
  const { imports, exports } = new Bun.Transpiler({ loader: "js" }).scan(code);
  if (imports.length > 0 || exports.length > 0) {
    const names = [...imports.map((entry) => `${entry.kind} ${entry.path}`), ...exports.map((name) => `export ${name}`)];
    throw new Error(`main: dist/code.js must be a classic script, found: ${names.join(", ")}`);
  }
  await writeAtomic(join(dist, "code.js"), code);
}

/** src and href values in markup that point at another file. Inline script and style bodies are skipped. */
export function externalReferences(html: string): string[] {
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, "$1$3");
  const references: string[] = [];
  for (const match of markup.matchAll(/\s(?:src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value === "" || value.startsWith("#") || value.toLowerCase().startsWith("data:")) continue;
    references.push(value);
  }
  return references;
}

// Figma loads ui.html as one string (__html__) with no base URL, so every script and stylesheet must be
// inline. `bun build --compile --target=browser` on an HTML entry inlines them; without --production it
// ships React's development build.
async function buildUi(): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), "font-sync-ui-"));
  try {
    const command = ["build", "--compile", "--target=browser", "--production", join(src, "ui/index.html"), "--outdir", out];
    const proc = Bun.spawn([process.execPath, ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`ui: bun build exited with ${exitCode}\n${(stderr || stdout).trim()}`);

    const files: string[] = [];
    for await (const file of new Bun.Glob("**/*").scan({ cwd: out, onlyFiles: true })) files.push(file);
    const [file] = files;
    if (files.length !== 1 || !file?.endsWith(".html")) {
      throw new Error(`ui: expected one self-contained .html file, got: ${files.join(", ") || "nothing"}`);
    }
    const html = await Bun.file(join(out, file)).text();
    const references = externalReferences(html);
    if (references.length > 0) {
      throw new Error(`ui: dist/ui.html must not load other files, found: ${references.join(", ")}`);
    }
    await writeAtomic(join(dist, "ui.html"), html);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** Builds both targets, even when one fails, and returns every error message. */
async function buildAll(): Promise<string[]> {
  const results = await Promise.allSettled([buildMain(), buildUi()]);
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return [];
    return [result.reason instanceof Error ? result.reason.message : String(result.reason)];
  });
}

async function buildOnce(): Promise<boolean> {
  const started = performance.now();
  const errors = await buildAll();
  const time = new Date().toLocaleTimeString();
  if (errors.length === 0) {
    console.log(`${time} built dist/code.js and dist/ui.html in ${Math.round(performance.now() - started)} ms`);
    return true;
  }
  console.error(`${time} build failed\n${errors.join("\n")}`);
  return false;
}

function watchAndRebuild(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let queued = false;

  // A change that lands mid-build gets one more build afterwards rather than a concurrent one.
  const rebuild = async (): Promise<void> => {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    do {
      queued = false;
      await buildOnce();
    } while (queued);
    building = false;
  };

  watch(src, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), DEBOUNCE_MS);
  });
  console.log(`watching ${src}`);
}

if (import.meta.main) {
  const ok = await buildOnce();
  if (process.argv.includes("--watch")) watchAndRebuild();
  else if (!ok) process.exit(1);
}
