/**
 * Preloaded into the inference meter (agent-killswitch) with `--import`.
 * The meter is an ordinary loopback HTTP listener, so without this any local
 * process, or a page in a browser, could spend on the operator's API key
 * through it without the mandate sidecar seeing the request. Every request
 * must carry the per-start token the sidecar generated (`x-twzrd-meter-token`);
 * the token is removed from the request before the meter reads it, so it is
 * never forwarded upstream.
 */
import crypto from "node:crypto";
import http from "node:http";

export const METER_TOKEN_HEADER = "x-twzrd-meter-token";
export const METER_TOKEN_ENV = "TWZRD_METER_TOKEN";

const token = process.env[METER_TOKEN_ENV] ?? "";
delete process.env[METER_TOKEN_ENV];
const expected = Buffer.from(token, "utf8");

function tokenMatches(got: unknown): boolean {
  if (typeof got !== "string" || expected.length < 32) return false;
  const given = Buffer.from(got, "utf8");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function guardedEmit(this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
  if (event === "request") {
    const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
    if (!tokenMatches(req.headers[METER_TOKEN_HEADER])) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "this meter answers the mandate sidecar only", type: "forbidden" } }));
      req.resume();
      return true;
    }
    delete req.headers[METER_TOKEN_HEADER];
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if ((req.rawHeaders[i] ?? "").toLowerCase() === METER_TOKEN_HEADER) req.rawHeaders.splice(i, 2);
    }
  }
  return (emit as (this: http.Server, event: string | symbol, ...rest: unknown[]) => boolean).call(this, event, ...args);
} as typeof http.Server.prototype.emit;
