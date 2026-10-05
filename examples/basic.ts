/**
 * AtlasBurn SDK — basic usage.
 *
 * Run: ATLASBURN_KEY=abn_... npx tsx examples/basic.ts
 */
import { initAtlasBurnAuto } from "@atlasburn/sdk";

// 1. Initialize once at the top of your app (patches globalThis.fetch).
//    The if-guard narrows ATLASBURN_KEY to a string, so this type-checks under strict mode.
if (process.env.ATLASBURN_KEY) {
  initAtlasBurnAuto({
    apiKey: process.env.ATLASBURN_KEY,
    metadata: { featureId: "demo" },
    debug: true,
    // Surface silent capture problems (e.g. a provider usage-format change → $0).
    onError: (d) => console.warn(`[atlasburn] ${d.stage}`, d.url ?? ""),
  });
} else {
  console.warn("[atlasburn] ATLASBURN_KEY not set — telemetry disabled.");
}

// 2. Make any AI call as you normally would — it's captured automatically.
async function main() {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello in 5 words." }],
      // Streaming works too — AtlasBurn injects stream_options.include_usage
      // so your token counts aren't silently $0.
      stream: false,
    }),
  });

  // 3. If a guardrail suspended this project, the call never reached OpenAI:
  //    you get a provider-native 429 tagged with x-atlasburn-blocked.
  if (res.headers.get("x-atlasburn-blocked") === "1") {
    console.warn("Blocked by AtlasBurn guardrail:", res.headers.get("x-atlasburn-reason"));
    return;
  }

  const data = await res.json();
  console.log(data.choices?.[0]?.message?.content);
  // → usage was captured + costed in your AtlasBurn Forensic Ledger. No extra code.
}

main();
