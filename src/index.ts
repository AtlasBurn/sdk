
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

const SDK_VERSION = "1.11.1";

/**
 * I1 — hosts auto-detected by the fetch patch. `url.includes(p)` match, so these
 * are substrings (handles regional/subdomain variants like
 * `my-resource.openai.azure.com` and `bedrock-runtime.us-east-1.amazonaws.com`).
 * Kept in sync with the proxy's PROVIDER_MAP — see docs/integration-matrix.md.
 * NOTE: Azure/Vertex/Bedrock are SDK-detectable here but can NOT be transparently
 * proxied (deployment-scoped URLs / OAuth+project paths / SigV4 signing).
 */
export const AI_PATTERNS: string[] = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "vertexai.googleapis.com",
  // I1 additions:
  "openai.azure.com",       // Azure OpenAI (deployment-scoped; SDK-only)
  "openrouter.ai",
  "api.cohere.com", "api.cohere.ai",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz", "api.together.ai",
  "api.deepseek.com",
  "api.x.ai",
  "bedrock-runtime",        // AWS Bedrock (token counts via response headers; best-effort)
];

/**
 * The real fetch, captured at module load — BEFORE initAtlasBurnAuto patches
 * globalThis.fetch. The SDK uses this for all of its OWN HTTP (gate + ingest) so
 * those calls never re-enter the patched fetch. This is what lets us drop the old
 * shared `isInternalCall` recursion flag, whose single-boolean design let concurrent
 * AI calls skip the gate + cost capture during the gate's await window (SEC-002 #1).
 */
const ORIGINAL_FETCH: typeof fetch | undefined =
  typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined;

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
export function buildBlockedResponse(url: string, gate: { message?: string; reason?: string }): Response {
  const message = gate.message || "Request blocked by AtlasBurn safety guardrails (budget / runaway protection).";
  const reason = gate.reason || "guardrail_suspended";
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Retry-After': '60',
    // Stop the provider SDK's automatic retries (OpenAI/Anthropic honor this). Without
    // it they retry the 429 twice, honoring Retry-After, so a blocked call stalls the
    // host for ~2 minutes before the error surfaces. A block should fail fast.
    'x-should-retry': 'false',
    'x-atlasburn-blocked': '1',
    'x-atlasburn-reason': reason,
  };
  const marker = { blocked: true, reason };

  let body: unknown;
  if (url.includes('api.anthropic.com')) {
    body = { type: 'error', error: { type: 'rate_limit_error', message }, _atlasburn: marker };
  } else if (url.includes('generativelanguage.googleapis.com') || url.includes('vertexai')) {
    body = { error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' }, _atlasburn: marker };
  } else if (url.includes('cohere')) {
    body = { message, _atlasburn: marker };
  } else if (url.includes('bedrock-runtime')) {
    headers['x-amzn-errortype'] = 'ThrottlingException';
    body = { message, _atlasburn: marker };
  } else {
    // OpenAI + OpenAI-compatible (Azure, OpenRouter, Groq, Together, DeepSeek, xAI, Mistral).
    body = { error: { message, type: 'rate_limit_exceeded', code: 'atlasburn_guardrail', param: null }, _atlasburn: marker };
  }
  return new Response(JSON.stringify(body), { status: 429, headers });
}

/**
 * Rough, dependency-free token estimate (~4 chars/token). Used ONLY as a
 * fallback when a provider streams a response WITHOUT usage data (e.g. OpenAI
 * SSE when `stream_options.include_usage` couldn't be injected). Records derived
 * this way are flagged `estimated:true` and must be treated as approximate —
 * never as exact billing truth. We deliberately avoid a heavyweight BPE
 * tokenizer dependency (Law 1: never crash/burden the host app).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Best-effort extraction of prompt text from a provider request body (for the
 * estimate fallback). Handles Chat Completions (`messages`), Responses (`input`),
 * and legacy Completions (`prompt`). Never throws. */
