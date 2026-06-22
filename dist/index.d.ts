/**
 * AtlasBurn Forensic SDK - Institutional v1.5.0 (Universal Support)
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
declare class AtlasBurnIngestor {
    private queue;
    private options;
    private isProcessing;
    private pendingFlush;
    private maxRetries;
    private resolvedIngestUrl;
    private resolvedGateUrl;
    private flushInterval;
    constructor(options: AtlasBurnSDKOptions);
    checkGate(featureId: string): Promise<{
        blocked: boolean;
        status: string;
        message?: string;
        reason?: string;
    }>;
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
export declare function initAtlasBurnAuto(options: AtlasBurnSDKOptions): void;
export declare function verifyAtlasBurn(options: AtlasBurnSDKOptions): Promise<void>;
export {};
