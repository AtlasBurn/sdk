/**
 * AtlasBurn Forensic SDK - v1.9.3 (Universal Support)
 *
 * THE 4 LAWS OF SDK SAFETY:
 * 1. Never crash host app
 * 2. Never block host request
 * 3. Never leak secrets
 * 4. Always fail silently
 */
export interface AtlasBurnSDKOptions {
    apiKey: string;
    authToken?: string;
    projectId?: string;
    ingestUrl?: string;
    gateUrl?: string;
    batchSize?: number;
    maxQueueSize?: number;
    metadata?: AtlasBurnMetadata;
    debug?: boolean;
    /** How long one guardrail gate check may take before failing open. Default 2500ms. */
    gateTimeoutMs?: number;
    /** How long a gate decision is reused per feature before re-checking. Default 10000ms;
     *  0 checks before every call. Stale decisions (up to 60s) are served while a
     *  background refresh runs, so most AI calls never wait on the gate. */
    gateCacheMs?: number;
    /** While a feature is throttled, minimum gap between its AI calls. Default 2000ms. */
    throttleSpacingMs?: number;
    /** While throttled, the longest a call may wait for its slot; deeper queues get a
     *  blocked response instead of stalling. Default 10000ms. */
    throttleMaxWaitMs?: number;
    /** Operator hook for capture/gate anomalies — e.g. a provider usage-format change
     *  that would otherwise silently record $0, or a dropped flush/gate call. Fired
     *  out-of-band; wrapped so it never throws into the host (Law 1). Wire it to your
     *  monitoring to break the silence of Law 4. (SEC-002 #3) */
    onError?: (info: AtlasBurnDiagnostic) => void;
}
/** A capture/gate anomaly surfaced via `options.onError` (and a `debug` log). */
export interface AtlasBurnDiagnostic {
    stage: 'capture_json_failed' | 'capture_stream_failed' | 'zero_usage' | 'zero_usage_stream' | 'gate_error' | 'flush_failed';
    url?: string;
    model?: string;
    error?: unknown;
}
export interface AtlasBurnMetadata {
    featureId?: string;
    userTier?: string;
    environment?: string;
    sdkVersion?: string;
}
/**
 * I1 — hosts auto-detected by the fetch patch. `url.includes(p)` match, so these
 * are substrings (handles regional/subdomain variants like
 * `my-resource.openai.azure.com` and `bedrock-runtime.us-east-1.amazonaws.com`).
 * Kept in sync with the proxy's PROVIDER_MAP — see docs/integration-matrix.md.
 * NOTE: Azure/Vertex/Bedrock are SDK-detectable here but can NOT be transparently
 * proxied (deployment-scoped URLs / OAuth+project paths / SigV4 signing).
 */
export declare const AI_PATTERNS: string[];
/**
 * Response returned when the gate reports the guardrail is suspended (gate.blocked).
 *
 * Returns a PROVIDER-NATIVE error envelope with HTTP 429, not a one-shape-fits-all
 * 200. Two problems that fixes (SEC-002 #2):
 *   - The old OpenAI-shaped `{choices:[...]}` body threw in Anthropic/Gemini/stream
 *     clients that expect a different shape.
 *   - The old HTTP 200 made an agent loop read "blocked" as a NORMAL answer and keep
 *     going. A 429 makes the provider's own SDK raise its rate-limit error, which
 *     agent frameworks handle by backing off / stopping — and for stream:true the
 *     SDK checks status before reading the stream, so no SSE body is needed.
 *
 * The `x-atlasburn-blocked` header + `_atlasburn` body field positively identify a
 * guardrail block (vs. a real provider 429). Exported for tests.
 */
export declare function buildBlockedResponse(url: string, gate: {
    message?: string;
    reason?: string;
}): Response;
/**
 * Rough, dependency-free token estimate (~4 chars/token). Used ONLY as a
 * fallback when a provider streams a response WITHOUT usage data (e.g. OpenAI
 * SSE when `stream_options.include_usage` couldn't be injected). Records derived
 * this way are flagged `estimated:true` and must be treated as approximate —
 * never as exact billing truth. We deliberately avoid a heavyweight BPE
 * tokenizer dependency (Law 1: never crash/burden the host app).
 */
export declare function estimateTokens(text: string): number;
/**
 * I3 — pure body transform. OpenAI omits token usage from SSE responses unless
 * the request opts in with `stream_options:{include_usage:true}`, so streamed
 * OpenAI calls otherwise log $0 tokens. Given a raw JSON request body, inject
 * the flag when the request streams without it. Returns the (possibly unchanged)
 * body, the extracted prompt text, and whether injection happened. Pure +
 * exported so tests and other transports can reuse it. Fails open.
 */