function extractPromptText(body: any): string {
  try {
    if (Array.isArray(body?.messages)) {
      return body.messages.map((m: any) =>
        typeof m?.content === 'string'
          ? m.content
          : Array.isArray(m?.content)
            ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
            : ''
      ).join('\n');
    }
    if (typeof body?.input === 'string') return body.input;
    if (typeof body?.prompt === 'string') return body.prompt;
  } catch (e) { /* fail silent */ }
  return '';
}

/**
 * I3 — pure body transform. OpenAI omits token usage from SSE responses unless
 * the request opts in with `stream_options:{include_usage:true}`, so streamed
 * OpenAI calls otherwise log $0 tokens. Given a raw JSON request body, inject
 * the flag when the request streams without it. Returns the (possibly unchanged)
 * body, the extracted prompt text, and whether injection happened. Pure +
 * exported so tests and other transports can reuse it. Fails open.
 */
export function injectStreamUsage(bodyText: string): { body: string; promptText: string; injected: boolean } {
  try {
    if (!bodyText || bodyText.trimStart()[0] !== '{') return { body: bodyText, promptText: '', injected: false };
    const parsed = JSON.parse(bodyText);
    const promptText = extractPromptText(parsed);
    if (parsed.stream !== true) return { body: bodyText, promptText, injected: false };
    if (parsed.stream_options && parsed.stream_options.include_usage) return { body: bodyText, promptText, injected: false };
    parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
    return { body: JSON.stringify(parsed), promptText, injected: true };
  } catch (e) {
    return { body: bodyText, promptText: '', injected: false };
  }
}

/**
 * I1 — extract prompt/completion token counts across provider response shapes:
 *  - OpenAI-compatible: usage.prompt_tokens / completion_tokens
 *    (OpenAI, Azure, OpenRouter, Mistral, Groq, Together, DeepSeek, xAI)
 *  - Anthropic: usage.input_tokens / output_tokens
 *  - Gemini: usageMetadata.promptTokenCount / candidatesTokenCount
 *  - Cohere: nested under usage|meta . billed_units|tokens . input_tokens/output_tokens
 * (Bedrock reports counts in HTTP headers, handled separately at the response.)
 */
export function extractTokenUsage(obj: any): { prompt: number; completion: number } {
  if (!obj || typeof obj !== 'object') return { prompt: 0, completion: 0 };
  const u = obj.usage || obj.usageMetadata || {};
  const nested = u.billed_units || u.tokens || obj.meta?.billed_units || obj.meta?.tokens || {};
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0);
  return {
    prompt: num(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? nested.input_tokens),
    completion: num(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? nested.output_tokens),
  };
}

