# @atlasburn/sdk

**Real-time cost control for AI agents. One line of code.**

[![npm version](https://img.shields.io/npm/v/@atlasburn/sdk.svg)](https://www.npmjs.com/package/@atlasburn/sdk)
[![license](https://img.shields.io/npm/l/@atlasburn/sdk.svg)](./LICENSE.md)
[![providers](https://img.shields.io/badge/providers-13-6B46C1.svg)](#supported-providers)
[![types](https://img.shields.io/badge/types-included-blue.svg)](#)

AtlasBurn is a runtime cost-protection layer for AI systems. This SDK auto-captures token usage and cost from **13 LLM providers** with zero configuration, and — paired with the AtlasBurn platform — **stops runaway agents at the edge before the money is spent.**

> Most tools *monitor* AI spend and show you a dashboard after the bleeding stops. AtlasBurn *controls* it in real time. Enforcement, not observability.

```bash
npm i @atlasburn/sdk
npx abn init        # optional: detects your framework and wires everything up for you
```

```typescript
import { initAtlasBurnAuto } from "@atlasburn/sdk";

// Call once at the top of your app, before importing any AI SDK. That's it.
// The if-guard narrows ATLASBURN_KEY to a string, so this type-checks under strict mode.
if (process.env.ATLASBURN_KEY) {
  initAtlasBurnAuto({ apiKey: process.env.ATLASBURN_KEY });
}

// Every AI call — OpenAI, Anthropic, Gemini, and 10 more — is now
// captured, costed, and (optionally) guarded. No wrappers, no middleware.
```

---

## Why your AI cost dashboard is probably wrong

Here's a bug in nearly every AI-cost tool: **OpenAI omits token usage from streaming responses** unless you send `stream_options: { include_usage: true }`. If your tool naïvely reads usage from the stream, every streamed call logs **$0 tokens** — silently undercounting your real spend.

`@atlasburn/sdk` injects the flag into the outgoing request automatically, parses both JSON and SSE responses across provider field-name variants, and flags any fallback estimate as `estimated` so you always know which numbers are exact vs approximated. Your streaming costs stop reading $0.

---

## Supported providers

Auto-detected by patching `globalThis.fetch` — no per-provider wrappers.

| Provider | Detection | | Provider | Detection |
|---|---|---|---|---|
| OpenAI | ✅ auto | | Cohere | ✅ auto |
| Anthropic | ✅ auto | | Mistral | ✅ auto |
| Google Gemini | ✅ auto | | Groq | ✅ auto |
| Google Vertex AI | ✅ auto | | Together | ✅ auto |
| Azure OpenAI | ✅ auto | | DeepSeek | ✅ auto |
| OpenRouter | ✅ auto | | xAI (Grok) | ✅ auto |
| AWS Bedrock | ✅ auto¹ | | | |

¹ Bedrock token counts are read from response headers (best-effort over `fetch`).

Token extraction handles every shape: OpenAI-compatible (`prompt_tokens`/`completion_tokens`), Anthropic (`input_tokens`/`output_tokens`), Gemini (`usageMetadata`), and Cohere (nested `billed_units`/`tokens`).

**Not on JS/`fetch`?** Python, Go, Java, Ruby, and curl route through the [AtlasBurn edge proxy](https://docs.atlasburn.com/docs/edge-proxy) — language-agnostic, with hard 403/throttle enforcement at the edge.

---

## The 4 Laws of SDK Safety

This SDK touches your production AI path, so it is built to never get in the way:

1. **Never crash the host app.** Every operation is wrapped and fails silently.
2. **Never block the host request.** Telemetry is queued and flushed out-of-band.
3. **Never leak secrets.** API keys are never stored — only HMAC-SHA-256 hashes.
4. **Always fail open.** If AtlasBurn is unreachable, your AI calls proceed normally.

---

## Privacy by design

AtlasBurn stores **metadata only** — model, token counts, cost, latency, feature id. It **never** stores:

- ❌ Prompt content
- ❌ Model completions / outputs
- ❌ End-user personal data inside prompts
- ❌ Raw API keys

Verified: even if a client sends prompt content in an event, the ingestion layer is an allowlist that physically cannot persist it.

---

## API

```typescript
import {
  initAtlasBurnAuto,   // zero-config auto-detect (patches fetch)
  verifyAtlasBurn,     // send a verification pulse (CI/connectivity check)
  getIngestor,         // manual instrumentation: enqueue events yourself
  extractTokenUsage,   // pure helper: parse tokens from any provider response
  injectStreamUsage,   // pure helper: add stream_options.include_usage
  estimateTokens,      // dependency-free fallback token estimate
  buildBlockedResponse,// the provider-native 429 returned when a guardrail blocks a call
} from "@atlasburn/sdk";
```

### `initAtlasBurnAuto(options)`
Patches `globalThis.fetch`, runs a pre-call gate check, and captures usage from every recognized provider.

```typescript
if (process.env.ATLASBURN_KEY) {
  initAtlasBurnAuto({
    apiKey: process.env.ATLASBURN_KEY,               // required
    metadata: { featureId: "checkout-summarizer" },  // optional attribution
    batchSize: 5,        // flush after N events (default 5)
    debug: false,        // log interception activity + diagnostics
    onError: (d) => console.warn("[atlasburn]", d.stage, d.url ?? ""), // optional, see Diagnostics
  });
}
```

### `getIngestor(options)` — manual instrumentation
For frameworks where auto-detect doesn't fit (e.g. Genkit flows), enqueue events directly:

```typescript
const ingestor = getIngestor({ apiKey: process.env.ATLASBURN_KEY });
ingestor?.enqueue({
  model: "gemini-2.5-flash",
  featureId: "flashcard-summary",
  usage: { prompt_tokens: 1842, completion_tokens: 563 },
});
```

### `verifyAtlasBurn(options)`
Sends a verification pulse without making a real LLM call — perfect for a CI/CD connectivity check. The pulse is tagged `apiCallType: "verification"`, so it never shows up as production spend.

---

## CLI — `abn`

The package ships a small CLI (`npx abn <command>`):

| Command | What it does |
|---|---|
| `abn init` | Detects your framework, asks for your ingest key (hidden input, `abn_` prefix-validated), shows a diff and asks before writing. Next.js → `instrumentation.ts`; Node → `atlasburn.ts` plus one import line in your entry file. Both go in `src/` when your project has one (inside a typical tsconfig `include`), otherwise the project root. |
| `abn test` | Verifies your key + connectivity and sends one verification event. |
| `abn status` | Shows the current guardrail state (active / throttled / suspended). |
| `abn doctor` | Environment diagnostics (Node version, `fetch`, project detection). |

Flags: `--dry-run` (preview, write nothing) and `--yes` (no prompts, for CI).

---

## When a guardrail blocks a call

If your project's guardrail is **suspended** (for example a hard-stop budget breach), the SDK short-circuits the AI call **before it reaches the provider**. No tokens are spent. Instead it returns an **HTTP 429 in that provider's own error format**:

| Provider | Error body |
|---|---|
| OpenAI and OpenAI-compatible (Azure, OpenRouter, Groq, Together, DeepSeek, xAI, Mistral) | `{ "error": { "type": "rate_limit_exceeded", "code": "atlasburn_guardrail", … } }` |
| Anthropic | `{ "type": "error", "error": { "type": "rate_limit_error", … } }` |
| Google Gemini / Vertex | `{ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED", … } }` |
| Cohere / Bedrock | `{ "message": … }` (Bedrock also sets `x-amzn-errortype: ThrottlingException`) |

Because it's a real 429, the official provider SDKs raise their normal rate-limit error. Well-behaved agents back off or stop instead of treating the block as an answer and looping, and streaming calls are covered too, since SDKs check the status before reading the stream. To tell an AtlasBurn block apart from a genuine provider 429, check the **`x-atlasburn-blocked: 1`** header (also sent: `x-atlasburn-reason`, `Retry-After: 60`) or the `_atlasburn.blocked` field in the body.

Gate *errors* still fail open: if AtlasBurn can't be reached, your call proceeds normally.

---

## Diagnostics — `onError`

The SDK never throws into your app (Law 1), but a silent failure can hide bad cost data. For example, a provider changing its usage format would otherwise just record $0. Pass `onError` to see these out of band. It's called with `{ stage, url?, model?, error? }`, and a throwing callback can never crash your app.

| `stage` | Meaning |
|---|---|
| `zero_usage` | An AI call returned 200 JSON but no token usage could be read (likely a provider format change). |
| `zero_usage_stream` | A stream ended with no usage and no text to estimate from. |
| `capture_json_failed` / `capture_stream_failed` | Parsing the response for usage threw. |
| `gate_error` | The pre-call gate check failed (the call proceeded, fail-open). |
| `flush_failed` | A telemetry batch couldn't be delivered after retries and was dropped. |

With `debug: true` the same events are also logged to the console.

---

## How it works

```
your app ──► @atlasburn/sdk (patched fetch)
                │  1. pre-call gate check (blocked? throttled? active?)
                │  2. forward the real request (injecting include_usage for OpenAI)
                │  3. parse JSON or SSE response → extract tokens → estimate cost
                ▼
        AtlasBurn platform ──► Forensic Ledger + 5-layer guardrail engine
                                    └─► Cloudflare edge: 403 / throttle
```

The SDK fails open on errors. When a guardrail is suspended it stops the call before it's sent and returns a provider-native 429 (see [above](#when-a-guardrail-blocks-a-call)). The [edge proxy](https://docs.atlasburn.com/docs/edge-proxy) is the language-agnostic hard-enforcement path.

---

## Links

- 📚 **Docs:** [docs.atlasburn.com](https://docs.atlasburn.com)
- 🖥️ **Dashboard:** [app.atlasburn.com](https://app.atlasburn.com)
- 🌐 **Website:** [atlasburn.com](https://atlasburn.com)
- 📦 **npm:** [@atlasburn/sdk](https://www.npmjs.com/package/@atlasburn/sdk)

## License

[Apache-2.0](./LICENSE.md) — free and open source. © 2026 AtlasBurn Institutional.
