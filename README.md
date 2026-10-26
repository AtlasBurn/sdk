# @atlasburn/sdk

**See where your AI spend goes. Catch costly agent behavior before it grows.**

[![npm](https://img.shields.io/npm/v/@atlasburn/sdk?color=4169E1&label=npm)](https://www.npmjs.com/package/@atlasburn/sdk)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4169E1)](./LICENSE.md)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-4169E1)](./package.json)

The open-source SDK behind [AtlasBurn](https://atlasburn.com). Add it to a Node.js or TypeScript app and every AI call
your code already makes is picked up automatically. AtlasBurn then:

- **attributes spend** to the model, feature and workflow that caused it, across 13 AI providers
- **catches costly behavior** like retry storms, repeated identical calls and context that keeps growing
- **acts while it's happening**: alerts, slows down or blocks the one feature that misbehaves, using limits you set

Your provider bill shows the total. This shows the loop that caused it.

---

## Quick start

```bash
# 1. Install the SDK (the abn CLI comes with it)
npm install @atlasburn/sdk

# 2. Run the setup wizard in your project root
npx abn init
```

`abn init` detects your framework, providers and env file, asks for your AtlasBurn key (hidden input, validated),
**shows a diff of exactly what it will change and asks before writing anything**, then sends one verification event
so your dashboard shows the connection. Use `--dry-run` to preview, `--yes` for CI.

Get a key at [app.atlasburn.com](https://app.atlasburn.com) (free during beta).

### Or let your AI assistant set it up

Connect the [AtlasBurn MCP server](https://github.com/AtlasBurn/atlasburn-mcp) in Claude or any MCP client and ask:
*"Set up AtlasBurn in this project."* You approve the key in your browser, and it goes straight to your terminal,
never into the chat.

### Manual setup

```ts
import { initAtlasBurnAuto } from "@atlasburn/sdk";

initAtlasBurnAuto({
  apiKey: process.env.ATLASBURN_KEY,
});
```

Put this at the very top of your app's entry file. It patches `fetch`, so the OpenAI, Anthropic and Google SDKs (and
LangChain, Genkit, or plain `fetch`) are captured with no other code changes, including streaming responses.

## Cost by feature

Tag a call with the product feature it belongs to, and AtlasBurn breaks spend down by feature. The tag is stripped
before the request reaches the provider.

```ts
import { atlasburnFeature } from "@atlasburn/sdk";

await anthropic.messages.create(params, { headers: atlasburnFeature("support-chat") });
await openai.chat.completions.create(params, { headers: atlasburnFeature("search") });
```

One feature per process (a worker or cron job)? Set a default instead:

```ts
initAtlasBurnAuto({ apiKey: process.env.ATLASBURN_KEY, metadata: { featureId: "nightly-digest" } });
```

Tagging also scopes guardrails: a loop in one feature slows down only that feature.

## Supported providers

Detected automatically: **OpenAI, Anthropic, Google Gemini, Vertex AI, Azure OpenAI, AWS Bedrock** (best-effort, via
response headers), **Mistral, Cohere, Groq, DeepSeek, xAI, Together AI and OpenRouter**.

Not on Node.js? Python, Go, Ruby and anything else that makes HTTP calls can route OpenAI, Anthropic, Gemini or
OpenRouter traffic through the [AtlasBurn proxy](https://docs.atlasburn.com) instead. Run `npx abn init --proxy` to
print the base URLs.

## Guardrails

Before each AI call, the SDK asks AtlasBurn whether that feature may proceed (cached per feature for 10 seconds).
What happens next depends on the mode you choose in the dashboard:

| Mode | What your app sees |
| --- | --- |
| **Alert** | Calls are never slowed or blocked. Breaches are only reported. |
| **Throttle** | A throttled feature's calls are spaced 2s apart (`throttleSpacingMs`). They still succeed. A queue deeper than `throttleMaxWaitMs` (10s) gets a blocked response instead of stalling your app. |
| **Kill switch** | A blocked feature gets a provider-shaped `429` with `x-atlasburn-blocked: 1` and `x-should-retry: false`. Budget breaches block at once; loops are throttled first and blocked only if they keep going or cost too much. |

## Safe by design

- **No prompts or outputs leave your app through the SDK.** Each event carries usage only: model, token counts,
  latency, timestamp, a random event ID, your feature label, the SDK version, the environment name, and any
  `metadata` you choose to pass yourself.
- **It fails open.** If AtlasBurn can't be reached, your AI calls go through as normal. The SDK never throws into your
  code and never keeps your process alive.
- **Zero runtime dependencies.** Read every line that runs in your app, right here.
- **Keys stay yours.** Your provider keys never leave your app; your AtlasBurn key is stored by us only as a one-way hash.

## CLI

Bundled with the SDK, run with `npx abn <command>`:

| Command | What it does |
| --- | --- |
| `abn init` | Set up AtlasBurn in this project (`--dry-run`, `--yes`, `--proxy`) |
| `abn test` | Check your key and connection; sends one verification event |
| `abn status` | Show the current guardrail state: active, throttled or suspended |
| `abn doctor` | Diagnose your environment and suggest fixes |

## Troubleshooting

Set `debug: true`, or pass an `onError` callback to see capture problems (for example a provider changing its usage
format) instead of silently recording $0:

```ts
initAtlasBurnAuto({
  apiKey: process.env.ATLASBURN_KEY,
  debug: true,
  onError: (d) => console.warn(`[atlasburn] ${d.stage}`, d.url ?? ""),
});
```

## Links

- Website: [atlasburn.com](https://atlasburn.com)
- Dashboard: [app.atlasburn.com](https://app.atlasburn.com)
- Docs: [docs.atlasburn.com](https://docs.atlasburn.com)
- MCP server: [github.com/AtlasBurn/atlasburn-mcp](https://github.com/AtlasBurn/atlasburn-mcp)

## License

[Apache-2.0](./LICENSE.md). Free and open source. © 2026 AtlasBurn.
