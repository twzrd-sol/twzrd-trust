/*
 * STH pinning — split-view detection with no central coordinator.
 *
 * An agent keeps the newest head it has verified for a log_id. Every time it
 * sees a head, it demands proof that the log only appended between the pinned
 * head and the new one. A log serving one history to one agent and a different
 * history to another cannot satisfy both, so the fork surfaces as soon as the
 * two heads meet — either inside one agent over time, or between two agents
 * comparing pins (pass their two heads to `checkEquivocation` directly).
 *
 * Two properties are load-bearing:
 *
 *  - The pin NEVER advances on an unproven step. If the consistency proof is
 *    missing or unfetchable, the observation is an error and the old pin stands.
 *    Advancing on faith would silently discard the evidence the pin exists for.
 *  - A head SMALLER than the pin is not automatically an attack. Load-balanced
 *    replicas lag. The correct response is to prove consistency in the other
 *    direction (observed -> pinned); only a failure there is a fork. Treating
 *    lag as an attack cries wolf; ignoring it misses a real rollback.
 */
import { verifySth, type SignedTreeHead } from "./sth.js";
import { checkEquivocation, type EquivocationResult } from "./equivocation.js";
import type { LogKeyDirectory } from "./keydir.js";

export type PinStatus =
  | "pinned"
  | "unchanged"
  | "advanced"
  | "lagging"
  | "equivocation"
  | "error";

export interface PinnedHead {
  log_id: string;
  tree_size: number;
  root: string;
  timestamp_unix: number;
  key_id?: string;
  observed_at_unix: number;
  sth: SignedTreeHead;
}

export interface ObserveResult {
  status: PinStatus;
  message: string;
  errors: string[];
  /** Pin state after this observation. */
  pinned: PinnedHead | null;
  /** Pin state before it, when the observation changed or challenged it. */
  previous?: PinnedHead;
  /** Present when status === "equivocation" — the publishable proof. */
  equivocation?: EquivocationResult;
  consistency_path?: string[];
}

export type ConsistencyFetcher = (oldSize: number, newSize: number) => Promise<string[]>;

export interface SthPinStoreOptions {
  /** Pinned key or key directory. Never the descriptor's self-asserted keys. */
  trusted: string | LogKeyDirectory;
  /** Restore a pin persisted from an earlier run. */
  initial?: PinnedHead | null;
  /** Called whenever the pin is created or advanced (persist it here). */
  onPin?: (head: PinnedHead) => void | Promise<void>;
  /** Clock, for testing. */
  now?: () => number;
}

export interface SthPinStore {
  get(): PinnedHead | null;
  observe(sth: SignedTreeHead, ctx?: { fetchConsistencyProof?: ConsistencyFetcher }): Promise<ObserveResult>;
}

function toPinned(sth: SignedTreeHead, keyId: string | undefined, nowUnix: number): PinnedHead {
  return {
    log_id: String(sth.log_id),
    tree_size: Number(sth.tree_size),
    root: String(sth.root).toLowerCase().replace(/^0x/, ""),
    timestamp_unix: Number(sth.timestamp_unix),
    ...(keyId ? { key_id: keyId } : {}),
    observed_at_unix: nowUnix,
    sth,
  };
}

export function createSthPinStore(opts: SthPinStoreOptions): SthPinStore {
  let pin: PinnedHead | null = opts.initial ?? null;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const setPin = async (head: PinnedHead): Promise<void> => {
    pin = head;
    if (opts.onPin) await opts.onPin(head);
  };

  return {
    get: () => pin,

    async observe(sth, ctx = {}): Promise<ObserveResult> {
      const res = verifySth(sth, opts.trusted);
      if (!res.valid) {
        return {
          status: "error",
          message: "head signature did not verify against the pinned key — not attributable to the log",
          errors: res.errors,
          pinned: pin,
        };
      }

      const observed = toPinned(sth, res.key_id, now());

      if (!pin) {
        await setPin(observed);
        return {
          status: "pinned",
          message: `pinned first head for ${observed.log_id} at tree_size ${observed.tree_size}`,
          errors: [],
          pinned: observed,
        };
      }

      if (observed.log_id !== pin.log_id) {
        return {
          status: "error",
          message: `head log_id ${JSON.stringify(observed.log_id)} != pinned log_id ${JSON.stringify(pin.log_id)} — a different log, not an update`,
          errors: ["log_id mismatch"],
          pinned: pin,
        };
      }

      const previous = pin;

      // Same size: roots must match exactly.
      if (observed.tree_size === previous.tree_size) {
        if (observed.root === previous.root) {
          return {
            status: "unchanged",
            message: `head unchanged at tree_size ${observed.tree_size}`,
            errors: [],
            pinned: previous,
          };
        }
        const equivocation = checkEquivocation(previous.sth, sth, opts.trusted);
        return {
          status: "equivocation",
          message: equivocation.reason,
          errors: [],
          pinned: previous,
          previous,
          equivocation,
        };
      }

      const growing = observed.tree_size > previous.tree_size;
      const [older, newer] = growing ? [previous.sth, sth] : [sth, previous.sth];
      const oldSize = Number(older.tree_size);
      const newSize = Number(newer.tree_size);

      if (!ctx.fetchConsistencyProof) {
        return {
          status: "error",
          message:
            `head moved ${previous.tree_size} -> ${observed.tree_size} but no consistency ` +
            "fetcher was supplied; the pin does not advance on unproven steps",
          errors: [`need consistency proof ${oldSize} -> ${newSize}`],
          pinned: previous,
          previous,
        };
      }

      let path: string[];
      try {
        path = await ctx.fetchConsistencyProof(oldSize, newSize);
      } catch (e) {
        return {
          status: "error",
          message: `could not fetch consistency proof ${oldSize} -> ${newSize}; pin unchanged`,
          errors: [(e as Error).message],
          pinned: previous,
          previous,
        };
      }

      const equivocation = checkEquivocation(older, newer, opts.trusted, path);
      if (equivocation.equivocation) {
        return {
          status: "equivocation",
          message: equivocation.reason,
          errors: [],
          pinned: previous,
          previous,
          equivocation,
          consistency_path: path,
        };
      }
      if (!equivocation.reason.includes("verifies")) {
        // Proof neither verified nor convicted (malformed path, decode failure).
        return {
          status: "error",
          message: `consistency proof ${oldSize} -> ${newSize} could not be evaluated; pin unchanged`,
          errors: equivocation.errors.length > 0 ? equivocation.errors : [equivocation.reason],
          pinned: previous,
          previous,
          consistency_path: path,
        };
      }

      if (!growing) {
        // Benign replica lag: the smaller head is a genuine prefix of our pin.
        return {
          status: "lagging",
          message:
            `observed head at tree_size ${observed.tree_size} is behind the pinned ` +
            `${previous.tree_size} and proves consistent with it (replica lag); pin unchanged`,
          errors: [],
          pinned: previous,
          previous,
          consistency_path: path,
        };
      }

      await setPin(observed);
      return {
        status: "advanced",
        message: `log appended ${previous.tree_size} -> ${observed.tree_size}, consistency proven; pin advanced`,
        errors: [],
        pinned: observed,
        previous,
        consistency_path: path,
      };
    },
  };
}
