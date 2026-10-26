#!/usr/bin/env node
/**
 * AtlasBurn CLI — `abn`
 *
 * Ships inside @atlasburn/sdk as a `bin`. ZERO runtime dependencies (Node
 * built-ins only), consistent with the SDK's no-deps ethos.
 *
 * Commands:
 *   abn init     Interactive setup wizard (detect → confirm → write → test)
 *   abn test     Verify the key + connectivity; sends one real `verification` event
 *   abn status   Show the current guardrail state (active / throttled / suspended)
 *   abn doctor   Environment diagnostics + fixes
 *
 * Safety: never writes without a consent + diff prompt, never logs the key,
 * fails safe (does nothing on incompatible runtimes unless explicitly told to).
 *
 * Non-interactive setup (e.g. driven by Claude via the AtlasBurn MCP):
 *   abn init --code <abset_…> --yes          redeem a one-time setup code for a new key
 *   abn init --code <abset_…> --proxy --yes  same, Edge Proxy: env only + base-URL guide
 *   ATLASBURN_KEY=abn_… abn init --yes        use a key from the environment, no prompt
 */
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyAtlasBurn } from "./index.js";

const ENV_VAR = "ATLASBURN_KEY";
const KEY_PREFIX = "abn_";
const GATE_URL = process.env.ATLASBURN_GATE_URL || "https://app.atlasburn.com/api/gate";
const DASH_URL = "https://app.atlasburn.com";
const CLAIM_URL = process.env.ATLASBURN_CLAIM_URL || new URL("/api/cli/claim", GATE_URL).toString();
const INGEST_URL = process.env.ATLASBURN_INGEST_URL || new URL("/api/ingest", GATE_URL).toString();
const PROXY_URL = (process.env.ATLASBURN_PROXY_URL || "https://proxy.atlasburn.com").replace(/\/$/, "");
const SETUP_CODE_PREFIX = "abset_";
const MIN_NODE = 18;

// ── tiny ANSI (no deps) ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
  dim: paint("2"), bold: paint("1"), green: paint("32"), red: paint("31"),
  yellow: paint("33"), cyan: paint("36"), gray: paint("90"),
};
const ok = (s: string) => `${C.green("✓")} ${s}`;
const bad = (s: string) => `${C.red("✗")} ${s}`;
const warn = (s: string) => `${C.yellow("⚠")}  ${s}`;
const info = (s: string) => `${C.cyan("›")} ${s}`;

// ── flags ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const FLAGS = { dryRun: args.includes("--dry-run"), yes: args.includes("--yes"), proxy: args.includes("--proxy") };
/** `--code <value>` or `--code=<value>`: one-time setup code from the AtlasBurn MCP flow. */
const SETUP_CODE = (() => {
  const i = args.indexOf("--code");
  if (i >= 0) return (args[i + 1] || "").trim();
  return (args.find((a) => a.startsWith("--code=")) || "").slice("--code=".length).trim();
})();

// ── prompts (dep-free) ───────────────────────────────────────────────────────
function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

/** No-echo masked input — the typed characters are never rendered. */
function askMasked(q: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    anyRl._writeToOutput = (str: string) => {
      if (muted) { if (str.includes("\n")) anyRl.output.write("\n"); return; }
      anyRl.output.write(str);
    };
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a); });
    muted = true;
  });
}