export declare function injectStreamUsage(bodyText: string): {
    body: string;
    promptText: string;
    injected: boolean;
};
/**
 * I1 — extract prompt/completion token counts across provider response shapes:
 *  - OpenAI-compatible: usage.prompt_tokens / completion_tokens
 *    (OpenAI, Azure, OpenRouter, Mistral, Groq, Together, DeepSeek, xAI)
 *  - Anthropic: usage.input_tokens / output_tokens
 *  - Gemini: usageMetadata.promptTokenCount / candidatesTokenCount
 *  - Cohere: nested under usage|meta . billed_units|tokens . input_tokens/output_tokens
 * (Bedrock reports counts in HTTP headers, handled separately at the response.)
 */
export declare function extractTokenUsage(obj: any): {
    prompt: number;
    completion: number;
};
type GateDecision = {
    blocked: boolean;
    status: string;
    message?: string;
    reason?: string;
    failed?: boolean;
};
declare class AtlasBurnIngestor {
    private queue;
    private options;
    private isProcessing;
    private pendingFlush;
    private maxRetries;
    private resolvedIngestUrl;
    private resolvedGateUrl;
    private flushInterval;
    private gateCache;
    private gateInflight;
    private throttleNext;
    constructor(options: AtlasBurnSDKOptions);
    /** Report a capture/gate anomaly out-of-band: a `debug` log + the operator
     *  `onError` callback. Never throws into the host (Law 1), never blocks (Law 2) —
     *  it just breaks the silence so a provider format change isn't an invisible $0. */
    diag(info: AtlasBurnDiagnostic): void;
    checkGate(featureId: string): Promise<GateDecision>;
    /**
     * Guardrail decision for a feature, without paying a gate round-trip on every AI
     * call. Fresh (< gateCacheMs) → reuse. Stale (< 60s) → reuse and refresh in the
     * background. Missing/too old → wait for a check. Concurrent callers share one
     * in-flight check. A failed check never overwrites a known decision (so a known
     * block isn't lifted by one network blip); with no known decision it fails open.
     */
    gateDecision(featureId: string): Promise<GateDecision>;
    private refreshGate;
    /** Forget cached gate decisions (tests, or after changing guardrails locally). */
    clearGateCache(): void;
    /**
     * Pace a throttled feature to one call per `throttleSpacingMs` (default 2s, the
     * same delay the edge proxy applies). Each call reserves the next free slot, so
     * concurrent calls queue in order. Returns false — without waiting — when the
     * slot is more than `throttleMaxWaitMs` away (default 10s): a flood that deep is
     * held back with a blocked response instead of stalling the host indefinitely.
     * Only reached when the gate says "throttled", which only Throttle and Kill
     * Switch modes ever do; Alert mode never slows a call.
     */
    paceThrottled(featureId: string): Promise<boolean>;
    enqueue(event: any): void;
    /**
     * Flush the queue. Coalesces concurrent callers onto ONE draining promise and
     * resolves only when the queue is fully drained — so a single `await flush()`
     * delivers EVERYTHING queued, including events enqueued while an earlier flush
     * was still in flight. (Previously a burst of enqueues + one `await flush()`
     * delivered only the first batch because of an `isProcessing` early-return.)
     */
    flush(): Promise<void>;
    private drain;
    private sendWithRetry;
}
export declare function getIngestor(options?: AtlasBurnSDKOptions): AtlasBurnIngestor | null;
/** Request header that tags one AI call with a product feature. Stripped by the SDK
 *  before the request reaches the provider. */
export declare const ATLASBURN_FEATURE_HEADER = "x-atlasburn-feature";
/**
 * Tag a single AI call with the product feature it belongs to, so AtlasBurn can
 * break cost down by feature. Pass as request headers on any fetch-based client:
 *
 *   client.messages.create(params, { headers: atlasburnFeature("support-chat") })   // Anthropic
 *   client.chat.completions.create(params, { headers: atlasburnFeature("search") }) // OpenAI
 *
 * For one feature per process, set `metadata.featureId` in `initAtlasBurnAuto` instead.
 */
export declare function atlasburnFeature(featureId: string): Record<string, string>;
/** Normalize a feature name: trimmed, max 100 chars, safe characters only. */
export declare function sanitizeFeatureId(raw: unknown): string | undefined;
/**
 * Read and REMOVE the feature header from outgoing fetch args, so the provider never
 * sees it. Handles a `Request` input and `init.headers` as Headers, [k, v][] or a
 * record. Fails OPEN — any error returns the original args untouched.
 */
export declare function takeFeatureHeader(args: Parameters<typeof fetch>): {
    args: Parameters<typeof fetch>;
    featureId?: string;
};
export declare function initAtlasBurnAuto(options: AtlasBurnSDKOptions): void;
export declare function verifyAtlasBurn(options: AtlasBurnSDKOptions): Promise<void>;
export {};
