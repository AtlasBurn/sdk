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
 */
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { verifyAtlasBurn } from "./index.js";
const ENV_VAR = "ATLASBURN_KEY";
const KEY_PREFIX = "abn_";
const GATE_URL = process.env.ATLASBURN_GATE_URL || "https://app.atlasburn.com/api/gate";
const DASH_URL = "https://app.atlasburn.com";
const MIN_NODE = 18;
// ── tiny ANSI (no deps) ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = {
    dim: paint("2"), bold: paint("1"), green: paint("32"), red: paint("31"),
    yellow: paint("33"), cyan: paint("36"), gray: paint("90"),
};
const ok = (s) => `${C.green("✓")} ${s}`;
const bad = (s) => `${C.red("✗")} ${s}`;
const warn = (s) => `${C.yellow("⚠")}  ${s}`;
const info = (s) => `${C.cyan("›")} ${s}`;
// ── flags ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const cmd = args[0];
const FLAGS = { dryRun: args.includes("--dry-run"), yes: args.includes("--yes") };
// ── prompts (dep-free) ───────────────────────────────────────────────────────
function ask(q) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}
/** No-echo masked input — the typed characters are never rendered. */
function askMasked(q) {
    return new Promise((res) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const anyRl = rl;
        let muted = false;
        anyRl._writeToOutput = (str) => {
            if (muted) {
                if (str.includes("\n"))
                    anyRl.output.write("\n");
                return;
            }
            anyRl.output.write(str);
        };
        rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); res(a); });
        muted = true;
    });
}
async function confirm(q, def = false) {
    if (FLAGS.yes)
        return true;
    const hint = def ? "[Y/n]" : "[y/N]";
    const a = (await ask(`${q} ${C.dim(hint)} `)).trim().toLowerCase();
    if (!a)
        return def;
    return a === "y" || a === "yes";
}
// ── key handling ─────────────────────────────────────────────────────────────
function sanitizeKey(raw) {
    let k = (raw || "").trim();
    k = k.replace(/^["']|["']$/g, ""); // wrapping quotes
    k = k.replace(/^bearer\s+/i, ""); // stray "Bearer "
    k = k.replace(/\s+/g, ""); // any whitespace/newlines from paste
    return k;
}
const validPrefix = (k) => k.startsWith(KEY_PREFIX);
const maskKey = (k) => (k.length > 10 ? `${k.slice(0, 7)}…${k.slice(-3)}` : `${KEY_PREFIX}…`);
function detectProject() {
    const root = process.cwd();
    const pkgPath = path.join(root, "package.json");
    if (!fs.existsSync(pkgPath))
        return null;
    let pkg = {};
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    }
    catch {
        return null;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const has = (n) => n in deps;
    const ex = (f) => fs.existsSync(path.join(root, f));
    const packageManager = ex("pnpm-lock.yaml") ? "pnpm" : ex("yarn.lock") ? "yarn"
        : (ex("bun.lockb") || ex("bun.lock")) ? "bun" : "npm";
    const isNext = has("next");
    const framework = isNext ? "Next.js" : has("express") ? "Express" : has("fastify") ? "Fastify" : "Node";
    const isTypeScript = ex("tsconfig.json") || has("typescript");
    const envFileName = isNext ? ".env.local" : ".env";
    const isESM = pkg.type === "module";
    let entryFile = null;
    const candidates = [pkg.main, pkg.module,
        "src/index.ts", "src/index.js", "index.ts", "index.js",
        "src/main.ts", "src/main.js", "server.ts", "server.js", "app.ts", "app.js"].filter(Boolean);
    for (const cand of candidates) {
        if (ex(cand)) {
            entryFile = path.join(root, cand);
            break;
        }
    }
    return { root, pkgPath, pkg, packageManager, isTypeScript, framework, isNext, envFileName, envFile: path.join(root, envFileName), entryFile, isESM };
}
// Detected packages → providers AtlasBurn actually instruments (SDK AI_PATTERNS).
const PROVIDER_MAP = [
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
function detectProviders(pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return PROVIDER_MAP.filter((p) => p.pkgs.some((n) => n in deps)).map((p) => p.name);
}
// ── network checks ───────────────────────────────────────────────────────────
async function gateCheck(key) {
    try {
        const res = await fetch(GATE_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: "{}",
        });
        if (res.status === 401)
            return { ok: false, code: 401, error: "Invalid or revoked API key" };
        const j = (await res.json().catch(() => ({})));
        return { ok: res.ok, code: res.status, status: j.status };
    }
    catch (e) {
        return { ok: false, code: 0, error: e?.message || "network error" };
    }
}
function rel(p) { return path.relative(process.cwd(), p) || p; }
function printChange(ch) {
    const tag = ch.kind === "create" ? C.green("create") : C.yellow("modify");
    console.log(`\n  ${tag} ${C.bold(rel(ch.file))}  ${C.green("+" + ch.added)} ${C.red("-" + ch.removed)}`);
    for (const l of ch.previewLines)
        console.log("    " + l);
}
/** Ask consent for a set of changes, showing each diff. Returns whether to apply. */
async function reviewAndApply(changes) {
    if (changes.length === 0) {
        console.log(info("Nothing to change — already set up."));
        return false;
    }
    console.log(C.bold("\nPlanned changes:"));
    changes.forEach(printChange);
    const totalAdd = changes.reduce((n, c) => n + c.added, 0);
    const totalDel = changes.reduce((n, c) => n + c.removed, 0);
    console.log(`\n  ${changes.length} file(s), ${C.green("+" + totalAdd)} ${C.red("-" + totalDel)}`);
    if (FLAGS.dryRun) {
        console.log(warn("--dry-run: nothing written."));
        return false;
    }
    const go = await confirm("\nApply these changes?", false);
    if (!go) {
        console.log(info("Aborted — no changes written."));
        return false;
    }
    for (const ch of changes)
        ch.apply();
    console.log(ok("Changes written."));
    return true;
}
// ── init writers ─────────────────────────────────────────────────────────────
function planEnv(project, key) {
    const file = project.envFile;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (new RegExp(`^\\s*${ENV_VAR}\\s*=`, "m").test(existing))
        return null; // idempotent
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
function planGitignore(project) {
    const gi = path.join(project.root, ".gitignore");
    const content = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    if (content.split(/\r?\n/).some((l) => l.trim() === project.envFileName))
        return null;
    return {
        file: gi, kind: content ? "modify" : "create", added: 1, removed: 0,
        previewLines: [C.green(`+ ${project.envFileName}`)],
        apply: () => {
            const base = content && !content.endsWith("\n") ? content + "\n" : content;
            fs.writeFileSync(gi, base + project.envFileName + "\n");
        },
    };
}
function initSnippet() {
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
function planNextInstrumentation(project) {
    // Next auto-loads instrumentation.ts / src/instrumentation.ts — no entry edit needed.
    const inSrc = fs.existsSync(path.join(project.root, "src"));
    const file = path.join(project.root, inSrc ? "src" : ".", project.isTypeScript ? "instrumentation.ts" : "instrumentation.js");
    if (fs.existsSync(file)) {
        const txt = fs.readFileSync(file, "utf8");
        if (txt.includes("initAtlasBurnAuto"))
            return null; // already wired
        return null; // present but not ours → we'll print manual guidance instead of editing register()
    }
    const body = `export async function register() {
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
function planNodeInit(project) {
    const changes = [];
    const ext = project.isTypeScript ? "ts" : "js";
    // Write atlasburn.ts INSIDE src/ when the project has one — otherwise it sits
    // outside tsconfig's include (["src/**/*.ts"]) and TypeScript never sees it.
    // Fall back to the project root only when there is no src/ directory.
    const inSrc = fs.existsSync(path.join(project.root, "src"));
    const initFile = path.join(project.root, inSrc ? "src" : ".", `atlasburn.${ext}`);
    const snippet = initSnippet();
    if (!fs.existsSync(initFile)) {
        changes.push({
            file: initFile, kind: "create", added: snippet.split("\n").length - 1, removed: 0,
            previewLines: snippet.trimEnd().split("\n").map((l) => C.green("+ " + l)),
            apply: () => fs.writeFileSync(initFile, snippet),
        });
    }
    // Auto-inject an import at the very top of the entry (consent shown by reviewAndApply).
    if (project.entryFile && fs.existsSync(project.entryFile)) {
        const entry = fs.readFileSync(project.entryFile, "utf8");
        // Import path relative to the entry file (always .js at runtime), so it resolves
        // whether atlasburn ended up next to the entry or in src/.
        let rel = path.relative(path.dirname(project.entryFile), initFile).replace(/\\/g, "/").replace(/\.(ts|js)$/, ".js");
        if (!rel.startsWith("."))
            rel = "./" + rel;
        const importLine = project.isESM ? `import "${rel}";` : `require("${rel}");`;
        // Match on the base name so .ts/.js/extension differences don't cause a double-inject.
        if (!/atlasburn(\.js)?["')]/.test(entry)) {
            changes.push({
                file: project.entryFile, kind: "modify", added: 1, removed: 0,
                previewLines: [C.green(`+ ${importLine}`), C.gray("  … (prepended as the first line)")],
                apply: () => fs.writeFileSync(project.entryFile, importLine + "\n" + entry),
            });
        }
    }
    return changes;
}
// ── commands ─────────────────────────────────────────────────────────────────
function doctorReport(project) {
    const major = parseInt(process.versions.node.split(".")[0] || "0", 10);
    const fetchOk = typeof globalThis.fetch === "function";
    console.log(C.bold("\nabn doctor\n"));
    console.log(major >= MIN_NODE ? ok(`Node ${process.versions.node} (≥ ${MIN_NODE})`) : bad(`Node ${process.versions.node} — need ≥ ${MIN_NODE} to patch fetch`));
    console.log(fetchOk ? ok("global fetch available") : bad("global fetch missing — upgrade Node or add a fetch polyfill"));
    console.log(info(`runtime: ${typeof globalThis.EdgeRuntime !== "undefined" ? "edge" : "node"}`));
    if (project) {
        console.log(info(`project: ${project.framework}${project.isTypeScript ? " · TypeScript" : ""} · ${project.packageManager} · ${project.isESM ? "ESM" : "CJS"}`));
        const envSet = fs.existsSync(project.envFile) && new RegExp(`^\\s*${ENV_VAR}\\s*=`, "m").test(fs.readFileSync(project.envFile, "utf8"));
        console.log(envSet ? ok(`${ENV_VAR} present in ${project.envFileName}`) : warn(`${ENV_VAR} not set — run \`abn init\``));
    }
    else {
        console.log(warn("no package.json here — run inside your project"));
    }
    return { major, fetchOk };
}
async function cmdDoctor() { doctorReport(detectProject()); }
function loadKeyFromEnvFiles(project) {
    if (process.env[ENV_VAR])
        return process.env[ENV_VAR];
    if (!project)
        return null;
    for (const name of [project.envFileName, ".env.local", ".env"]) {
        const f = path.join(project.root, name);
        if (fs.existsSync(f)) {
            const m = fs.readFileSync(f, "utf8").match(new RegExp(`^\\s*${ENV_VAR}\\s*=\\s*(.+)\\s*$`, "m"));
            if (m)
                return sanitizeKey(m[1]);
        }
    }
    return null;
}
async function cmdTest(explicitKey) {
    const project = detectProject();
    const key = explicitKey || loadKeyFromEnvFiles(project);
    if (!key) {
        console.log(bad(`No key found. Set ${ENV_VAR} or run \`abn init\`.`));
        process.exitCode = 1;
        return;
    }
    process.stdout.write(info("Checking key + connectivity… "));
    const res = await gateCheck(key);
    if (res.ok) {
        console.log(ok(`connected (guardrails: ${res.status || "active"})`));
        try {
            await verifyAtlasBurn({ apiKey: key });
            console.log(ok("sent a verification event — check the dashboard: " + C.cyan(DASH_URL)));
        }
        catch { /* fire-and-forget; never fail the test on the pulse */ }
    }
    else {
        console.log(bad(res.code === 401 ? "invalid or revoked key" : `could not reach AtlasBurn (${res.error || res.code})`));
        process.exitCode = 1;
    }
}
async function cmdStatus() {
    const project = detectProject();
    const key = loadKeyFromEnvFiles(project);
    if (!key) {
        console.log(bad(`No key found. Run \`abn init\`.`));
        process.exitCode = 1;
        return;
    }
    const res = await gateCheck(key);
    if (!res.ok) {
        console.log(bad(res.code === 401 ? "invalid or revoked key" : `unreachable (${res.error || res.code})`));
        process.exitCode = 1;
        return;
    }
    const s = res.status || "active";
    const line = s === "active" ? ok("Guardrails: ACTIVE — traffic flowing")
        : s === "throttled" ? warn("Guardrails: THROTTLED — soft budget breach")
            : s === "suspended" ? bad("Guardrails: SUSPENDED — hard budget breach (resume in dashboard)")
                : info(`Guardrails: ${s}`);
    console.log(line);
}
async function cmdInit() {
    console.log(C.bold("\nAtlasBurn setup — abn init\n"));
    const project = detectProject();
    if (!project) {
        console.log(bad("No package.json here. Run this inside your project."));
        process.exitCode = 1;
        return;
    }
    // 1. Detected summary
    console.log(C.bold("Detected:"));
    console.log(info(`${project.framework}${project.isTypeScript ? " · TypeScript" : ""} · ${project.packageManager} · ${project.isESM ? "ESM" : "CJS"}`));
    console.log(info(`env file: ${project.envFileName}`));
    console.log(info(`entry: ${project.entryFile ? rel(project.entryFile) : "not found"}`));
    // 2. Compatibility gate (safe-fail)
    const major = parseInt(process.versions.node.split(".")[0] || "0", 10);
    const fetchOk = typeof globalThis.fetch === "function";
    let envOnly = false;
    if (major < MIN_NODE || !fetchOk) {
        console.log(warn(`Node ${process.versions.node} detected. AtlasBurn patches global fetch, which needs Node ≥ ${MIN_NODE}.`));
        console.log(C.dim("   Nothing has been changed. Recommended: upgrade to Node 20+, or use the edge-proxy method."));
        envOnly = await confirm("Continue with env-only setup (write the key, skip code wiring)?", false); // default N
        if (!envOnly) {
            console.log(info("Stopped. No changes made."));
            return;
        }
    }
    // 3. Provider auto-detection → confirm [Y/edit]
    let providers = detectProviders(project.pkg);
    if (providers.length > 0) {
        console.log(`\n${C.bold("Detected providers:")} ${providers.join(", ")}`);
        const a = FLAGS.yes ? "y" : (await ask(`Use these? ${C.dim("[Y/edit]")} `)).trim().toLowerCase();
        if (a === "edit" || a === "e") {
            const raw = await ask("Enter providers (comma-separated), or blank to keep detected: ");
            if (raw.trim())
                providers = raw.split(",").map((s) => s.trim()).filter(Boolean);
        }
    }
    else {
        console.log(info("No AI-provider SDKs detected — the SDK auto-detects providers at runtime regardless."));
        const raw = FLAGS.yes ? "" : await ask("List providers you use (optional, comma-separated): ");
        if (raw.trim())
            providers = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (providers.length)
        console.log(C.dim(`   (informational only — instrumentation covers all matching providers)`));
    // 4. Secure key entry (masked, sanitized, prefix-validated)
    let key = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await askMasked(`\nPaste your AtlasBurn ingest key (${C.dim("input hidden")}): `);
        key = sanitizeKey(raw);
        if (!key) {
            console.log(bad("Empty key."));
            continue;
        }
        if (!validPrefix(key)) {
            console.log(bad(`Key should start with "${KEY_PREFIX}". Get one from ${DASH_URL}.`));
            key = "";
            continue;
        }
        break;
    }
    if (!key) {
        console.log(bad("No valid key provided. Aborting."));
        process.exitCode = 1;
        return;
    }
    console.log(ok(`Key accepted (${maskKey(key)})`));
    // Fail-fast: verify the key before writing anything.
    process.stdout.write(info("Verifying key… "));
    const check = await gateCheck(key);
    if (!check.ok && check.code === 401) {
        console.log(bad("this key is invalid or revoked. Aborting — nothing written."));
        process.exitCode = 1;
        return;
    }
    console.log(check.ok ? ok("valid") : warn(`couldn't verify now (${check.error || check.code}); continuing`));
    // 5. Plan writes + consent + diff
    const changes = [];
    const envChange = planEnv(project, key);
    if (envChange)
        changes.push(envChange);
    const giChange = planGitignore(project);
    if (giChange)
        changes.push(giChange);
    if (!envOnly) {
        if (project.isNext) {
            const next = planNextInstrumentation(project);
            if (next)
                changes.push(next);
            else
                console.log(info("instrumentation file already present — add `initAtlasBurnAuto({ apiKey: process.env." + ENV_VAR + " })` inside its register() if not already there."));
        }
        else {
            changes.push(...planNodeInit(project));
        }
    }
    const applied = await reviewAndApply(changes);
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

  Flags: ${C.dim("--dry-run")} (preview, write nothing), ${C.dim("--yes")} (no prompts)`);
}
(async () => {
    try {
        switch (cmd) {
            case "init":
                await cmdInit();
                break;
            case "test":
                await cmdTest();
                break;
            case "status":
                await cmdStatus();
                break;
            case "doctor":
                await cmdDoctor();
                break;
            case undefined:
            case "help":
            case "-h":
            case "--help":
                help();
                break;
            default:
                console.log(bad(`Unknown command: ${cmd}`));
                help();
                process.exitCode = 1;
        }
    }
    catch (e) {
        console.error(bad(e?.message || "unexpected error"));
        process.exitCode = 1;
    }
})();