async function confirm(q: string, def = false): Promise<boolean> {
  if (FLAGS.yes) return true;
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${q} ${C.dim(hint)} `)).trim().toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

// ── key handling ─────────────────────────────────────────────────────────────
function sanitizeKey(raw: string): string {
  let k = (raw || "").trim();
  k = k.replace(/^["']|["']$/g, "");        // wrapping quotes
  k = k.replace(/^bearer\s+/i, "");          // stray "Bearer "
  k = k.replace(/\s+/g, "");                  // any whitespace/newlines from paste
  return k;
}
const validPrefix = (k: string) => k.startsWith(KEY_PREFIX);
const maskKey = (k: string) => (k.length > 10 ? `${k.slice(0, 7)}…${k.slice(-3)}` : `${KEY_PREFIX}…`);

// ── project detection ────────────────────────────────────────────────────────
interface Project {
  root: string; pkgPath: string; pkg: Record<string, any>;
  packageManager: string; isTypeScript: boolean; framework: string; isNext: boolean;
  envFileName: string; envFile: string; entryFile: string | null; isESM: boolean;
}

function detectProject(): Project | null {
  const root = process.cwd();
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: Record<string, any> = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { return null; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (n: string) => n in deps;
  const ex = (f: string) => fs.existsSync(path.join(root, f));

  const packageManager = ex("pnpm-lock.yaml") ? "pnpm" : ex("yarn.lock") ? "yarn"
    : (ex("bun.lockb") || ex("bun.lock")) ? "bun" : "npm";
  const isNext = has("next");
  const framework = isNext ? "Next.js" : has("express") ? "Express" : has("fastify") ? "Fastify" : "Node";
  const isTypeScript = ex("tsconfig.json") || has("typescript");
  const envFileName = isNext ? ".env.local" : ".env";
  const isESM = pkg.type === "module";

  let entryFile: string | null = null;
  const candidates = [pkg.main, pkg.module,
    "src/index.ts", "src/index.js", "index.ts", "index.js",
    "src/main.ts", "src/main.js", "server.ts", "server.js", "app.ts", "app.js"].filter(Boolean) as string[];
  for (const cand of candidates) { if (ex(cand)) { entryFile = path.join(root, cand); break; } }

  return { root, pkgPath, pkg, packageManager, isTypeScript, framework, isNext, envFileName, envFile: path.join(root, envFileName), entryFile, isESM };
}

/** Edge Proxy works for any language, so a package.json is optional there. */
function genericProject(): Project {
  const root = process.cwd();
  return {
    root, pkgPath: "", pkg: {}, packageManager: "-", isTypeScript: false, framework: "any language",
    isNext: false, envFileName: ".env", envFile: path.join(root, ".env"), entryFile: null, isESM: false,
  };
}

// Edge Proxy routes: replace the provider host with PROXY_URL/<prefix> and send the
// AtlasBurn-API-Key header. Mirrors UNIVERSAL_PROVIDER_CATALOG in the dashboard.
const PROXY_ROUTES: Array<{ name: string; host: string; prefix: string; example?: string }> = [
  { name: "OpenAI", host: "https://api.openai.com", prefix: "openai", example: "base URL https://proxy.atlasburn.com/openai/v1" },
  { name: "Anthropic", host: "https://api.anthropic.com", prefix: "anthropic", example: "base URL https://proxy.atlasburn.com/anthropic" },
  { name: "Google (Gemini/Vertex)", host: "https://generativelanguage.googleapis.com", prefix: "gemini" },
  { name: "OpenRouter", host: "https://openrouter.ai", prefix: "openrouter" },
  { name: "Cohere", host: "https://api.cohere.com", prefix: "cohere" },
  { name: "Mistral", host: "https://api.mistral.ai", prefix: "mistral" },
  { name: "Groq", host: "https://api.groq.com", prefix: "groq" },
  { name: "Together AI", host: "https://api.together.xyz", prefix: "together" },
  { name: "DeepSeek", host: "https://api.deepseek.com", prefix: "deepseek" },
  { name: "xAI", host: "https://api.x.ai", prefix: "xai" },
];

function printProxyGuide(providers: string[]) {
  const routes = providers.length ? PROXY_ROUTES.filter((r) => providers.includes(r.name)) : PROXY_ROUTES;
  const unsupported = providers.filter((p) => !PROXY_ROUTES.some((r) => r.name === p));
  console.log(C.bold("\nEdge Proxy — point your AI client at AtlasBurn:"));
  for (const r of routes) {
    console.log(`  ${C.bold(r.name.padEnd(22))} ${r.host}  →  ${C.cyan(`${PROXY_URL}/${r.prefix}`)}${r.example ? C.dim(`  (${r.example})`) : ""}`);
  }
  console.log(`  and send the header ${C.cyan(`AtlasBurn-API-Key: <${ENV_VAR}>`)} on every request (read it from the env, never hard-code it).`);
  if (unsupported.length) console.log(warn(`${unsupported.join(", ")}: not supported by the proxy — use the SDK for those calls.`));
  console.log(C.dim(`  Docs: https://docs.atlasburn.com/docs/proxy-quickstart`));
}

