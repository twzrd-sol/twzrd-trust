import type { ForwardResult } from "./proxy.js";

/**
 * Two opt-in breakers for the proxy. Both are off unless configured.
 *
 * - Upstream-failure breaker: counts consecutive upstream failures. At the
 *   configured threshold it trips and writes `.pause` for its cooldown. When
 *   the pause ends it is half-open: requests flow again, and the first one
 *   to finish decides. A failure re-trips at once (one failure, not the
 *   threshold); a 2xx closes the breaker and resets the count.
 * - Request-rate limit: caps how many requests this process forwards in any
 *   60 s window, whatever they are priced at. A request that would go over
 *   is refused and writes `.pause` for 60 s.
 *
 * Both act on the requests a pause acts on (chat completions and MPP
 * `topUp`s). Both write `.pause`, never `.kill`, and the proxy logs every
 * trip on the hash-chained ledger. Counting is per process. The `.pause` a
 * trip writes is read by everything that shares the state directory,
 * including the sibling payment gate.
 */

/** `.pause` reason, and ledger `veto_reason`, for an upstream-failure trip. */
export const UPSTREAM_FAILURE_PAUSE_REASON = "upstream_failure_breaker";
/** `.pause` reason, veto code and ledger `veto_reason` for a request-rate trip. */
export const REQUEST_RATE_PAUSE_REASON = "request_rate_limit";
/** The request-rate window. */
export const REQUEST_RATE_WINDOW_MS = 60_000;
/** How long a request-rate trip pauses. */
export const REQUEST_RATE_PAUSE_MS = 60_000;
/** The longest upstream-failure cooldown the configuration accepts: one day. */
export const MAX_UPSTREAM_FAILURE_COOLDOWN_MS = 86_400_000;

export type UpstreamOutcome =
  | { kind: "success" }
  | { kind: "failure"; detail: string }
  | { kind: "neutral" };

/**
 * How one forwarded call counts for the upstream-failure breaker.
 * - failure: the forward threw after the request was sent (`null`), the
 *   upstream timed out (504) or could not be reached (502), it answered 5xx,
 *   or it answered anything but 2xx to a request that carried a payment
 *   credential;
 * - success: a 2xx answer;
 * - neutral: any other answer to a request without a credential (a 402
 *   challenge, a 400, a 429). The upstream is up; the answer neither counts
 *   nor resets the count.
 */
export function classifyUpstreamOutcome(result: ForwardResult | null, paid: boolean): UpstreamOutcome {
  if (result === null) return { kind: "failure", detail: "upstream_error" };
  if (result.outcome === "timeout") return { kind: "failure", detail: "upstream_timeout" };
  if (result.outcome === "unreachable") return { kind: "failure", detail: "upstream_unreachable" };
  if (result.status >= 200 && result.status < 300) return { kind: "success" };
  if (result.status >= 500) return { kind: "failure", detail: `upstream_status_${result.status}` };
  if (paid) return { kind: "failure", detail: `paid_request_status_${result.status}` };
  return { kind: "neutral" };
}

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerTrip {
  /** "trip": the threshold was reached while closed. "retrip": a failure while half-open. */
  event: "trip" | "retrip";
  consecutiveFailures: number;
  /** The failure that tripped it, as classifyUpstreamOutcome names it. */
  detail: string;
}

/**
 * The upstream-failure state machine. It holds no clock and writes no file:
 * the proxy turns a returned trip into a `.pause` and a ledger line. While
 * that pause is in force no request is admitted, so being tripped with no
 * pause in force is the half-open state.
 */
export class UpstreamFailureBreaker {
  private consecutive = 0;
  private tripped = false;
  private epoch = 0;

  constructor(
    readonly threshold: number,
    readonly cooldownMs: number,
  ) {
    if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("threshold must be a whole number of at least 1");
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) throw new Error("cooldownMs must be a whole number of at least 1");
  }

  /** Taken when a request is admitted and handed back to observe() when it ends. */
  ticket(): number {
    return this.epoch;
  }

  /**
   * Record how an admitted request ended. Returns the trip it caused, or
   * null. A request admitted before the latest trip is ignored: it was sent
   * while the breaker was closed, and the trip already accounts for it.
   */
  observe(ticket: number, outcome: UpstreamOutcome): BreakerTrip | null {
    if (ticket !== this.epoch) return null;
    if (this.tripped) {
      // Half-open: the first request to finish decides.
      if (outcome.kind === "success") {
        this.tripped = false;
        this.consecutive = 0;
        return null;
      }
      if (outcome.kind === "neutral") return null;
      this.epoch++;
      return { event: "retrip", consecutiveFailures: 1, detail: outcome.detail };
    }
    if (outcome.kind === "success") {
      this.consecutive = 0;
      return null;
    }
    if (outcome.kind === "neutral") return null;
    this.consecutive++;
    if (this.consecutive < this.threshold) return null;
    const failures = this.consecutive;
    this.consecutive = 0;
    this.tripped = true;
    this.epoch++;
    return { event: "trip", consecutiveFailures: failures, detail: outcome.detail };
  }

  /** Consecutive failures counted since the last 2xx or trip. */
  get consecutiveFailures(): number {
    return this.consecutive;
  }

  /** `pausedNow`: whether a pause is in force for this process at the moment of asking. */
  state(pausedNow: boolean): BreakerState {
    if (!this.tripped) return "closed";
    return pausedNow ? "open" : "half_open";
  }
}

/**
 * A sliding 60 s count of the requests this process forwarded. The caller
 * passes the time, from a clock that does not go backwards.
 */
export class RequestRateLimiter {
  private stamps: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number = REQUEST_RATE_WINDOW_MS,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a whole number of at least 1");
  }

  /** Requests recorded in the window that ends at `nowMs`. */
  count(nowMs: number): number {
    const cutoff = nowMs - this.windowMs;
    let expired = 0;
    while (expired < this.stamps.length && this.stamps[expired] <= cutoff) expired++;
    if (expired > 0) this.stamps.splice(0, expired);
    return this.stamps.length;
  }

  /** True when one more request at `nowMs` would go over the limit. */
  full(nowMs: number): boolean {
    return this.count(nowMs) >= this.limit;
  }

  record(nowMs: number): void {
    this.stamps.push(nowMs);
  }
}

/** The `breaker` object on the ledger line that records a trip. */
export interface BreakerTripRecord {
  name: "upstream_failure" | "request_rate";
  event: "trip" | "retrip";
  /** Why it tripped, in words. */
  reason: string;
  /**
   * When the pause this trip put in force ends: the `.pause` it wrote or,
   * with `pause_write_failed`, the pause this process holds in memory. Null
   * when a pause at least as long (or a corrupt sentinel) was already in
   * force, so nothing was written.
   */
  pause_until_unix_ms: number | null;
  /** Set when the `.pause` write failed: the proxy holds the pause in memory instead, for this process only. */
  pause_write_failed?: true;
  consecutive_failures?: number;
  threshold?: number;
  cooldown_ms?: number;
  requests_in_window?: number;
  limit?: number;
  window_ms?: number;
}
