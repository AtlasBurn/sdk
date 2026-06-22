/**
 * AtlasBurn SDK — basic usage.
 *
 * Run: ATLASBURN_KEY=abn_... npx tsx examples/basic.ts
 */
import { initAtlasBurnAuto } from "@atlasburn/sdk";

// 1. Initialize once at the top of your app (patches globalThis.fetch).
initAtlasBurnAuto({
  apiKey: process.env.ATLASBURN_KEY!,
  metadata: { featureId: "demo" },
  debug: true,
});

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

  const data = await res.json();
  console.log(data.choices?.[0]?.message?.content);
  // → usage was captured + costed in your AtlasBurn Forensic Ledger. No extra code.
}

main();
