import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from "node:http";

export interface UpstreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ForwardResult {
  status: number;
  usage: UpstreamUsage | null;
  /** "answered": upstream sent a response. "timeout" / "unreachable": the proxy wrote 504 / 502. */
  outcome: "answered" | "timeout" | "unreachable";
}

/** RFC 9110 hop-by-hop headers. Never copy these from client or upstream. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Sensitive headers we never copy as a generic pass-through. */
const BLOCKED = new Set(["set-cookie", "cookie", "authorization", ...HOP_BY_HOP]);

function titleCaseHeader(lowerName: string): string {
  return lowerName
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("-");
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw.join(", ") : raw;
  return value === "" ? undefined : value;
}

/**
 * Rebuild client response headers: keep the chat-completion content-type /
 * SSE defaults, and copy only the payment challenge and receipt headers an
 * MPP/x402 buyer needs. Do not copy the rest of the upstream map
 * (especially Set-Cookie and Authorization).
 */
export function clientResponseHeaders(
  upstream: Headers,
  base: OutgoingHttpHeaders,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...base };
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (BLOCKED.has(n)) return;
    const key = forwardedResponsePaymentHeaderName(n);
    if (key === null) return;
    headers[key] = value;
  });
  return headers;
}

function forwardedResponsePaymentHeaderName(lowerName: string): string | null {
  if (lowerName === "www-authenticate") return "WWW-Authenticate";
  if (lowerName === "payment-receipt") return "Payment-Receipt";
  // x402 uses the bare name; X-Payment-Required is already covered by x-payment-*.
  if (lowerName === "payment-required") return "PAYMENT-REQUIRED";
  if (lowerName === "payment-response") return "PAYMENT-RESPONSE";
  if (!lowerName.startsWith("x-payment-")) return null;
  return titleCaseHeader(lowerName);
}

function forwardedRequestPaymentHeaderName(lowerName: string): string | null {
  if (BLOCKED.has(lowerName)) return null;
  if (lowerName === "x-payment") return "X-Payment";
  if (lowerName === "payment-signature") return "Payment-Signature";
  if (lowerName.startsWith("x-payment-")) return titleCaseHeader(lowerName);
  return null;
}

