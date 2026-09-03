/**
 * AUDIT: installTwzrdAutoGate kill-switch SCOPE.
 *
 * installTwzrdAutoGate(client) permanently replaced client.onBeforePaymentCreation
 * with a registrar that gated EVERY hook behind TWZRD's kill switch. The host's
 * own policy hooks, registered afterwards, were therefore silenced by
 * TWZRD_AUTO_GATE=0 or uninstallTwzrdAutoGate — "TWZRD gate off" silently became
 * "all host policy off", including policy TWZRD had nothing to do with.
 *
 * Fixed by patching the registrar only around TWZRD's own registration and
 * restoring it in `finally` (own property restored, inherited method un-shadowed
 * via delete).
 *
 * The Payment Control cases that shipped with this file were split out: they
 * assert a separate fail-open (evaluateBeforePaymentCreation skipping Payment
 * Control when `amount` is missing or empty). That fix has since been pulled;
 * the cases live in test/audit-paymentcontrol-unevaluable.test.ts.
 *
 * Offline, deterministic. Run: npx tsx test/audit-killswitch-scope.test.ts
 */
import assert from "node:assert/strict";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import type { MppChallenge } from "../src/mpp-hook.js";
import type {
  BeforePaymentCreationContext,
  BeforePaymentCreationResult,
  X402ClientLike,
} from "../src/x402-client-hook.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
type Hook = (ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>;

const allowIntel: typeof fetch = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? new Response("{}", { status: 404 })
    : new Response(JSON.stringify({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true } }), { status: 200 })
) as unknown as typeof fetch;

/** Same shape, but the card refuses — used to prove a gate is actually live. */
const denyIntel: typeof fetch = (async (url: unknown) =>
  String(url).includes("/merchant_card/")
    ? new Response("{}", { status: 404 })
    : new Response(JSON.stringify({ readiness_card: { decision: "block", trust_score: 5, can_spend: false } }), { status: 200 })
) as unknown as typeof fetch;

/** Multi-hook registry shaped like @x402/core: run in order, first abort wins. */
function multiHookClient() {
  const hooks: Hook[] = [];
  class Client implements X402ClientLike {
    onBeforePaymentCreation(h: Hook) { hooks.push(h); return this; }
  }
  const client = new Client();
  return {
    client,
    hooks,
    async fire(ctx: BeforePaymentCreationContext) {
      for (const h of hooks) { const r = await h(ctx); if (r && "abort" in r) return r; }
      return undefined;
    },
  };
}
/**
 * Same registry, but the registrar is an OWN property of an object literal
 * rather than a prototype method. installTwzrdAutoGate's `finally` has two
 * exits — restore an own property, or `delete` an inherited shadow — and the
 * class-based harness above only ever reaches the `delete` one. X402ClientLike
 * is a structural type and this repo's own fakes are object literals, so this
 * shape is real, not hypothetical.
 */
function ownPropHookClient() {
  const hooks: Hook[] = [];
  const client: X402ClientLike = {
    onBeforePaymentCreation(h: Hook) { hooks.push(h); return client; },
  } as X402ClientLike;
  return {
    client,
    hooks,
    async fire(c: BeforePaymentCreationContext) {
      for (const h of hooks) { const r = await h(c); if (r && "abort" in r) return r; }
      return undefined;
    },
  };
}

const ctx = (over: Record<string, unknown> = {}): BeforePaymentCreationContext => ({
  selectedRequirements: { payTo: SELLER, network: SOL, amount: "1000", resource: "https://m.example/p", ...over },
});