function generateForensicId(): string {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch (e) { }
  // `evt_` prefix (NOT `abn_`) so event IDs are visually unambiguous next to API keys.
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

function resolveIngestUrl(options: AtlasBurnSDKOptions): string {
  if (options.ingestUrl) return options.ingestUrl;
  // LOCAL DEFAULT: Point to the current origin's API routes
  if (typeof window !== 'undefined') return `${window.location.origin}/api/ingest`;
  return "https://app.atlasburn.com/api/ingest"; 
}

function resolveGateUrl(options: AtlasBurnSDKOptions): string {
  if (options.gateUrl) return options.gateUrl;
  // LOCAL DEFAULT: Point to the current origin's API routes
  if (typeof window !== 'undefined') return `${window.location.origin}/api/gate`;
  return "https://app.atlasburn.com/api/gate";
}

type GateDecision = { blocked: boolean; status: string; message?: string; reason?: string; failed?: boolean };

/** Decisions older than this are never served from cache; the call waits for a fresh check. */
const GATE_MAX_STALE_MS = 60_000;

class AtlasBurnIngestor {
  private queue: any[] = [];
  private options: AtlasBurnSDKOptions;
  private isProcessing: boolean = false;
  private pendingFlush: Promise<void> | null = null;
  private maxRetries: number = 3;
  private resolvedIngestUrl: string;
  private resolvedGateUrl: string;
  private flushInterval: any;
  private gateCache = new Map<string, { decision: GateDecision; at: number }>();
  private gateInflight = new Map<string, Promise<GateDecision>>();
  private throttleNext = new Map<string, number>();

  constructor(options: AtlasBurnSDKOptions) {
    this.resolvedIngestUrl = resolveIngestUrl(options);
    this.resolvedGateUrl = resolveGateUrl(options);
    this.options = {
      batchSize: 5,
      maxQueueSize: 200, 
      ...options,
      metadata: {
        sdkVersion: SDK_VERSION,
        environment: typeof process !== 'undefined' ? (process.env.NODE_ENV || 'production') : 'browser',
        ...options.metadata
      }
    };

    if (typeof setInterval !== 'undefined') {
      this.flushInterval = setInterval(() => this.flush(), 5000);
      // Never keep the host process alive just for telemetry: scripts, CLIs, cron jobs
      // and serverless handlers must exit normally. Pending events still go out via the
      // 'beforeExit' flush below. (Node returns a Timeout with unref; browsers a number.)
      (this.flushInterval as any)?.unref?.();
    }

    if (typeof process !== 'undefined' && process.on) {
      process.on('beforeExit', () => this.flush());
    }
  }

  /** Report a capture/gate anomaly out-of-band: a `debug` log + the operator
   *  `onError` callback. Never throws into the host (Law 1), never blocks (Law 2) —
   *  it just breaks the silence so a provider format change isn't an invisible $0. */
  public diag(info: AtlasBurnDiagnostic): void {
    if (this.options.debug) {
      try { console.warn(`[AtlasBurn SDK] ${info.stage}`, info.model || '', info.url || '', info.error ?? ''); } catch { /* noop */ }
    }
    if (typeof this.options.onError === 'function') {
      try { this.options.onError(info); } catch { /* a bad callback must never crash the host */ }
    }
  }

  public async checkGate(featureId: string): Promise<GateDecision> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.options.apiKey) {
        headers['Authorization'] = `Bearer ${this.options.apiKey.trim()}`;
      }
      const response = await (ORIGINAL_FETCH || fetch)(this.resolvedGateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId: this.options.projectId || 'default', featureId }),
        signal: AbortSignal.timeout(this.options.gateTimeoutMs ?? 2500)
      });
      if (!response.ok) return { blocked: false, status: 'active', failed: true };
      return await response.json();
    } catch (e) {
      this.diag({ stage: 'gate_error', url: this.resolvedGateUrl, error: e });
      return { blocked: false, status: 'active', failed: true };
    }
  }

  /**
   * Guardrail decision for a feature, without paying a gate round-trip on every AI
   * call. Fresh (< gateCacheMs) → reuse. Stale (< 60s) → reuse and refresh in the
   * background. Missing/too old → wait for a check. Concurrent callers share one
   * in-flight check. A failed check never overwrites a known decision (so a known
   * block isn't lifted by one network blip); with no known decision it fails open.
   */
  public async gateDecision(featureId: string): Promise<GateDecision> {
    const ttl = Math.max(0, this.options.gateCacheMs ?? 10_000);
    const hit = this.gateCache.get(featureId);
    if (ttl > 0 && hit) {
      const age = Date.now() - hit.at;
      if (age < ttl) return hit.decision;
      if (age < Math.max(ttl, GATE_MAX_STALE_MS)) {
        void this.refreshGate(featureId);
        return hit.decision;
      }
    }
    return this.refreshGate(featureId);
  }

  private refreshGate(featureId: string): Promise<GateDecision> {
    let inflight = this.gateInflight.get(featureId);
    if (!inflight) {
      inflight = this.checkGate(featureId)
        .then((d) => {
          if (!d.failed) {
            this.gateCache.set(featureId, { decision: d, at: Date.now() });
            return d;
          }
          const known = this.gateCache.get(featureId);
          return known && Date.now() - known.at < GATE_MAX_STALE_MS ? known.decision : d;
        })
        .finally(() => { this.gateInflight.delete(featureId); });
      this.gateInflight.set(featureId, inflight);
    }
    return inflight;
  }

  /** Forget cached gate decisions (tests, or after changing guardrails locally). */
  public clearGateCache(): void {
    this.gateCache.clear();
    this.throttleNext.clear();
  }

  /**
   * Pace a throttled feature to one call per `throttleSpacingMs` (default 2s, the
   * same delay the edge proxy applies). Each call reserves the next free slot, so
   * concurrent calls queue in order. Returns false — without waiting — when the
   * slot is more than `throttleMaxWaitMs` away (default 10s): a flood that deep is
   * held back with a blocked response instead of stalling the host indefinitely.
   * Only reached when the gate says "throttled", which only Throttle and Kill
   * Switch modes ever do; Alert mode never slows a call.
   */
  public async paceThrottled(featureId: string): Promise<boolean> {
    const spacing = Math.max(0, this.options.throttleSpacingMs ?? 2000);
    const maxWait = Math.max(0, this.options.throttleMaxWaitMs ?? 10_000);
    const now = Date.now();
    const slot = Math.max(now, this.throttleNext.get(featureId) ?? 0);
    const wait = slot - now;
    if (wait > maxWait) return false;
    this.throttleNext.set(featureId, slot + spacing);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return true;
  }

  public enqueue(event: any) {
    if (this.queue.length >= (this.options.maxQueueSize || 200)) this.queue.shift(); 
    this.queue.push({
      ...this.options.metadata,
      ...event,
      eventId: generateForensicId(),
      timestamp: event.timestamp || new Date().toISOString()
    });
    if (this.queue.length >= (this.options.batchSize || 5)) this.flush();
  }

  /**
   * Flush the queue. Coalesces concurrent callers onto ONE draining promise and
   * resolves only when the queue is fully drained — so a single `await flush()`
   * delivers EVERYTHING queued, including events enqueued while an earlier flush
   * was still in flight. (Previously a burst of enqueues + one `await flush()`
   * delivered only the first batch because of an `isProcessing` early-return.)
   */
  public flush(): Promise<void> {
    if (!this.pendingFlush) {
      this.pendingFlush = this.drain().finally(() => { this.pendingFlush = null; });
    }
    return this.pendingFlush;
  }

  private async drain(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    // Cap each POST at the ingest route's 100-event limit so a large queue never 413s.
    const batchSize = Math.min(Math.max(1, this.options.batchSize || 5), 100);
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, batchSize);
        try {
          await this.sendWithRetry(batch, 0);
        } catch (err) {
          // Law 4 — never throw into the host. Drop on persistent failure (do NOT
          // requeue: would loop), but surface it out-of-band so it isn't invisible.
          this.diag({ stage: 'flush_failed', error: err });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async sendWithRetry(events: any[], attempt: number): Promise<void> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.options.authToken) headers['Authorization'] = `Bearer ${this.options.authToken}`;
      const response = await (ORIGINAL_FETCH || fetch)(this.resolvedIngestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          apiKey: this.options.apiKey.trim(),
          projectId: this.options.projectId || 'default',
          events: events
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        return this.sendWithRetry(events, attempt + 1);
      }
      throw err;
    }
  }
}