function authorizationScheme(auth: string): string {
  const trimmed = auth.trim();
  const space = trimmed.search(/\s/);
  return (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
}

function sameAsConfiguredBearer(auth: string, apiKey: string): boolean {
  const m = /^bearer\s+(.*)$/i.exec(auth.trim());
  return m !== null && m[1] === apiKey;
}

/**
 * Client Authorization is forwarded only when it is an explicit 402 payment
 * credential/signature, never as a second API key. Tempo/MPP uses the
 * documented `Payment` auth scheme. A non-Bearer value may also pass when
 * accompanied by x-payment / payment-signature / x-payment-signature.
 */
export function shouldPassThroughAuthorization(
  clientAuth: string | undefined,
  apiKey: string,
  hasPaymentHeaders: boolean,
): boolean {
  if (!clientAuth) return false;
  if (sameAsConfiguredBearer(clientAuth, apiKey)) return false;
  if (authorizationScheme(clientAuth) === "payment") return true;
  if (hasPaymentHeaders && authorizationScheme(clientAuth) !== "bearer") return true;
  return false;
}

/**
 * Headers for the upstream fetch: always inject Bearer ${apiKey} as the
 * default, whitelist-copy client payment headers, and replace Authorization
 * only for an explicit payment credential (see shouldPassThroughAuthorization).
 */
export function upstreamRequestHeaders(
  apiKey: string,
  requestId: string,
  clientHeaders: IncomingHttpHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-killswitch-request-id": requestId,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let xPayment = false;
  let paymentSignature = false;
  let xPaymentSignature = false;

  for (const [name, raw] of Object.entries(clientHeaders)) {
    const n = name.toLowerCase();
    const value = headerValue(raw);
    if (value === undefined) continue;
    if (n === "x-payment") xPayment = true;
    else if (n === "payment-signature") paymentSignature = true;
    else if (n === "x-payment-signature") xPaymentSignature = true;
    const key = forwardedRequestPaymentHeaderName(n);
    if (key !== null) headers[key] = value;
  }

  const clientAuth = headerValue(clientHeaders.authorization);
  if (shouldPassThroughAuthorization(clientAuth, apiKey, xPayment || paymentSignature || xPaymentSignature)) {
    headers.authorization = clientAuth as string;
  }
  return headers;
}

/**
 * Upstream timed out (504) or could not be reached (502). No usage came
 * back; the caller keeps the pre-call hold, because upstream may still bill
 * a request it received before the timeout.
 */
function upstreamFailure(clientRes: ServerResponse, timedOut: boolean): ForwardResult {
  const status = timedOut ? 504 : 502;
  clientRes.writeHead(status, { "content-type": "application/json" });
  clientRes.end(
    JSON.stringify({
      error: {
        type: "killswitch_error",
        code: timedOut ? "upstream_timeout" : "upstream_unreachable",
        message: timedOut ? "upstream did not respond in time" : "upstream request failed",
      },
    }),
  );
  return { status, usage: null, outcome: timedOut ? "timeout" : "unreachable" };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

const PASSTHROUGH_HEADERS = [
  "x-free-model",
  "x-fallback-used",
  "x-health-reroute",
  "x-original-model",
  "x-served-model",
  "x-fallback-model",
];

function responseHeaders(upstream: Response, base: Record<string, string>): Record<string, string> {
  const headers = clientResponseHeaders(upstream.headers, base) as Record<string, string>;
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

/**
 * Forward a chat-completion body upstream and pipe the response through.
 * For streams, `stream_options.include_usage` is injected so the terminal
 * SSE event carries usage; chunks are forwarded byte-for-byte and usage is
 * extracted only from the final data event. Returns the observed usage
 * (null when upstream sent none).
 */
export async function forwardChatCompletion(
  upstreamBaseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  clientRes: ServerResponse,
  requestId: string,
  timeoutMs: number,
  clientHeaders: IncomingHttpHeaders = {},
): Promise<ForwardResult> {
  const streaming = body["stream"] === true;
  const outbound: Record<string, unknown> = { ...body };
  if (streaming) {
    const opts = { ...(outbound["stream_options"] as Record<string, unknown> | undefined) };
    opts["include_usage"] = true;
    outbound["stream_options"] = opts;
  }

  // Bound the wait on upstream: its response headers, plus the whole body
  // when not streaming or when upstream answered with an error. A stream
  // that has started is never cut off.
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let upstreamRes: Response;
  let text = "";
  try {
    upstreamRes = await fetch(`${upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamRequestHeaders(apiKey, requestId, clientHeaders),
      body: JSON.stringify(outbound),
      signal: controller.signal,
    });
    if (!streaming || !upstreamRes.ok || !upstreamRes.body) text = await upstreamRes.text();
  } catch {
    return upstreamFailure(clientRes, controller.signal.aborted);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!streaming) {
    clientRes.writeHead(upstreamRes.status, responseHeaders(upstreamRes, { "content-type": "application/json" }));
    clientRes.end(text);
    if (!upstreamRes.ok) return { status: upstreamRes.status, usage: null, outcome: "answered" };
    try {
      const parsed = JSON.parse(text) as { usage?: Partial<UpstreamUsage> };
      const u = parsed.usage;
      if (!u) return { status: upstreamRes.status, usage: null, outcome: "answered" };
      return {
        status: upstreamRes.status,
        outcome: "answered",
        usage: {
          prompt_tokens: num(u.prompt_tokens),
          completion_tokens: num(u.completion_tokens),
          total_tokens: num(u.total_tokens),
        },
      };
    } catch {
      return { status: upstreamRes.status, usage: null, outcome: "answered" };
    }
  }

  // Streaming path: pipe SSE events verbatim, watching for the terminal
  // usage event. The buffer only accumulates the current line, so memory
  // stays flat regardless of stream length.
  clientRes.writeHead(
    upstreamRes.status,
    responseHeaders(upstreamRes, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }),
  );
  if (!upstreamRes.ok || !upstreamRes.body) {
    clientRes.end(text);
    return { status: upstreamRes.status, usage: null, outcome: "answered" };
  }

  let usage: UpstreamUsage | null = null;
  let lineBuf = "";
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    clientRes.write(value); // Forward first; extraction never delays the client.
    lineBuf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload) as { usage?: Partial<UpstreamUsage> };
        if (evt.usage && (evt.usage.prompt_tokens !== undefined || evt.usage.total_tokens !== undefined)) {
          usage = {
            prompt_tokens: num(evt.usage.prompt_tokens),
            completion_tokens: num(evt.usage.completion_tokens),
            total_tokens: num(evt.usage.total_tokens),
          };
        }
      } catch {
        // Non-JSON data lines (e.g. keepalives) are forwarded untouched.
      }
    }
  }
  clientRes.end();
  return { status: upstreamRes.status, usage, outcome: "answered" };
}
