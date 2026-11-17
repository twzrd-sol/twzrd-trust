/**
 * The HTTP side of the sidecar: turn an inbound request into a mandate call.
 *
 *   /pay/<absolute-url>      any http or https target, by rewriting the URL
 *   GET http://host/path     a plain forward proxy (HTTP_PROXY) for http targets
 *
 * A forward proxy cannot see inside an https request: the client opens a
 * CONNECT tunnel and the proxy carries bytes it cannot read. So CONNECT is
 * refused here, and https targets go through `/pay/`.
 */
import type http from "node:http";
import { type CallRequest, type CallResult, MAX_BODY_BYTES } from "./runtime.js";

/** The tool name of an HTTP target: `http:` and the host, with its port when the URL names one. */
export function httpToolName(target: URL): string {
  return `http:${target.host.toLowerCase()}`;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(`the request body is larger than ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Read a request body, refusing one that is too large to hold and replay. */
export function readRequestBody(req: http.IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(new Uint8Array(Buffer.concat(chunks)));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** Inbound headers as one string each. */
export function flatHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * The target of a `/pay/<absolute-url>` request, or null. The URL is taken
 * as written after `/pay/`, query string included.
 */
export function payRouteTarget(rawUrl: string): URL | null {
  if (!rawUrl.startsWith("/pay/")) return null;
  const rest = rawUrl.slice("/pay/".length);
  // Some clients collapse `//` in a path: accept `https:/host` as `https://host`.
  const fixed = rest.replace(/^(https?):\/(?!\/)/i, "$1://");
  try {
    const target = new URL(fixed);
    return target.protocol === "http:" || target.protocol === "https:" ? target : null;
  } catch {
    return null;
  }
}

/** The target of an absolute-form (forward proxy) request line, or null. */
export function forwardProxyTarget(rawUrl: string): URL | null {
  if (!/^http:\/\//i.test(rawUrl)) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export async function callRequestFromHttp(req: http.IncomingMessage, target: URL): Promise<CallRequest> {
  const body = await readRequestBody(req);
  const headers = flatHeaders(req);
  return { tool: httpToolName(target), url: target.href, method: req.method ?? "GET", headers, body };
}

/** Write a mandate call's result as the HTTP response. */
export function writeCallResult(res: http.ServerResponse, result: CallResult): void {
  const headers: Record<string, string> = {};
  result.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers["content-length"] = String(result.body.length);
  res.writeHead(result.status, headers);
  res.end(Buffer.from(result.body));
}

export function writeJson(res: http.ServerResponse, status: number, doc: unknown, extra: Record<string, string> = {}): void {
  const body = Buffer.from(`${JSON.stringify(doc)}\n`, "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), "cache-control": "no-store", ...extra });
  res.end(body);
}
