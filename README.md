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
```

```typescript
import { initAtlasBurnAuto } from "@atlasburn/sdk";

// Call once at the top of your app. That's it.
initAtlasBurnAuto({ apiKey: process.env.ATLASBURN_KEY });

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
} from "@atlasburn/sdk";
```

### `initAtlasBurnAuto(options)`
Patches `globalThis.fetch`, runs a pre-call gate check, and captures usage from every recognized provider.

```typescript
initAtlasBurnAuto({
  apiKey: process.env.ATLASBURN_KEY!,   // required
  metadata: { featureId: "checkout-summarizer" }, // optional attribution
  batchSize: 5,        // flush after N events (default 5)
  debug: false,        // log interception activity
});
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
Sends a verification pulse without making a real LLM call — perfect for a CI/CD connectivity check.

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

The SDK is fail-open and soft (never blocks your app); the [edge proxy](https://docs.atlasburn.com/docs/edge-proxy) is the hard-enforcement path.

---

## Links

- 📚 **Docs:** [docs.atlasburn.com](https://docs.atlasburn.com)
- 🖥️ **Dashboard:** [app.atlasburn.com](https://app.atlasburn.com)
- 🌐 **Website:** [atlasburn.com](https://atlasburn.com)
- 📦 **npm:** [@atlasburn/sdk](https://www.npmjs.com/package/@atlasburn/sdk)

## License

[Apache-2.0](./LICENSE.md) — free and open source. © 2026 AtlasBurn Institutional.