let globalIngestor: AtlasBurnIngestor | null = null;

export function getIngestor(options?: AtlasBurnSDKOptions) {
  if (!globalIngestor && options) globalIngestor = new AtlasBurnIngestor(options);
  return globalIngestor;
}

let _atlasBurnPatched = false;

/**
 * Wraps {@link injectStreamUsage} for the live fetch path: reads the outgoing
 * OpenAI request body (whether passed as a `Request` or as `init.body`), injects
 * `stream_options.include_usage` when needed, and returns the rebuilt fetch args
 * plus the prompt text (for the estimate fallback). Fails OPEN — any error
 * returns the original args untouched so the host request is never broken.
 */
async function ensureOpenAIStreamUsage(
  args: Parameters<typeof fetch>
): Promise<{ args: Parameters<typeof fetch>; promptText: string; injected: boolean }> {
  try {
    const [input, init] = args;
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (isRequest ? (input as Request).method : (init?.method || 'GET')).toUpperCase();
    if (method !== 'POST') return { args, promptText: '', injected: false };

    // Read the JSON body WITHOUT consuming the caller's stream.
    let bodyText = '';
    if (isRequest) {
      bodyText = await (input as Request).clone().text();
    } else if (typeof init?.body === 'string') {
      bodyText = init.body;
    } else {
      return { args, promptText: '', injected: false };
    }

    const { body: newBody, promptText, injected } = injectStreamUsage(bodyText);
    if (!injected) return { args, promptText, injected: false };

    if (isRequest) {
      // Base the rebuilt request on the ORIGINAL so signal/credentials/mode/cache
      // are preserved — only the body is overridden. (Rebuilding from r.url alone
      // would drop the AbortSignal, silently breaking host timeouts/cancellation.)
      const rebuilt = new Request(input as Request, { body: newBody });
      return { args: [rebuilt, init] as Parameters<typeof fetch>, promptText, injected: true };
    }
    return { args: [input, { ...(init || {}), body: newBody }] as Parameters<typeof fetch>, promptText, injected: true };
  } catch (e) {
    return { args, promptText: '', injected: false };
  }
}