/** Redeem a one-time setup code at AtlasBurn; the new key comes back only to this process. */
async function claimKey(code: string): Promise<string> {
  const res = await fetch(CLAIM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const j = (await res.json().catch(() => ({}))) as { apiKey?: string; message?: string };
  if (!res.ok || !j.apiKey) throw new Error(j.message || `claim failed (${res.status})`);
  return j.apiKey;
}

// Detected packages → providers AtlasBurn actually instruments (SDK AI_PATTERNS).
const PROVIDER_MAP: Array<{ pkgs: string[]; name: string }> = [
  { pkgs: ["openai"], name: "OpenAI" },
  { pkgs: ["@anthropic-ai/sdk"], name: "Anthropic" },
  { pkgs: ["@google/generative-ai", "@google-cloud/vertexai", "@google-ai/generativelanguage"], name: "Google (Gemini/Vertex)" },
  { pkgs: ["@azure/openai"], name: "Azure OpenAI" },
  { pkgs: ["cohere-ai"], name: "Cohere" },
  { pkgs: ["@mistralai/mistralai"], name: "Mistral" },
  { pkgs: ["groq-sdk"], name: "Groq" },
  { pkgs: ["together-ai", "@togetherai/sdk"], name: "Together AI" },
  { pkgs: ["@aws-sdk/client-bedrock-runtime"], name: "AWS Bedrock" },
];
function detectProviders(pkg: Record<string, any>): string[] {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return PROVIDER_MAP.filter((p) => p.pkgs.some((n) => n in deps)).map((p) => p.name);
}

// ── network checks ───────────────────────────────────────────────────────────
async function gateCheck(key: string): Promise<{ ok: boolean; code: number; status?: string; error?: string }> {
  try {
    const res = await fetch(GATE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status === 401) return { ok: false, code: 401, error: "Invalid or revoked API key" };
    const j = (await res.json().catch(() => ({}))) as { status?: string };
    return { ok: res.ok, code: res.status, status: j.status };
  } catch (e: any) {
    return { ok: false, code: 0, error: e?.message || "network error" };
  }
}

// ── change planning (consent + diff) ─────────────────────────────────────────
interface Change {
  file: string; kind: "create" | "modify"; added: number; removed: number;
  previewLines: string[]; apply: () => void;
}

function rel(p: string) { return path.relative(process.cwd(), p) || p; }

function printChange(ch: Change) {
  const tag = ch.kind === "create" ? C.green("create") : C.yellow("modify");
  console.log(`\n  ${tag} ${C.bold(rel(ch.file))}  ${C.green("+" + ch.added)} ${C.red("-" + ch.removed)}`);
  for (const l of ch.previewLines) console.log("    " + l);
}

/** Ask consent for a set of changes, showing each diff. Returns whether to apply. */
async function reviewAndApply(changes: Change[]): Promise<boolean> {
  if (changes.length === 0) { console.log(info("Nothing to change — already set up.")); return false; }
  console.log(C.bold("\nPlanned changes:"));
  changes.forEach(printChange);
  const totalAdd = changes.reduce((n, c) => n + c.added, 0);
  const totalDel = changes.reduce((n, c) => n + c.removed, 0);
  console.log(`\n  ${changes.length} file(s), ${C.green("+" + totalAdd)} ${C.red("-" + totalDel)}`);
  if (FLAGS.dryRun) { console.log(warn("--dry-run: nothing written.")); return false; }
  const go = await confirm("\nApply these changes?", false);
  if (!go) { console.log(info("Aborted — no changes written.")); return false; }
  for (const ch of changes) ch.apply();
  console.log(ok("Changes written."));
  return true;
}

// ── init writers ─────────────────────────────────────────────────────────────
function planEnv(project: Project, key: string): Change | null {
  const file = project.envFile;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (new RegExp(`^\\s*${ENV_VAR}\\s*=`, "m").test(existing)) return null; // idempotent
  const line = `${ENV_VAR}=${key}`;
  return {
    file, kind: existing ? "modify" : "create", added: 1, removed: 0,
    previewLines: [C.green(`+ ${ENV_VAR}=${maskKey(key)}`)], // key masked in preview
    apply: () => {
      const base = existing && !existing.endsWith("\n") ? existing + "\n" : existing;
      fs.writeFileSync(file, base + line + "\n");
    },
  };
}

function planGitignore(project: Project): Change | null {
  const gi = path.join(project.root, ".gitignore");
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (content.split(/\r?\n/).some((l) => l.trim() === project.envFileName)) return null;
  // Creating .gitignore from scratch in a Node project: keep node_modules out too.
  const lines = !content && project.pkgPath ? ["node_modules/", project.envFileName] : [project.envFileName];
  return {
    file: gi, kind: content ? "modify" : "create", added: lines.length, removed: 0,
    previewLines: lines.map((l) => C.green(`+ ${l}`)),
    apply: () => {
      const base = content && !content.endsWith("\n") ? content + "\n" : content;
      fs.writeFileSync(gi, base + lines.join("\n") + "\n");
    },
  };
}

/** atlasburn.ts|js as written by CLI ≤ 1.11.0 — replaced in place on re-run (it never loaded .env). */
function legacySnippet(): string {
  return `import { initAtlasBurnAuto } from "@atlasburn/sdk";

// Initialize ONCE at the top, before importing any AI SDK. The if-guard narrows
// ${ENV_VAR} to a string (type-safe under strict: true); no key -> stays dormant.
if (process.env.${ENV_VAR}) {
  initAtlasBurnAuto({ apiKey: process.env.${ENV_VAR} });
} else {
  console.warn("[AtlasBurn] ${ENV_VAR} not set - telemetry disabled.");
}
`;
}

/**
 * The init module imported first by the app's entry. Plain Node (unlike Next, Vite,
 * Remix…) never reads .env, so the key the CLI just wrote would be invisible to
 * `npm start` and the SDK would stay dormant. The module therefore reads
 * ATLASBURN_KEY from the env file itself when the environment doesn't already set
 * it: works with any runner (node, tsx, nodemon, pm2), needs no dotenv, touches no
 * other variable, and is a no-op where the platform injects the key.
 * CommonJS JavaScript gets require() — `import` there is a SyntaxError at startup.
 */
function initSnippet(project: Project): string {
  const cjs = !project.isESM && !project.isTypeScript;
  const imports = cjs
    ? `const { readFileSync } = require("node:fs");`
    : `import { readFileSync } from "node:fs";
import { initAtlasBurnAuto } from "@atlasburn/sdk";`;
  return `${imports}

// Plain Node doesn't read ${project.envFileName} on its own: pick up ${ENV_VAR} from it when
// the environment doesn't already set it (hosting platforms usually set it directly).
if (!process.env.${ENV_VAR}) {
  try {
    const m = readFileSync("${project.envFileName}", "utf8").match(/^\\s*(?:export\\s+)?${ENV_VAR}\\s*=\\s*["']?([^"'\\s#]+)/m);
    if (m) process.env.${ENV_VAR} = m[1];
  } catch {
    // no ${project.envFileName} here - that's fine
  }
}

${cjs ? CJS_INIT : ESM_INIT}`;
}

const ESM_INIT = `// Initialize ONCE at the top, before importing any AI SDK. The if-guard narrows
// ${ENV_VAR} to a string (type-safe under strict: true); no key -> stays dormant.
if (process.env.${ENV_VAR}) {
  initAtlasBurnAuto({ apiKey: process.env.${ENV_VAR} });
} else {
  console.warn("[AtlasBurn] ${ENV_VAR} not set - telemetry disabled.");
}
`;

// The SDK is ESM. Node 20.19+ / 22.12+ require() it synchronously; older Node can't,
// so fall back to import() (patches fetch a moment later; upgrading Node avoids that).
const CJS_INIT = `// Initialize ONCE at the top, before requiring any AI SDK; no key -> stays dormant.
if (process.env.${ENV_VAR}) {
  const start = ({ initAtlasBurnAuto }) => initAtlasBurnAuto({ apiKey: process.env.${ENV_VAR} });
  try {
    start(require("@atlasburn/sdk"));
  } catch (e) {
    if (e && e.code !== "ERR_REQUIRE_ESM") throw e;
    console.warn("[AtlasBurn] Node " + process.versions.node + " can't require() ESM - loading async; use Node 22+ to track calls made at startup.");
    import("@atlasburn/sdk").then(start, () => {});
  }
} else {
  console.warn("[AtlasBurn] ${ENV_VAR} not set - telemetry disabled.");
}
`;

function planNextInstrumentation(project: Project): Change | null {
  // Next auto-loads instrumentation.ts / src/instrumentation.ts — no entry edit needed.
  const inSrc = fs.existsSync(path.join(project.root, "src"));
  const file = path.join(project.root, inSrc ? "src" : ".", project.isTypeScript ? "instrumentation.ts" : "instrumentation.js");
  if (fs.existsSync(file)) {
    const txt = fs.readFileSync(file, "utf8");
    if (txt.includes("initAtlasBurnAuto")) return null; // already wired
    return null; // present but not ours → we'll print manual guidance instead of editing register()
  }
  const body = `export async function register() {
  // Next.js calls register() in both the Node.js and Edge runtimes; AtlasBurn
  // patches the Node.js server only (Edge has no process lifecycle to flush on).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initAtlasBurnAuto } = await import("@atlasburn/sdk");
  // if-guard narrows ${ENV_VAR} to string (type-safe under strict: true).
  if (process.env.${ENV_VAR}) {
    initAtlasBurnAuto({ apiKey: process.env.${ENV_VAR} });
  } else {
    console.warn("[AtlasBurn] ${ENV_VAR} not set - telemetry disabled.");
  }
}
`;
  return {
    file, kind: "create", added: body.split("\n").length - 1, removed: 0,
    previewLines: body.trimEnd().split("\n").map((l) => C.green("+ " + l)),
    apply: () => fs.writeFileSync(file, body),
  };
}

function planNodeInit(project: Project): Change[] {
  const changes: Change[] = [];
  const ext = project.isTypeScript ? "ts" : "js";
  // Write atlasburn.ts INSIDE src/ when the project has one — otherwise it sits
  // outside tsconfig's include (["src/**/*.ts"]) and TypeScript never sees it.
  // Fall back to the project root only when there is no src/ directory.
  const inSrc = fs.existsSync(path.join(project.root, "src"));
  const initFile = path.join(project.root, inSrc ? "src" : ".", `atlasburn.${ext}`);
  const snippet = initSnippet(project);
  if (!fs.existsSync(initFile)) {
    changes.push({
      file: initFile, kind: "create", added: snippet.split("\n").length - 1, removed: 0,
      previewLines: snippet.trimEnd().split("\n").map((l) => C.green("+ " + l)),
      apply: () => fs.writeFileSync(initFile, snippet),
    });
  } else {
    const current = fs.readFileSync(initFile, "utf8");
    if (current.replace(/\r\n/g, "\n") === legacySnippet()) {
      // Our own ≤1.11.0 file, unedited: upgrade it so it also reads the env file.
      changes.push({
        file: initFile, kind: "modify", added: snippet.split("\n").length - 1, removed: current.split("\n").length - 1,
        previewLines: [C.green(`+ reads ${ENV_VAR} from ${project.envFileName} when it isn't already set`), C.gray("  … (replaces the file AtlasBurn wrote earlier)")],
        apply: () => fs.writeFileSync(initFile, snippet),
      });
    } else if (!/readFileSync\(["']\.env|dotenv|loadEnvFile|env-file/.test(current)) {
      console.log(warn(`${path.relative(process.cwd(), initFile)} exists and was edited — make sure ${ENV_VAR} is loaded before it runs (Node: \`node --env-file=${project.envFileName}\`, or dotenv).`));
    }
  }
  // Auto-inject an import at the very top of the entry (consent shown by reviewAndApply).
  if (project.entryFile && fs.existsSync(project.entryFile)) {
    const entry = fs.readFileSync(project.entryFile, "utf8");
    // Import path relative to the entry file (always .js at runtime), so it resolves
    // whether atlasburn ended up next to the entry or in src/.
    let rel = path.relative(path.dirname(project.entryFile), initFile).replace(/\\/g, "/").replace(/\.(ts|js)$/, ".js");
    if (!rel.startsWith(".")) rel = "./" + rel;
    const importLine = project.isESM ? `import "${rel}";` : `require("${rel}");`;
    // Match on the base name so .ts/.js/extension differences don't cause a double-inject.
    if (!/atlasburn(\.js)?["')]/.test(entry)) {
      changes.push({
        file: project.entryFile, kind: "modify", added: 1, removed: 0,
        previewLines: [C.green(`+ ${importLine}`), C.gray("  … (prepended as the first line)")],
        apply: () => fs.writeFileSync(project.entryFile!, importLine + "\n" + entry),
      });
    }
  }
  return changes;
}

// ── commands ─────────────────────────────────────────────────────────────────
function doctorReport(project: Project | null) {
  const major = parseInt(process.versions.node.split(".")[0] || "0", 10);
  const fetchOk = typeof (globalThis as any).fetch === "function";
  console.log(C.bold("\nabn doctor\n"));
  console.log(major >= MIN_NODE ? ok(`Node ${process.versions.node} (≥ ${MIN_NODE})`) : bad(`Node ${process.versions.node} — need ≥ ${MIN_NODE} to patch fetch`));
  console.log(fetchOk ? ok("global fetch available") : bad("global fetch missing — upgrade Node or add a fetch polyfill"));
  console.log(info(`runtime: ${typeof (globalThis as any).EdgeRuntime !== "undefined" ? "edge" : "node"}`));
  if (project) {
    console.log(info(`project: ${project.framework}${project.isTypeScript ? " · TypeScript" : ""} · ${project.packageManager} · ${project.isESM ? "ESM" : "CJS"}`));
    const envSet = fs.existsSync(project.envFile) && new RegExp(`^\\s*${ENV_VAR}\\s*=`, "m").test(fs.readFileSync(project.envFile, "utf8"));
    console.log(envSet ? ok(`${ENV_VAR} present in ${project.envFileName}`) : warn(`${ENV_VAR} not set — run \`abn init\``));
  } else {
    console.log(warn("no package.json here — run inside your project"));
  }
  return { major, fetchOk };
}

async function cmdDoctor() { doctorReport(detectProject()); }

function loadKeyFromEnvFiles(project: Project | null): string | null {
  if (process.env[ENV_VAR]) return process.env[ENV_VAR] as string;
  if (!project) return null;
  for (const name of [project.envFileName, ".env.local", ".env"]) {
    const f = path.join(project.root, name);
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, "utf8").match(new RegExp(`^\\s*${ENV_VAR}\\s*=\\s*(.+)\\s*$`, "m"));
      if (m) return sanitizeKey(m[1]);
    }
  }
  return null;
}

async function cmdTest(explicitKey?: string) {
  const project = detectProject();
  const key = explicitKey || loadKeyFromEnvFiles(project);
  if (!key) { console.log(bad(`No key found. Set ${ENV_VAR} or run \`abn init\`.`)); process.exitCode = 1; return; }
  process.stdout.write(info("Checking key + connectivity… "));
  const res = await gateCheck(key);
  if (res.ok) {
    console.log(ok(`connected (guardrails: ${res.status || "active"})`));
    try {
      await verifyAtlasBurn({ apiKey: key, ingestUrl: INGEST_URL });
      console.log(ok("sent a verification event — check the dashboard: " + C.cyan(DASH_URL)));
    } catch { /* fire-and-forget; never fail the test on the pulse */ }
  } else {
    console.log(bad(res.code === 401 ? "invalid or revoked key" : `could not reach AtlasBurn (${res.error || res.code})`));
    process.exitCode = 1;
  }
}

async function cmdStatus() {
  const project = detectProject();
  const key = loadKeyFromEnvFiles(project);
  if (!key) { console.log(bad(`No key found. Run \`abn init\`.`)); process.exitCode = 1; return; }
  const res = await gateCheck(key);
  if (!res.ok) { console.log(bad(res.code === 401 ? "invalid or revoked key" : `unreachable (${res.error || res.code})`)); process.exitCode = 1; return; }
  const s = res.status || "active";
  const line = s === "active" ? ok("Guardrails: ACTIVE — traffic flowing")
    : s === "throttled" ? warn("Guardrails: THROTTLED — soft budget breach")
    : s === "suspended" ? bad("Guardrails: SUSPENDED — hard budget breach (resume in dashboard)")
    : info(`Guardrails: ${s}`);
  console.log(line);
}

async function cmdInit() {
  console.log(C.bold("\nAtlasBurn setup — abn init\n"));
  const project = detectProject() ?? (FLAGS.proxy ? genericProject() : null);
  if (!project) {
    console.log(bad("No package.json here. Run this inside your project (or add --proxy for non-Node projects)."));
    process.exitCode = 1; return;
  }
  if (SETUP_CODE && !SETUP_CODE.startsWith(SETUP_CODE_PREFIX)) {
    console.log(bad(`--code should start with "${SETUP_CODE_PREFIX}".`));
    process.exitCode = 1; return;
  }

  // 1. Detected summary
  console.log(C.bold("Detected:"));
  console.log(info(FLAGS.proxy && !project.pkgPath
    ? "any language (Edge Proxy)"
    : `${project.framework}${project.isTypeScript ? " · TypeScript" : ""} · ${project.packageManager} · ${project.isESM ? "ESM" : "CJS"}`));
  if (FLAGS.proxy) console.log(info("method: Edge Proxy (no SDK code changes)"));
  console.log(info(`env file: ${project.envFileName}`));
  console.log(info(`entry: ${project.entryFile ? rel(project.entryFile) : "not found"}`));

  // 2. Compatibility gate (safe-fail)
  const major = parseInt(process.versions.node.split(".")[0] || "0", 10);
  const fetchOk = typeof (globalThis as any).fetch === "function";
  let envOnly = FLAGS.proxy;
  if (!FLAGS.proxy && (major < MIN_NODE || !fetchOk)) {
    console.log(warn(`Node ${process.versions.node} detected. AtlasBurn patches global fetch, which needs Node ≥ ${MIN_NODE}.`));
    console.log(C.dim("   Nothing has been changed. Recommended: upgrade to Node 20+, or use the edge-proxy method."));
    envOnly = await confirm("Continue with env-only setup (write the key, skip code wiring)?", false); // default N
    if (!envOnly) { console.log(info("Stopped. No changes made.")); return; }
  }

  // 3. Provider auto-detection → confirm [Y/edit]
  let providers = detectProviders(project.pkg);
  if (providers.length > 0) {
    console.log(`\n${C.bold("Detected providers:")} ${providers.join(", ")}`);
    const a = FLAGS.yes ? "y" : (await ask(`Use these? ${C.dim("[Y/edit]")} `)).trim().toLowerCase();
    if (a === "edit" || a === "e") {
      const raw = await ask("Enter providers (comma-separated), or blank to keep detected: ");
      if (raw.trim()) providers = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  } else {
    console.log(info("No AI-provider SDKs detected — the SDK auto-detects providers at runtime regardless."));
    const raw = FLAGS.yes ? "" : await ask("List providers you use (optional, comma-separated): ");
    if (raw.trim()) providers = raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (providers.length) console.log(C.dim(`   (informational only — instrumentation covers all matching providers)`));

  // 4. Key: setup code (MCP flow) → env var (--yes) → masked prompt.
  let key = "";
  const envAlreadySet = fs.existsSync(project.envFile) && new RegExp(`^\\s*${ENV_VAR}\\s*=`, "m").test(fs.readFileSync(project.envFile, "utf8"));
  if (SETUP_CODE && envAlreadySet) {
    // Don't mint a key nobody will use: keep the existing one, leave the code unredeemed.
    console.log(warn(`${ENV_VAR} is already set in ${project.envFileName} — keeping it. The setup code was not used.`));
    key = loadKeyFromEnvFiles(project) || "";
  } else if (SETUP_CODE) {
    process.stdout.write(info("Redeeming setup code… "));
    try {
      key = sanitizeKey(await claimKey(SETUP_CODE));
      console.log(ok("new key created"));
    } catch (e: any) {
      console.log(bad(e?.message || "couldn't redeem the setup code"));
      process.exitCode = 1; return;
    }
  } else if (FLAGS.yes && process.env[ENV_VAR]) {
    key = sanitizeKey(process.env[ENV_VAR] as string);
  } else {
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await askMasked(`\nPaste your AtlasBurn ingest key (${C.dim("input hidden")}): `);
      key = sanitizeKey(raw);
      if (!key) { console.log(bad("Empty key.")); continue; }
      if (!validPrefix(key)) { console.log(bad(`Key should start with "${KEY_PREFIX}". Get one from ${DASH_URL}.`)); key = ""; continue; }
      break;
    }
  }
  if (!key || !validPrefix(key)) { console.log(bad("No valid key provided. Aborting.")); process.exitCode = 1; return; }
  console.log(ok(`Key ready (${maskKey(key)})`));

  // Fail-fast: verify the key before writing anything.
  process.stdout.write(info("Verifying key… "));
  const check = await gateCheck(key);
  if (!check.ok && check.code === 401) { console.log(bad("this key is invalid or revoked. Aborting — nothing written.")); process.exitCode = 1; return; }
  console.log(check.ok ? ok("valid") : warn(`couldn't verify now (${check.error || check.code}); continuing`));

  // 5. Plan writes + consent + diff
  const changes: Change[] = [];
  const envChange = planEnv(project, key); if (envChange) changes.push(envChange);
  const giChange = planGitignore(project); if (giChange) changes.push(giChange);
  if (!envOnly) {
    if (project.isNext) {
      const next = planNextInstrumentation(project);
      if (next) changes.push(next);
      else console.log(info("instrumentation file already present — add `initAtlasBurnAuto({ apiKey: process.env." + ENV_VAR + " })` inside its register() if not already there."));
    } else {
      changes.push(...planNodeInit(project));
    }
  }

  const applied = await reviewAndApply(changes);
  if (FLAGS.proxy) printProxyGuide(providers);

  // 6. Auto-run test
  if (applied || envOnly) {
    console.log(C.bold("\nRunning abn test…"));
    await cmdTest(key);
  }
  console.log(C.dim(`\nDone. Dashboard: ${DASH_URL}`));
}

// ── dispatch ─────────────────────────────────────────────────────────────────
function help() {
  console.log(`${C.bold("abn")} — AtlasBurn CLI

  ${C.cyan("abn init")}     Set up AtlasBurn in this project (detect → confirm → write → test)
  ${C.cyan("abn test")}     Verify key + connectivity (sends one verification event)
  ${C.cyan("abn status")}   Show current guardrail state
  ${C.cyan("abn doctor")}   Environment diagnostics

  Flags: ${C.dim("--dry-run")} (preview, write nothing), ${C.dim("--yes")} (no prompts),
         ${C.dim("--code <abset_…>")} (one-time setup code from Claude/AtlasBurn MCP), ${C.dim("--proxy")} (Edge Proxy: env only, any language)`);
}

(async () => {
  try {
    switch (cmd) {
      case "init": await cmdInit(); break;
      case "test": await cmdTest(); break;
      case "status": await cmdStatus(); break;
      case "doctor": await cmdDoctor(); break;
      case undefined: case "help": case "-h": case "--help": help(); break;
      default: console.log(bad(`Unknown command: ${cmd}`)); help(); process.exitCode = 1;
    }
  } catch (e: any) {
    console.error(bad(e?.message || "unexpected error"));
    process.exitCode = 1;
  }
})();