async function run() {
  // 1a. TWZRD_AUTO_GATE=0 must not silence the HOST's own hook.
  {
    const { client, fire } = multiHookClient();
    installTwzrdAutoGate(client, { fetch: allowIntel });
    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return { abort: true, reason: "host policy" }; });
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      const r = await fire(ctx());
      assert.equal(host, 1, "kill switch silenced a host hook registered after install");
      assert.deepEqual(r, { abort: true, reason: "host policy" });
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    assert.ok(!Object.prototype.hasOwnProperty.call(client, "onBeforePaymentCreation"), "registrar left patched");
  }

  // 1b. uninstallTwzrdAutoGate must only disable TWZRD, not the host hook.
  {
    const { client, fire } = multiHookClient();
    installTwzrdAutoGate(client, { fetch: allowIntel });
    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return undefined; });
    uninstallTwzrdAutoGate(client);
    await fire(ctx());
    assert.equal(host, 1, "uninstall silenced a host hook");
  }

  // 1c. Own-property client: the OTHER exit from the same `finally`.
  // Without the `if (ownProp) restore` arm, an unconditional delete removes the
  // registrar outright and the host cannot register at all. Verified to be
  // unpinned by the rest of the suite before this case existed.
  {
    const { client, hooks, fire } = ownPropHookClient();
    const before = client.onBeforePaymentCreation;
    installTwzrdAutoGate(client, { fetch: allowIntel });
    assert.equal(
      typeof client.onBeforePaymentCreation, "function",
      "the registrar was deleted outright — an own-property client cannot register at all",
    );
    assert.equal(
      client.onBeforePaymentCreation, before,
      "the registrar must be restored by identity, not left patched or replaced",
    );
    assert.equal(hooks.length, 1, "TWZRD's own hook was never registered");

    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return undefined; });
    assert.equal(hooks.length, 2, "the host hook did not reach the registry");
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      await fire(ctx());
      assert.equal(host, 1, "kill switch silenced a host hook on an own-property client");
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
  }

  // 1d. Accessor-backed registrar on the prototype.
  // `ownProp` is false for this shape, so the `delete` in the finally is a
  // no-op — the patch went through the SETTER and lives in the backing slot.
  // Without the identity re-check the patched registrar survives and the
  // original kill-switch-scope bug is fully intact here.
  {
    const hooks: Hook[] = [];
    let stored: unknown;
    class Base {}
    Object.defineProperty(Base.prototype, "onBeforePaymentCreation", {
      configurable: true,
      get() { return stored; },
      set(v: unknown) { stored = v; },
    });
    const pristine = function (this: unknown, h: Hook) { hooks.push(h); return this; };
    stored = pristine;
    const client = new Base() as unknown as X402ClientLike;

    installTwzrdAutoGate(client, { fetch: allowIntel });
    assert.equal(
      client.onBeforePaymentCreation, pristine,
      "an accessor-backed registrar kept the patched wrapper — the setter absorbed it and delete could not remove it",
    );
    assert.equal(hooks.length, 1, "TWZRD's own hook was never registered");

    let host = 0;
    client.onBeforePaymentCreation(async () => { host += 1; return undefined; });
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      for (const h of hooks) await h(ctx());
      assert.equal(host, 1, "kill switch silenced a host hook on an accessor-backed client");
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
  }

  // 1e. Two installs on one client: uninstall must disable BOTH.
  // clientInstalls used to REPLACE its entry, so uninstall reached only the
  // newest state and the first install's hook kept aborting afterwards.
  {
    const { client, fire } = multiHookClient();
    installTwzrdAutoGate(client, { fetch: denyIntel });
    installTwzrdAutoGate(client, { fetch: denyIntel });
    const gated = await fire(ctx());
    assert.ok(gated && "abort" in gated, "precondition: a gated client must refuse the deny card");

    uninstallTwzrdAutoGate(client);
    const after = await fire(ctx());
    assert.equal(
      after, undefined,
      "uninstall left an earlier install still gating — it only disabled the newest",
    );
  }

  // 1f. The env kill switch is a RUNNING switch on the x402-solana seat.
  // It used to be read once at install, so a hook built while enabled kept
  // gating forever — the same variable that the x402-client adapter honours
  // per call did nothing here.
  {
    const hook = installTwzrdAutoGate("x402-solana", { fetch: denyIntel }) as (
      r: Record<string, unknown>,
    ) => Promise<unknown>;
    const req = { payTo: SELLER, network: SOL, amount: "1000", resource: "https://m.example/p" };
    const before = await hook(req);
    assert.ok(before && "abort" in (before as object), "precondition: the seat gates a deny card");

    process.env.TWZRD_AUTO_GATE = "0";
    try {
      assert.equal(
        await hook(req), undefined,
        "x402-solana seat ignored the kill switch after install — env read once, not per call",
      );
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    assert.ok(
      (await hook(req)) as object,
      "the switch must be dynamic in BOTH directions — unsetting it re-arms the gate",
    );
  }

  // 1g. options.disabled stays an install-time opt-out: permanent, and no later
  // env change revives it. This is the deliberate asymmetry, so pin it.
  {
    const off = installTwzrdAutoGate("x402-solana", {
      fetch: denyIntel, disabled: true,
    }) as (r: Record<string, unknown>) => Promise<unknown>;
    const req = { payTo: SELLER, network: SOL, amount: "1000", resource: "https://m.example/p" };
    assert.equal(await off(req), undefined, "disabled:true must not gate");
    process.env.TWZRD_GATE_ENABLED = "1";
    try {
      assert.equal(
        await off(req), undefined,
        "an install-time opt-out must stay off regardless of the environment",
      );
    } finally {
      delete process.env.TWZRD_GATE_ENABLED;
    }
  }

  // 1h. x402-client seat: installing UNDER the kill switch must not be permanent.
  // This adapter used to short-circuit at install on the env check, registering
  // nothing, so clearing the variable never armed the client — the fail-open
  // direction, and the one the header doc claimed was covered.
  {
    process.env.TWZRD_AUTO_GATE = "0";
    let client: X402ClientLike, fire: (c: BeforePaymentCreationContext) => Promise<unknown>;
    try {
      ({ client, fire } = multiHookClient());
      installTwzrdAutoGate(client, { fetch: denyIntel });
      assert.equal(await fire(ctx()), undefined, "must stay ungated while the switch is set");
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    const after = await fire(ctx());
    assert.ok(
      after && "abort" in (after as object),
      "x402-client installed under the kill switch never re-armed after it was cleared",
    );
  }

  // 1i. MPP seat: the same per-call env re-read as x402-solana. Reverting the
  // MPP half of that fix left the whole suite green, so pin it here.
  {
    const charge = (): MppChallenge => ({
      id: "ch_1", realm: "m.example", method: "solana", intent: "charge",
      request: { amount: "50000", currency: USDC, decimals: 6, recipient: SELLER },
    });
    const stub = () => {
      const st = { n: 0 };
      return { st, helpers: { createCredential: async () => { st.n += 1; return "cred"; } } };
    };
    const hook = installTwzrdAutoGate("mpp", {
      signer: createLocalDecisionSigner(),
      intelligence: () => ({ washFlagged: true }),
    }) as (c: MppChallenge, h: { createCredential: () => Promise<string> }) => Promise<string | undefined>;

    const a = stub();
    await assert.rejects(() => hook(charge(), a.helpers), "precondition: MPP seat refuses a wash-flagged charge");
    assert.equal(a.st.n, 0, "createCredential must never run on block");

    const b = stub();
    process.env.TWZRD_AUTO_GATE = "0";
    try {
      assert.equal(
        await hook(charge(), b.helpers), "cred",
        "MPP seat ignored the kill switch after install — env read once, not per call",
      );
      assert.equal(b.st.n, 1, "the passthrough must actually create the credential");
    } finally {
      delete process.env.TWZRD_AUTO_GATE;
    }
    const c = stub();
    await assert.rejects(() => hook(charge(), c.helpers), "unsetting must re-arm the MPP gate");
  }

  // 1j. Non-configurable / non-enumerable own registrar: `delete` THROWS on a
  // non-configurable property (strict mode), so the ownProp arm is not merely a
  // tidiness choice — without it install fails and leaves the registrar patched.
  // Also pins that the restore preserves the DESCRIPTOR, not just the value:
  // assignment changes [[Value]] only, where a defineProperty-based restore
  // would silently normalise the flags.
  {
    const hooks: Hook[] = [];
    const client = {} as X402ClientLike;
    const original = function (this: unknown, h: Hook) { hooks.push(h); return client; };
    Object.defineProperty(client, "onBeforePaymentCreation", {
      value: original, writable: true, enumerable: false, configurable: false,
    });

    installTwzrdAutoGate(client, { fetch: allowIntel });

    const d = Object.getOwnPropertyDescriptor(client, "onBeforePaymentCreation");
    assert.equal(d?.value, original, "a non-configurable registrar was not restored");
    assert.equal(d?.enumerable, false, "restore must not flip enumerable");
    assert.equal(d?.configurable, false, "restore must not flip configurable");
    assert.equal(hooks.length, 1, "TWZRD's own hook was never registered");
  }

  console.log("audit-killswitch-scope.test.ts: ALL PASSED");
}

run().catch((e) => {
  console.error("audit-killswitch-scope.test.ts FAILED:", e);
  process.exit(1);
});