/** Request header that tags one AI call with a product feature. Stripped by the SDK
 *  before the request reaches the provider. */
export const ATLASBURN_FEATURE_HEADER = "x-atlasburn-feature";

/**
 * Tag a single AI call with the product feature it belongs to, so AtlasBurn can
 * break cost down by feature. Pass as request headers on any fetch-based client:
 *
 *   client.messages.create(params, { headers: atlasburnFeature("support-chat") })   // Anthropic
 *   client.chat.completions.create(params, { headers: atlasburnFeature("search") }) // OpenAI
 *
 * For one feature per process, set `metadata.featureId` in `initAtlasBurnAuto` instead.
 */
export function atlasburnFeature(featureId: string): Record<string, string> {
  return { [ATLASBURN_FEATURE_HEADER]: featureId };
}

/** Normalize a feature name: trimmed, max 100 chars, safe characters only. */
export function sanitizeFeatureId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.trim().slice(0, 100).replace(/[^A-Za-z0-9._:/-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || undefined;
}

/**
 * Read and REMOVE the feature header from outgoing fetch args, so the provider never
 * sees it. Handles a `Request` input and `init.headers` as Headers, [k, v][] or a
 * record. Fails OPEN — any error returns the original args untouched.
 */
export function takeFeatureHeader(args: Parameters<typeof fetch>): { args: Parameters<typeof fetch>; featureId?: string } {
  try {
    const [input, init] = args;
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    let featureId: string | undefined;

    let initHeaders = init?.headers;
    if (initHeaders) {
      const h = new Headers(initHeaders as HeadersInit);
      if (h.has(ATLASBURN_FEATURE_HEADER)) {
        featureId = sanitizeFeatureId(h.get(ATLASBURN_FEATURE_HEADER));
        h.delete(ATLASBURN_FEATURE_HEADER);
        initHeaders = h;
      }
    }

    let newInput = input;
    if (isRequest && (input as Request).headers.has(ATLASBURN_FEATURE_HEADER)) {
      featureId = featureId ?? sanitizeFeatureId((input as Request).headers.get(ATLASBURN_FEATURE_HEADER));
      const h = new Headers((input as Request).headers);
      h.delete(ATLASBURN_FEATURE_HEADER);
      newInput = new Request(input as Request, { headers: h });
    }

    if (newInput === input && initHeaders === init?.headers) return { args, featureId };
    const newInit = init ? { ...init, headers: initHeaders } : undefined;
    return { args: (newInit ? [newInput, newInit] : [newInput]) as Parameters<typeof fetch>, featureId };
  } catch {
    return { args };
  }
}

export function initAtlasBurnAuto(options: AtlasBurnSDKOptions) {
  const ingestor = getIngestor(options);
  if (!ingestor || typeof globalThis === 'undefined' || !globalThis.fetch) return;
  if (_atlasBurnPatched) return;
  _atlasBurnPatched = true;

  let currentFetch = globalThis.fetch;
  // App-wide default feature (metadata.featureId); a per-call x-atlasburn-feature
  // header overrides it. Neither set → the legacy "auto-detect" labels.
  const defaultFeatureId = sanitizeFeatureId(options.metadata?.featureId);
  const wrappedFetch = async (...callArgs: Parameters<typeof fetch>): Promise<Response> => {
    const input = callArgs[0];
    const url = (input instanceof Request ? input.url : input?.toString()) || "";
    const isAIUrl = AI_PATTERNS.some(p => url.includes(p));

    if (!isAIUrl) return currentFetch(...callArgs);

    // Feature tag: read + strip the header so the provider never sees it.
    const tagged = takeFeatureHeader(callArgs);
    const args = tagged.args;
    const featureId = tagged.featureId || defaultFeatureId;

    // Gate check. The ingestor's own HTTP uses ORIGINAL_FETCH, so checkGate never
    // re-enters this wrapper — no recursion flag is needed, and concurrent AI calls
    // are each gated + captured independently (fixes the shared-flag skip, SEC-002 #1).
    if (isAIUrl) {
      try {
        const gate = await ingestor.gateDecision(featureId || "auto-detect");
        if (gate.blocked) {
          // Provider-native 429 (SEC-002 #2) — not a one-shape 200 that breaks
          // non-OpenAI parsers and lets agent loops treat a block as a real answer.
          return buildBlockedResponse(url, gate);
        }
        // Throttled (Throttle / Kill Switch modes only): slow this feature down
        // instead of cutting it. A queue too deep to wait out is held back.
        if (gate.status === "throttled" && !(await ingestor.paceThrottled(featureId || "auto-detect"))) {
          return buildBlockedResponse(url, {
            message: "Request held back by AtlasBurn throttling: this feature is calling faster than its throttle allows. It speeds back up on its own, or resume it in the AtlasBurn dashboard.",
            reason: "guardrail_throttled",
          });
        }
      } catch (e) {
        // Gate check failed — fail open (proceed with the call), per Law 2.
      }
    }

    // I3 — for OpenAI streaming calls, inject stream_options.include_usage into
    // the OUTGOING body so the SSE stream reports real tokens (otherwise $0).
    // promptText is retained for the estimate fallback if usage is still absent.
    let fetchArgs = args;
    let promptText = "";
    let usageInjected = false;
    // Inject include_usage only for the canonical OpenAI API surface (OpenAI +
    // Azure OpenAI), which is guaranteed to support stream_options. Other
    // OpenAI-compatible providers rely on emitted usage or the estimate fallback —
    // we never risk breaking their request by injecting an unsupported field.
    if (url.includes("api.openai.com") || url.includes("openai.azure.com")) {
      const ensured = await ensureOpenAIStreamUsage(args);
      fetchArgs = ensured.args;
      promptText = ensured.promptText;
      usageInjected = ensured.injected;
    }

    const startTime = Date.now();
    const response = await currentFetch(...fetchArgs);
    const latency = Date.now() - startTime;
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const data = await response.clone().json();
        let { prompt: p, completion: c } = extractTokenUsage(data);
        // Bedrock reports token counts in response HEADERS, not the body.
        if (p === 0 && c === 0) {
          p = Number(response.headers.get("x-amzn-bedrock-input-token-count")) || 0;
          c = Number(response.headers.get("x-amzn-bedrock-output-token-count")) || 0;
        }
        if (p > 0 || c > 0) {
          ingestor.enqueue({
            model: data.model || data.modelVersion || "detected-model",
            featureId: featureId || "auto-detect",
            latency,
            usage: { prompt_tokens: p, completion_tokens: c }
          });
        } else {
          // 200 JSON from an AI endpoint but no usage extracted — the classic signal
          // of a provider changing its usage format. Surface it instead of $0. (SEC-002 #3)
          ingestor.diag({ stage: 'zero_usage', url, model: data?.model || data?.modelVersion });
        }
      } catch (e) { ingestor.diag({ stage: 'capture_json_failed', url, error: e }); }
    } else if (contentType.includes("text/event-stream")) {
      const reader = response.clone().body?.getReader();
      if (reader) {
        (async () => {
          try {
            const decoder = new TextDecoder();
            let buffer = "", finalModel = "streaming-model", finalTokens = { prompt: 0, completion: 0 };
            let completionText = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const dataStr = line.substring(6).trim();
                if (dataStr === "[DONE]") continue;
                try {
                  const json = JSON.parse(dataStr);
                  if (json.model) finalModel = json.model;
                  if (json.modelVersion) finalModel = json.modelVersion;
                  const u = extractTokenUsage(json);
                  if (u.prompt > 0 || u.completion > 0) {
                    finalTokens.prompt = u.prompt;
                    finalTokens.completion = u.completion;
                  }
                  // Accumulate streamed content for the estimate fallback (chat delta,
                  // legacy text completion, or Gemini parts) — but ONLY when we did
                  // NOT inject include_usage. When injected, OpenAI sends a final
                  // usage chunk, so the fallback never fires and buffering the whole
                  // completion would be wasted heap on every stream.
                  if (!usageInjected) {
                    const delta = json.choices?.[0]?.delta?.content
                      ?? json.choices?.[0]?.text
                      ?? json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (typeof delta === 'string') completionText += delta;
                  }
                } catch (e) { }
              }
            }
            if (finalTokens.prompt > 0 || finalTokens.completion > 0) {
              ingestor.enqueue({
                model: finalModel,
                featureId: featureId || "auto-detect-stream",
                latency,
                usage: { prompt_tokens: finalTokens.prompt, completion_tokens: finalTokens.completion }
              });
            } else if (completionText.length > 0 || promptText.length > 0) {
              // I3 fallback — the provider streamed no usage (injection couldn't be
              // applied, or the provider never emits it). Estimate from text and
              // flag the record estimated:true so it's disclosed, never billed as exact.
              ingestor.enqueue({
                model: finalModel,
                featureId: featureId || "auto-detect-stream",
                latency,
                estimated: true,
                usage: {
                  prompt_tokens: estimateTokens(promptText),
                  completion_tokens: estimateTokens(completionText),
                },
              });
            } else {
              // Stream ended with no usage AND no text to estimate from — a format
              // change or a provider we can't read. Surface instead of $0. (SEC-002 #3)
              ingestor.diag({ stage: 'zero_usage_stream', url, model: finalModel });
            }
          } catch (e) { ingestor.diag({ stage: 'capture_stream_failed', url, error: e }); }
        })();
      }
    }
    return response;
  };

  // THE KEY FIX: Object.defineProperty instead of direct assignment
  Object.defineProperty(globalThis, 'fetch', {
    get() { return wrappedFetch; },
    set(newFetch) { currentFetch = newFetch; },
    configurable: true,
    enumerable: true,
  });
}

export async function verifyAtlasBurn(options: AtlasBurnSDKOptions) {
  const ingestor = getIngestor(options);
  if (!ingestor) return;
  // apiCallType:'verification' → the ingest route bills a nominal $0.00001 and
  // stores it as a `verification` event, so it's clearly distinguishable from
  // production telemetry in the dashboard (used by `abn test`).
  ingestor.enqueue({ model: "verification-pulse", featureId: "sdk-verification", apiCallType: "verification", usage: { prompt_tokens: 1, completion_tokens: 0 } });
  await ingestor.flush();
}
