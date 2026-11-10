/**
 * `.kill` / `.pause` on every path that can reach a signer.
 *
 * The rule under test: any entry point in this package that calls a signer, a
 * payer, or a credential callback, hands a 402 to a paying wrapper, or does I/O
 * and then returns a go-ahead reads the sentinels on entry and again at the
 * go-ahead. Turning seller evaluation off (`disabled: true`, TWZRD_AUTO_GATE=0,
 * TWZRD_GATE_ENABLED=false, a soft uninstall) turns scoring off. It never turns
 * the sentinels off.
 *
 * One failing-first test per path that did not read them:
 *
 *   createGuardedX402Fetch            evaluation off
 *   installTwzrdAutoGate              all five adapters, every off switch
 *   evaluateWashOnlyBeforePayment     and the hook, client config and fetches built on it
 *   createTwzrdPolicyFetch            the hand-over after the signed decision
 *   evaluateIntent                    the signed allow token
 *   quickCheck / evaluateClearanceSku / createSponsoredX402Fetch   paid hops called directly
 *   twzrd-x402-gate/cloudflare-base   under Node, where a filesystem exists
 *   configured stateDir               dropped by evaluate_x402_resource and the fetch guard
 *   blank path settings               a set-but-empty variable used to disable the check
 *   WAL single-writer lock            a lock with no recorded start time and a reused pid
 *
 * The Demand Desk wallet cases live in demand-desk-wallet-replay.test.ts.
 *
 * Hermetic: temp dirs, stub signers, stub fetches. Nothing signs, nothing spends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { x402Version } from "@x402/core";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";

import { installTwzrdAutoGate, uninstallTwzrdAutoGate } from "../src/auto-gate.js";
import { readSentinelState } from "../src/binding-plane.js";
import { evaluateClearanceSku } from "../src/clearance.js";
import {
  createTwzrdCloudflareBaseApproval,
  TwzrdBasePaymentBlockedError,
  withTwzrdBasePreflight,
} from "../src/cloudflare-base.js";
import type { ResolvedTwzrdGateConfig } from "../src/config.js";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { evaluate_x402_resource } from "../src/evaluate.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";
import { x402RequirementsToIntent } from "../src/intent-adapters.js";
import { createTwzrdMppOnChallenge, type MppChallenge, type MppOnChallengeHelpers } from "../src/mpp-hook.js";
import { createTwzrdPayingFetch, TwzrdWashAbortError } from "../src/paying-fetch.js";
import { twzrdApprovePayment } from "../src/policy.js";
import { createTwzrdPolicyFetch } from "../src/policy-fetch.js";
import { createMemorySpendLedger, evaluateIntent } from "../src/policy-runtime.js";
import { quickCheck } from "../src/quick.js";
import { spendControlSafeFetch } from "../src/spend-control.js";
import { createSponsoredX402Fetch } from "../src/sponsored.js";
import { createFileSvmWal, __resetSharedFileSvmWals } from "../src/svm-wal.js";
import {
  createTwzrdPayingClient,
  createTwzrdWashBeforePaymentHook,
  evaluateWashOnlyBeforePayment,
} from "../src/wash-default.js";
import { withTwzrdGuard } from "../src/with-guard.js";
import { wrapFetchWithTwzrdGate } from "../src/wrap-fetch.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RESOURCE = "https://merchant.example/api/v1";
const ROUTE = "https://outbid.sh/route";
const BASE_PAY_TO = "0x3803A19280DeeFe533D177C4A169412BD341101b";
const KILL = /twzrd_kill_switch/;
const PAUSED = /twzrd_payment_paused/;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-every-seat-"));
}
function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function dropKill(dir: string): void {
  fs.writeFileSync(path.join(dir, ".kill"), "halt\n");
}
function dropPause(dir: string, untilUnixMs: number, reason = "payment_gate_halt"): void {
  fs.writeFileSync(
    path.join(dir, ".pause"),
    JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: untilUnixMs, reason }) + "\n",
  );
}

const SENTINEL_ENV = ["TWZRD_STATE_DIR", "KILLSWITCH_KILL_FILE", "KILLSWITCH_PAUSE_FILE"] as const;

/** Run `fn` with the given variables set (undefined = unset), then restore them. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const keys = new Set<string>([...SENTINEL_ENV, ...Object.keys(vars)]);
  const prev = new Map<string, string | undefined>();
  for (const k of keys) prev.set(k, process.env[k]);
  for (const k of SENTINEL_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A temp state dir, named by TWZRD_STATE_DIR for the duration of `fn`. */
async function inStateDir<T>(
  fn: (dir: string) => Promise<T> | T,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const dir = tmpDir();
  try {
    return await withEnv({ TWZRD_STATE_DIR: dir, ...extraEnv }, () => fn(dir));
  } finally {
    rm(dir);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* x402 v2 challenge for a real @x402/fetch client. */
function paymentRequired(amount = "1000", payTo = SELLER): PaymentRequired {
  return {
    x402Version,
    resource: { url: "https://merchant.example/paid" },
    accepts: [{ scheme: "exact", network: SOL, asset: USDC, amount, payTo, maxTimeoutSeconds: 60, extra: {} }],
  };
}

/** A real x402 client whose scheme counts signer calls and then stops. */
function clientFor(onSign: () => void) {
  const client = x402Client.fromConfig({ schemes: [], spendControls: false as const });
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload() {
      onSign();
      throw new Error("fake-signer-stop");
    },
  };
  client.register(SOL, scheme);
  return client;
}

/* x402 v1 body, as a seller returns it on a 402. */
function invoice(payTo = SELLER, amount = "10000") {
  return json({ accepts: [{ payTo, amount, network: "solana", asset: USDC }] }, 402);
}

/** merchant_card stub: a clean, fully covered seller. `during` runs while it is in flight. */
function cleanCard(during?: () => void, calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) calls.n += 1;
    during?.();
    return json({ wash_flagged: false, wash_confidence: "full" });
  }) as unknown as typeof fetch;
}

/** A payWrap that "pays" any 402 it is handed and counts it. */
function countingPayWrap(paid: { n: number }, seen: string[] = []) {
  return (guarded: typeof fetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(String(input));
      const r = await guarded(input, init);
      if (r.status !== 402) return r;
      paid.n += 1;
      return new Response("paid", { status: 200 });
    }) as typeof fetch;
}

/** Intel stub for the full pipeline: allow preflight, clean merchant card. */
function intel(during?: () => void): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/merchant_card/")) return json({ wash_flagged: false, wash_confidence: "full" });
    during?.();
    return json({ readiness_card: { decision: "allow", trust_score: 90, can_spend: true, seller_wallet: SELLER } });
  }) as unknown as typeof fetch;
}

const SOLANA_REQ = { scheme: "exact", network: SOL, payTo: SELLER, maxAmountRequired: "10000", asset: USDC, resource: RESOURCE };

const MPP_CHALLENGE = {
  id: "c1",
  realm: "r",
  method: "solana",
  intent: "charge",
  request: { amount: "1000000", currency: USDC, decimals: 6, recipient: SELLER, cluster: "mainnet-beta" },
} as MppChallenge;

/* ------------------------------------------------------------------ */
/* createGuardedX402Fetch with seller evaluation off                    */
/* ------------------------------------------------------------------ */

test("guarded fetch: disabled evaluation still stops at .kill and at an active .pause", async () => {
  // Control: with nothing on disk the disabled gate lets the signer run.
  await inStateDir(async () => {
    let signs = 0;
    const client = clientFor(() => signs++);
    createGuardedX402Fetch({ client, twzrd: { disabled: true } });
    await assert.rejects(client.createPaymentPayload(paymentRequired()), /fake-signer-stop/);
    assert.equal(signs, 1);
  });

  await inStateDir(async (dir) => {
    dropKill(dir);
    let signs = 0;
    const client = clientFor(() => signs++);
    createGuardedX402Fetch({ client, twzrd: { disabled: true } });
    await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
    assert.equal(signs, 0, "the scheme must not sign while .kill is on disk");
  });

  await inStateDir(async (dir) => {
    dropPause(dir, Date.now() + 60_000);
    let signs = 0;
    const client = clientFor(() => signs++);
    createGuardedX402Fetch({ client, twzrd: { disabled: true } });
    await assert.rejects(client.createPaymentPayload(paymentRequired()), PAUSED);
    assert.equal(signs, 0);
  });

  // The env switch is the same story.
  await inStateDir(
    async (dir) => {
      dropKill(dir);
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, hourlyBudgetCap: "1.00" });
      await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
      assert.equal(signs, 0);
      // The refused amount holds no budget: once the file is gone the full cap is there.
      fs.rmSync(path.join(dir, ".kill"));
      await assert.rejects(client.createPaymentPayload(paymentRequired("1000000")), /fake-signer-stop/);
      assert.equal(signs, 1);
    },
    { TWZRD_GATE_ENABLED: "false" },
  );
});

test("guarded fetch: a configured stateDir is read without the environment", async () => {
  const dir = tmpDir();
  try {
    await withEnv({}, async () => {
      dropKill(dir);
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, twzrd: { disabled: true, stateDir: dir } });
      await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
      assert.equal(signs, 0);
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* installTwzrdAutoGate: every adapter, every off switch                */
/* ------------------------------------------------------------------ */

test("auto gate, x402-solana and pay-kit seats: disabled or switched off still aborts on .kill", async () => {
  await inStateDir(async (dir) => {
    const solDisabled = installTwzrdAutoGate("x402-solana", { disabled: true });
    const kitDisabled = installTwzrdAutoGate("pay-kit", { disabled: true });
    const kitContext = { selectedRequirements: SOLANA_REQ, paymentRequired: { accepts: [SOLANA_REQ] } } as never;

    // Control: no file, the disabled seat proceeds.
    assert.equal(await solDisabled(SOLANA_REQ, { requestUrl: RESOURCE }), undefined);
    assert.equal(await kitDisabled(kitContext), undefined);

    dropKill(dir);
    const a = await solDisabled(SOLANA_REQ, { requestUrl: RESOURCE });
    assert.ok(a && a.abort === true && KILL.test(a.reason), `x402-solana disabled: ${JSON.stringify(a)}`);
    const b = await kitDisabled(kitContext);
    assert.ok(b && b.abort === true && KILL.test(b.reason), `pay-kit disabled: ${JSON.stringify(b)}`);
  });

  await inStateDir(
    async (dir) => {
      dropKill(dir);
      const sol = installTwzrdAutoGate("x402-solana", { fetch: intel() });
      const kit = installTwzrdAutoGate("pay-kit", { fetch: intel() });
      const a = await sol(SOLANA_REQ, { requestUrl: RESOURCE });
      assert.ok(a && a.abort === true && KILL.test(a.reason), `x402-solana env off: ${JSON.stringify(a)}`);
      const b = await kit({ selectedRequirements: SOLANA_REQ, paymentRequired: { accepts: [SOLANA_REQ] } } as never);
      assert.ok(b && b.abort === true && KILL.test(b.reason), `pay-kit env off: ${JSON.stringify(b)}`);
    },
    { TWZRD_AUTO_GATE: "0" },
  );
});

test("auto gate, MPP seat: disabled or switched off never creates a credential past .kill", async () => {
  const signer = createLocalDecisionSigner({ keyId: "every-seat-mpp" });
  await inStateDir(async (dir) => {
    let created = 0;
    const helpers: MppOnChallengeHelpers = { createCredential: async () => { created += 1; return "cred"; } };
    const disabled = installTwzrdAutoGate("mpp", { disabled: true, signer, policy: { maxAmountUsd: "1.00" } });

    assert.equal(await disabled(MPP_CHALLENGE, helpers), "cred", "control: disabled proceeds with no file");
    assert.equal(created, 1);

    dropKill(dir);
    await assert.rejects(() => disabled(MPP_CHALLENGE, helpers), KILL);
    assert.equal(created, 1, "no credential while .kill is on disk");

    fs.rmSync(path.join(dir, ".kill"));
    dropPause(dir, Date.now() + 60_000);
    await assert.rejects(() => disabled(MPP_CHALLENGE, helpers), PAUSED);
    assert.equal(created, 1);
  });

  await inStateDir(
    async (dir) => {
      dropKill(dir);
      let created = 0;
      const helpers: MppOnChallengeHelpers = { createCredential: async () => { created += 1; return "cred"; } };
      const envOff = installTwzrdAutoGate("mpp", { signer, policy: { maxAmountUsd: "1.00" }, intelligence: false });
      await assert.rejects(() => envOff(MPP_CHALLENGE, helpers), KILL);
      assert.equal(created, 0);
    },
    { TWZRD_AUTO_GATE: "0" },
  );
});

test("MPP: the allowUnevaluated opt-out re-reads the sentinels after its ledger write", async () => {
  const signer = createLocalDecisionSigner({ keyId: "every-seat-mpp-optout" });
  // A method this gate does not evaluate. With allowUnevaluated the hook
  // returns undefined and mppx creates the credential itself.
  const stripe = { ...MPP_CHALLENGE, id: "c-stripe", method: "stripe" } as MppChallenge;
  const helpers: MppOnChallengeHelpers = { createCredential: async () => "cred" };

  await inStateDir(async (dir) => {
    const decisionFile = path.join(dir, "decisions.jsonl");
    const open = createTwzrdMppOnChallenge({ signer, allowUnevaluated: true, decisionFile });
    assert.equal(await open(stripe, helpers), undefined, "control: the opt-out hands the challenge back to mppx");

    // onDecision runs after the durable ledger write and before the go-ahead.
    let armed = true;
    const late = createTwzrdMppOnChallenge({
      signer,
      allowUnevaluated: true,
      decisionFile,
      onDecision: () => { if (armed) { armed = false; dropKill(dir); } },
    });
    await assert.rejects(() => late(stripe, helpers), KILL);
  });
});

test("MPP: a caller-supplied clock cannot walk an active .pause out of force", async () => {
  const signer = createLocalDecisionSigner({ keyId: "every-seat-mpp-clock" });
  await inStateDir(async (dir) => {
    let created = 0;
    const helpers: MppOnChallengeHelpers = { createCredential: async () => { created += 1; return "cred"; } };
    dropPause(dir, Date.now() + 60_000);
    const future = () => Date.parse("2031-01-01T00:00:00Z");

    const gated = createTwzrdMppOnChallenge({
      signer,
      policy: { maxAmountUsd: "1.00" },
      decisionFile: path.join(dir, "decisions.jsonl"),
      now: future,
    });
    await assert.rejects(() => gated(MPP_CHALLENGE, helpers), PAUSED);

    const disabled = installTwzrdAutoGate("mpp", { disabled: true, signer, now: future });
    await assert.rejects(() => disabled(MPP_CHALLENGE, helpers), PAUSED);
    assert.equal(created, 0, "the pause was read against the caller's clock");
  });
});

test("auto gate, x402 client: install-disabled, switched off, and uninstalled all stop at .kill", async () => {
  // install-time opt-out
  await inStateDir(async (dir) => {
    let signs = 0;
    const client = clientFor(() => signs++);
    installTwzrdAutoGate(client as never, { disabled: true });
    await assert.rejects(client.createPaymentPayload(paymentRequired()), /fake-signer-stop/);
    assert.equal(signs, 1, "control: disabled proceeds with no file");
    dropKill(dir);
    await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
    assert.equal(signs, 1, "install-disabled client signed past .kill");
  });

  // env switch
  await inStateDir(
    async (dir) => {
      dropKill(dir);
      let signs = 0;
      const client = clientFor(() => signs++);
      installTwzrdAutoGate(client as never, { fetch: intel() });
      await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
      assert.equal(signs, 0, "env-off client signed past .kill");
    },
    { TWZRD_GATE_ENABLED: "0" },
  );

  // soft uninstall
  await inStateDir(async (dir) => {
    let signs = 0;
    const client = clientFor(() => signs++);
    installTwzrdAutoGate(client as never, { fetch: intel() });
    uninstallTwzrdAutoGate(client as never);
    dropKill(dir);
    await assert.rejects(client.createPaymentPayload(paymentRequired()), KILL);
    assert.equal(signs, 0, "uninstalled client signed past .kill");
  });
});

test("auto gate, payWrap: a disabled composition does not hand a 402 to the payer past .kill", async () => {
  await inStateDir(async (dir) => {
    const paid = { n: 0 };
    const guarded = installTwzrdAutoGate(countingPayWrap(paid), {
      disabled: true,
      rawFetch: (async () => invoice()) as unknown as typeof fetch,
    });
    assert.equal((await guarded(RESOURCE)).status, 200, "control: disabled pays with no file");
    assert.equal(paid.n, 1);

    dropKill(dir);
    await assert.rejects(() => guarded(RESOURCE), KILL);
    assert.equal(paid.n, 1, "the payer was handed a 402 past .kill");
  });
});

/* ------------------------------------------------------------------ */
/* wash-only seats                                                      */
/* ------------------------------------------------------------------ */

test("wash evaluator: .kill on entry, during the card lookup, and on every go-ahead branch", async () => {
  const selected = { payTo: SELLER, amount: "10000", network: "solana", asset: USDC };

  await inStateDir(async (dir) => {
    assert.equal(await evaluateWashOnlyBeforePayment(selected, { fetch: cleanCard() }), undefined, "control");

    // On entry: refused before intel is asked.
    dropKill(dir);
    const calls = { n: 0 };
    const onEntry = await evaluateWashOnlyBeforePayment(selected, { fetch: cleanCard(undefined, calls) });
    assert.ok(onEntry && KILL.test(onEntry.reason), `entry: ${JSON.stringify(onEntry)}`);
    assert.equal(calls.n, 0, "no card lookup once payments are halted");

    // The branches that used to return a go-ahead without any lookup.
    const noPayTo = await evaluateWashOnlyBeforePayment({ amount: "10000", network: "solana", asset: USDC }, {});
    assert.ok(noPayTo && KILL.test(noPayTo.reason), `no payTo: ${JSON.stringify(noPayTo)}`);
    const washOff = await evaluateWashOnlyBeforePayment(selected, { refuseWashFlagged: false });
    assert.ok(washOff && KILL.test(washOff.reason), `wash disabled: ${JSON.stringify(washOff)}`);
  });

  // Lands while the card lookup is in flight.
  await inStateDir(async (dir) => {
    const late = await evaluateWashOnlyBeforePayment(selected, { fetch: cleanCard(() => dropKill(dir)) });
    assert.ok(late && KILL.test(late.reason), `during lookup: ${JSON.stringify(late)}`);
  });

  // Lands during an outage the caller chose to wave through.
  await inStateDir(async (dir) => {
    const outage = (async () => {
      dropPause(dir, Date.now() + 60_000);
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    const res = await evaluateWashOnlyBeforePayment(selected, { fetch: outage, failOpen: true });
    assert.ok(res && PAUSED.test(res.reason), `fail-open outage: ${JSON.stringify(res)}`);
  });
});

test("wash hook and paying-client config: halted, and a configured stateDir is honoured", async () => {
  await inStateDir(async (dir) => {
    dropKill(dir);
    const hook = createTwzrdWashBeforePaymentHook({ fetch: cleanCard() });
    const res = await hook(SOLANA_REQ, { requestUrl: RESOURCE });
    assert.ok(res && KILL.test(res.reason), `hook: ${JSON.stringify(res)}`);
  });

  const dir = tmpDir();
  try {
    await withEnv({}, async () => {
      dropKill(dir);
      const cfg = createTwzrdPayingClient({ wallet: {}, fetch: cleanCard(), stateDir: dir });
      const res = await cfg.beforePayment(SOLANA_REQ, { requestUrl: RESOURCE });
      assert.ok(res && KILL.test(res.reason), `paying client: ${JSON.stringify(res)}`);
      assert.equal("stateDir" in cfg, false, "gate options are not passed through to createX402Client");
    });
  } finally {
    rm(dir);
  }
});

test("paying fetch: a 402 is never handed to the payer past .kill, and no fallback route is paid", async () => {
  await inStateDir(async (dir) => {
    const paid = { n: 0 };
    const seen: string[] = [];
    const calls = { n: 0 };
    const mk = (card: typeof fetch) =>
      createTwzrdPayingFetch({
        fetch: card,
        rawFetch: (async () => invoice()) as unknown as typeof fetch,
        wrapPay: countingPayWrap(paid, seen),
      });

    assert.equal((await mk(cleanCard())(RESOURCE)).status, 200, "control");
    assert.equal(paid.n, 1);

    dropKill(dir);
    seen.length = 0;
    await assert.rejects(() => mk(cleanCard(undefined, calls))(RESOURCE), (e: unknown) => e instanceof TwzrdWashAbortError && KILL.test(e.message));
    assert.equal(paid.n, 1, "payer ran past .kill");
    assert.equal(seen.includes(ROUTE), false, "a halt is not a dead origin: the fallback route must not be paid");
  });

  // Lands while the wash lookup is in flight.
  await inStateDir(async (dir) => {
    const paid = { n: 0 };
    const pay = createTwzrdPayingFetch({
      fetch: cleanCard(() => dropKill(dir)),
      rawFetch: (async () => invoice()) as unknown as typeof fetch,
      wrapPay: countingPayWrap(paid),
    });
    await assert.rejects(() => pay(RESOURCE), (e: unknown) => e instanceof TwzrdWashAbortError && KILL.test(e.message));
    assert.equal(paid.n, 0);
  });
});

test("policy fetch: a .kill that lands while the decision is signed stops the hand-over", async () => {
  await inStateDir(async (dir) => {
    const base = createLocalDecisionSigner({ keyId: "every-seat-policy" });
    let armed = false;
    const signer = {
      keyId: base.keyId,
      publicKeyPem: base.publicKeyPem,
      sign: (preimage: Uint8Array) => {
        if (armed) dropKill(dir);
        return base.sign(preimage);
      },
    };
    const paid = { n: 0 };
    const seen: string[] = [];
    const ledger = createMemorySpendLedger();
    const pay = createTwzrdPolicyFetch({
      signer,
      fetch: cleanCard(),
      rawFetch: (async () => invoice()) as unknown as typeof fetch,
      wrapPay: countingPayWrap(paid, seen),
      policy: { maxAmountUsd: "1.00" },
      ledger,
    });

    assert.equal((await pay(RESOURCE)).status, 200, "control");
    assert.equal(paid.n, 1);

    armed = true;
    seen.length = 0;
    await assert.rejects(() => pay(RESOURCE), (e: unknown) => e instanceof TwzrdWashAbortError && KILL.test(e.message));
    assert.equal(paid.n, 1, "payer ran past a .kill that landed during signing");
    assert.equal(seen.includes(ROUTE), false);
  });
});

/* ------------------------------------------------------------------ */
/* evaluateIntent: the signed allow token                               */
/* ------------------------------------------------------------------ */

test("evaluateIntent: no allow token, no intel call, and no recorded spend while halted", async () => {
  const signer = createLocalDecisionSigner({ keyId: "every-seat-intent" });
  const intent = x402RequirementsToIntent(
    { payTo: SELLER, amount: "10000", network: "solana", asset: USDC },
    { resourceUrl: RESOURCE },
  );
  const scope = `counterparty:${intent.payTo}`;
  const DAY = 24 * 60 * 60 * 1000;

  await inStateDir(async (dir) => {
    const ledger = createMemorySpendLedger();
    const ok = await evaluateIntent(intent, { signer, ledger, policy: { maxAmountUsd: "1.00" } });
    assert.equal(ok.decision, "allow", "control");
    assert.equal(ledger.spentMicro(scope, DAY, Date.now()), 10000n);

    dropKill(dir);
    let intelCalls = 0;
    const halted = await evaluateIntent(intent, {
      signer,
      ledger,
      policy: { maxAmountUsd: "1.00" },
      intelligence: async () => { intelCalls += 1; return { known: true, decision: "allow" as const }; },
    });
    assert.equal(halted.decision, "block");
    assert.ok(halted.reasonCodes.includes("twzrd_kill_switch"), halted.reasonCodes.join(","));
    assert.equal(intelCalls, 0, "intelligence is not asked once payments are halted");
    assert.equal(ledger.spentMicro(scope, DAY, Date.now()), 10000n, "a halted intent records no spend");
  });

  // Lands while intelligence is in flight.
  await inStateDir(async (dir) => {
    const ledger = createMemorySpendLedger();
    const late = await evaluateIntent(intent, {
      signer,
      ledger,
      intelligence: async () => { dropPause(dir, Date.now() + 60_000); return { known: true, decision: "allow" as const }; },
    });
    assert.equal(late.decision, "block");
    assert.ok(late.reasonCodes.includes("twzrd_payment_paused"), late.reasonCodes.join(","));
    assert.equal(ledger.spentMicro(scope, DAY, Date.now()), 0n);
  });

  // A configured stateDir, with a caller clock far from the wall clock.
  const dir = tmpDir();
  try {
    await withEnv({}, async () => {
      dropPause(dir, Date.now() + 60_000);
      const d = await evaluateIntent(intent, { signer, stateDir: dir, now: Date.parse("2031-01-01T00:00:00Z") } as never);
      assert.equal(d.decision, "block", "the pause TTL is read against the wall clock, not the caller's clock");
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* paid hops called directly                                            */
/* ------------------------------------------------------------------ */

test("quickCheck, evaluateClearanceSku and the sponsored fetch buy nothing while halted", async () => {
  await inStateDir(async (dir) => {
    let quickCalls = 0;
    const quickFetch = (async () => { quickCalls += 1; return json({ score: 90, tier: "Gold", paid: true }); }) as unknown as typeof fetch;
    assert.equal((await quickCheck(SELLER, { x402Fetch: quickFetch })).available, true, "control");
    assert.equal(quickCalls, 1);

    let settles = 0;
    const settled: string[] = [];
    const sponsored = createSponsoredX402Fetch({
      settle: async () => { settles += 1; return json({ ok: true }); },
      onSettle: (u) => settled.push(u),
    });
    assert.equal((await sponsored("https://intel.example/v1/intel/quick/x")).status, 200, "control");
    assert.equal(settles, 1);

    dropKill(dir);

    const quick = await quickCheck(SELLER, { x402Fetch: quickFetch });
    assert.equal(quick.available, false);
    assert.match(quick.reason, KILL);
    assert.equal(quickCalls, 1, "quickCheck settled $0.001 past .kill");

    let issuerCalls = 0;
    const clearance = await evaluateClearanceSku({
      policy: { issuerUrl: "https://issuer.example/clear", hard: true, publicKeyPem: "unused" } as never,
      challenge: SOLANA_REQ as never,
      x402Fetch: (async () => { issuerCalls += 1; return json({}); }) as unknown as typeof fetch,
    });
    assert.equal(clearance.cleared, false);
    assert.match(clearance.reason, KILL);
    assert.equal(issuerCalls, 0, "the clearance SKU was bought past .kill");

    await assert.rejects(() => sponsored("https://intel.example/v1/intel/quick/x"), KILL);
    assert.equal(settles, 1, "the sponsor settled past .kill");
    assert.equal(settled.length, 1, "a refused settle is not reported as settled");

    // A dry run spends nothing and is not a payment.
    const dry = createSponsoredX402Fetch({ dryRun: true });
    assert.equal((await dry("https://intel.example/x")).status, 200);
  });
});

/* ------------------------------------------------------------------ */
/* twzrd-x402-gate/cloudflare-base under Node                           */
/* ------------------------------------------------------------------ */

const BASE_REQUIREMENTS = {
  resource: "https://worker.example/paid-tool",
  accepts: [{ network: "eip155:8453", payTo: BASE_PAY_TO, amount: "1000" }],
};
function baseAllow(during?: () => void): typeof fetch {
  return (async () => {
    during?.();
    return json({ readiness_card: { decision: "allow", trust_score: 90 } });
  }) as unknown as typeof fetch;
}

test("cloudflare-base: under Node the approval and the signing interceptor stop at .kill and .pause", async () => {
  await inStateDir(async (dir) => {
    const approve = createTwzrdCloudflareBaseApproval({ intelBase: "https://intel.fixture", fetch: baseAllow() });
    assert.equal(await approve(BASE_REQUIREMENTS), true, "control");

    let signatures = 0;
    const sign = async () => { signatures += 1; return "0xsignature"; };
    await withTwzrdBasePreflight(BASE_REQUIREMENTS, { intelBase: "https://intel.fixture", fetch: baseAllow() }, sign);
    assert.equal(signatures, 1, "control");

    dropKill(dir);
    assert.equal(await approve(BASE_REQUIREMENTS), false, "approval returned true past .kill");
    await assert.rejects(
      () => withTwzrdBasePreflight(BASE_REQUIREMENTS, { intelBase: "https://intel.fixture", fetch: baseAllow() }, sign),
      (e: unknown) => e instanceof TwzrdBasePaymentBlockedError && e.verdict.reasons.includes("twzrd_kill_switch"),
    );
    assert.equal(signatures, 1, "signTypedData ran past .kill");
  });

  // Lands during the preflight, and during an outage waved through by failOpen.
  await inStateDir(async (dir) => {
    let signatures = 0;
    const sign = async () => { signatures += 1; return "0xsignature"; };
    await assert.rejects(
      () => withTwzrdBasePreflight(BASE_REQUIREMENTS, { intelBase: "https://intel.fixture", fetch: baseAllow(() => dropKill(dir)) }, sign),
      TwzrdBasePaymentBlockedError,
    );
    assert.equal(signatures, 0);
  });
  await inStateDir(async (dir) => {
    let signatures = 0;
    const sign = async () => { signatures += 1; return "0xsignature"; };
    const outage = (async () => { dropPause(dir, Date.now() + 60_000); return new Response("down", { status: 503 }); }) as unknown as typeof fetch;
    await assert.rejects(
      () => withTwzrdBasePreflight(BASE_REQUIREMENTS, { intelBase: "https://intel.fixture", fetch: outage, failOpen: true }, sign),
      TwzrdBasePaymentBlockedError,
    );
    assert.equal(signatures, 0);
    const approve = createTwzrdCloudflareBaseApproval({ intelBase: "https://intel.fixture", fetch: outage, failOpen: true });
    assert.equal(await approve(BASE_REQUIREMENTS), false);
  });
});

test("cloudflare-base: its standalone reader agrees with readSentinelState on every file state", async () => {
  const states: Array<[string, (dir: string) => void]> = [
    ["nothing on disk", () => {}],
    [".kill present", (d) => dropKill(d)],
    [".kill is a directory", (d) => fs.mkdirSync(path.join(d, ".kill"))],
    [".pause active", (d) => dropPause(d, Date.now() + 60_000)],
    [".pause expired", (d) => dropPause(d, Date.now() - 60_000)],
    [".pause not JSON", (d) => fs.writeFileSync(path.join(d, ".pause"), "{nope")],
    [".pause a JSON array", (d) => fs.writeFileSync(path.join(d, ".pause"), "[]")],
    [".pause wrong schema", (d) => fs.writeFileSync(path.join(d, ".pause"), JSON.stringify({ schema: "other", until_unix_ms: Date.now() + 60_000 }))],
    [".pause without schema, active", (d) => fs.writeFileSync(path.join(d, ".pause"), JSON.stringify({ until_unix_ms: Date.now() + 60_000 }))],
    [".pause bad until", (d) => fs.writeFileSync(path.join(d, ".pause"), JSON.stringify({ schema: "twzrd.pause_sentinel.v1", until_unix_ms: "soon" }))],
    [".pause is a directory", (d) => fs.mkdirSync(path.join(d, ".pause"))],
  ];
  for (const [label, arrange] of states) {
    await inStateDir(async (dir) => {
      arrange(dir);
      const expected = readSentinelState({ stateDir: dir }).active;
      const approve = createTwzrdCloudflareBaseApproval({ intelBase: "https://intel.fixture", fetch: baseAllow() });
      assert.equal(await approve(BASE_REQUIREMENTS), !expected, label);
    });
  }
  // An explicit option wins over the environment, as in the main entry.
  const dir = tmpDir();
  try {
    await withEnv({}, async () => {
      dropKill(dir);
      const approve = createTwzrdCloudflareBaseApproval({ intelBase: "https://intel.fixture", fetch: baseAllow(), stateDir: dir });
      assert.equal(await approve(BASE_REQUIREMENTS), false, "configured stateDir");
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* configured paths and blank settings                                  */
/* ------------------------------------------------------------------ */

test("a configured stateDir reaches evaluate_x402_resource and the fetch guard", async () => {
  const dir = tmpDir();
  try {
    await withEnv({}, async () => {
      dropKill(dir);
      const res = await evaluate_x402_resource(RESOURCE, SOLANA_REQ, { stateDir: dir, fetch: intel() });
      assert.equal(res.approved, false, `evaluate_x402_resource approved past a .kill in its own stateDir: ${res.reason}`);
      assert.match(res.reason, KILL);

      const guarded = withTwzrdGuard((async () => json({ x402Version: 1, accepts: [SOLANA_REQ] }, 402)) as unknown as typeof fetch, {
        stateDir: dir,
        fetch: intel(),
      });
      await assert.rejects(() => guarded(RESOURCE), KILL);
    });
  } finally {
    rm(dir);
  }
});

/* ------------------------------------------------------------------ */
/* a 402 the gate cannot read                                           */
/* ------------------------------------------------------------------ */

// No PAYMENT-REQUIRED header and no JSON body. The gate has nothing to score,
// but a payer that speaks another dialect can still pay from this response
// (here an MPP `WWW-Authenticate: Payment` challenge), so returning it is a
// hand-over like any other.
function opaque402(): Response {
  return new Response("payment required", {
    status: 402,
    headers: { "www-authenticate": 'Payment id="c1", realm="merchant.example", method="solana", intent="charge", request="e30"' },
  });
}

test("a 402 the gate cannot parse is not handed to a payer while halted", async () => {
  await inStateDir(async (dir) => {
    const raw = (async () => opaque402()) as unknown as typeof fetch;
    const identity = (guarded: typeof fetch) => guarded;
    const seats: Array<[string, typeof fetch]> = [
      ["withTwzrdGuard", withTwzrdGuard(raw, { fetch: intel() })],
      ["wrapFetchWithTwzrdGate", wrapFetchWithTwzrdGate(raw)],
      ["installTwzrdAutoGate(payWrap)", installTwzrdAutoGate(identity, { rawFetch: raw, fetch: intel() })],
      ["createTwzrdPayingFetch", createTwzrdPayingFetch({ rawFetch: raw, fetch: intel(), wrapPay: identity })],
      [
        "createTwzrdPolicyFetch",
        createTwzrdPolicyFetch({
          rawFetch: raw,
          fetch: intel(),
          wrapPay: identity,
          signer: createLocalDecisionSigner({ keyId: "every-seat-opaque" }),
        }),
      ],
    ];
    for (const [name, seat] of seats) {
      assert.equal((await seat(RESOURCE)).status, 402, `${name}: control, an unread 402 passes through with no file`);
    }
    dropKill(dir);
    for (const [name, seat] of seats) {
      await assert.rejects(() => seat(RESOURCE), KILL, `${name} handed an unread 402 to the payer past .kill`);
    }
  });
});

function approveConfig(fetchImpl: typeof fetch, extra: Partial<ResolvedTwzrdGateConfig> = {}) {
  return {
    intelBase: "https://intel.example",
    fetch: fetchImpl,
    preflightMinScore: 40,
    blockDecisions: new Set(["block"]),
    failOpen: false,
    gateOnCanSpend: false,
    refuseUnevaluated: true,
    refuseUncappedWarn: true,
    intelTimeoutMs: 2000,
    refuseWashFlagged: false,
    refuseWashUnknown: false,
    washMaxUsdc: null,
    unsupportedNetworkMode: "observe" as const,
    ...extra,
  } as ResolvedTwzrdGateConfig;
}
const approveCtx = { resourceUrl: RESOURCE, sellerWallet: SELLER, priceUsdc: 0.01, network: SOL };

test("a set-but-empty path variable does not switch the sentinels off", async () => {
  // KILLSWITCH_KILL_FILE="" used to win over <stateDir>/.kill and read nothing.
  await inStateDir(
    async (dir) => {
      dropKill(dir);
      const res = await twzrdApprovePayment(approveCtx, approveConfig(intel()));
      assert.equal(res.approved, false, "blank KILLSWITCH_KILL_FILE disabled the kill switch");
      assert.match(res.reason, KILL);

      const safe = await spendControlSafeFetch(RESOURCE, { fetch: (async () => invoice()) as unknown as typeof fetch });
      assert.equal(safe.verdict, "block");
      assert.match(String(safe.reason), KILL);

      const signer = createLocalDecisionSigner({ keyId: "every-seat-blank" });
      const onChallenge = installTwzrdAutoGate("mpp", { signer, policy: { maxAmountUsd: "5.00" }, intelligence: false });
      let created = 0;
      await assert.rejects(() => onChallenge(MPP_CHALLENGE, { createCredential: async () => { created += 1; return "cred"; } }), KILL);
      assert.equal(created, 0);
    },
    { KILLSWITCH_KILL_FILE: "", KILLSWITCH_PAUSE_FILE: "  " },
  );

  // Same for .pause.
  await inStateDir(
    async (dir) => {
      dropPause(dir, Date.now() + 60_000);
      const res = await twzrdApprovePayment(approveCtx, approveConfig(intel()));
      assert.equal(res.approved, false, "blank KILLSWITCH_PAUSE_FILE disabled the pause");
      assert.match(res.reason, PAUSED);
    },
    { KILLSWITCH_PAUSE_FILE: "" },
  );

  // TWZRD_STATE_DIR="" used to leave no directory at all; unset means ./data.
  const cwd = process.cwd();
  const work = tmpDir();
  try {
    fs.mkdirSync(path.join(work, "data"));
    dropKill(path.join(work, "data"));
    process.chdir(work);
    await withEnv({ TWZRD_STATE_DIR: "" }, async () => {
      const res = await twzrdApprovePayment(approveCtx, approveConfig(intel()));
      assert.equal(res.approved, false, "blank TWZRD_STATE_DIR disabled the kill switch");
      assert.match(res.reason, KILL);
    });
  } finally {
    process.chdir(cwd);
    rm(work);
  }

  // Blank explicit options fall back the same way.
  const dir = tmpDir();
  try {
    dropKill(dir);
    assert.equal(readSentinelState({ stateDir: dir, killFilePath: "", pauseFilePath: " " }).active, true);
  } finally {
    rm(dir);
  }
});


/* ------------------------------------------------------------------ */
/* WAL single-writer lock with no recorded start time                   */
/* ------------------------------------------------------------------ */

const HAS_PROC = fs.existsSync("/proc/self/stat") && fs.existsSync("/proc/uptime");

/** How long ago `pid` started, in ms, from /proc (boot-relative clocks). */
function procAgeMs(pid: number | "self"): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  return (uptime - ticks / 100) * 1000;
}

/** A lock in the format written before start times were recorded. */
function writeOldLock(walFile: string, pid: number, atUnixMs: number): void {
  fs.writeFileSync(`${walFile}.lock`, JSON.stringify({ pid, instance_id: "earlier-writer", at_unix_ms: atUnixMs }) + "\n");
}

test("WAL lock without a start time: taken over when the pid's process started after the lock was written", { skip: !HAS_PROC }, () => {
  const dir = tmpDir();
  __resetSharedFileSvmWals();
  try {
    // This pid: the lock predates this process, so an earlier process wrote it.
    const own = path.join(dir, "own.wal.jsonl");
    writeOldLock(own, process.pid, Date.now() - procAgeMs("self") - 60_000);
    const wal = createFileSvmWal(own);
    (wal as { close?: () => void }).close?.();

    // A live foreign pid (the parent): same reasoning from its start time.
    const foreign = path.join(dir, "foreign.wal.jsonl");
    writeOldLock(foreign, process.ppid, Date.now() - procAgeMs(process.ppid) - 60_000);
    const wal2 = createFileSvmWal(foreign);
    (wal2 as { close?: () => void }).close?.();
  } finally {
    __resetSharedFileSvmWals();
    rm(dir);
  }
});

test("WAL lock without a start time: still held when the pid's process could have written it", { skip: !HAS_PROC }, () => {
  const dir = tmpDir();
  __resetSharedFileSvmWals();
  try {
    // Written during this process's life: another thread or realm may hold it.
    const own = path.join(dir, "own.wal.jsonl");
    writeOldLock(own, process.pid, Date.now());
    assert.throws(() => createFileSvmWal(own), /wal_single_writer_lock/);

    // Written during the live parent's life.
    const foreign = path.join(dir, "foreign.wal.jsonl");
    writeOldLock(foreign, process.ppid, Date.now());
    assert.throws(() => createFileSvmWal(foreign), /wal_single_writer_lock/);

    // No timestamp at all: nothing to reason from, so held.
    const bare = path.join(dir, "bare.wal.jsonl");
    fs.writeFileSync(`${bare}.lock`, JSON.stringify({ pid: process.ppid, instance_id: "earlier-writer" }) + "\n");
    assert.throws(() => createFileSvmWal(bare), /wal_single_writer_lock/);
  } finally {
    __resetSharedFileSvmWals();
    rm(dir);
  }
});

test("WAL lock with a start time: a live pid whose start time differs does not hold it", { skip: !HAS_PROC }, () => {
  const dir = tmpDir();
  __resetSharedFileSvmWals();
  try {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${process.ppid}/stat`, "utf8");
    const parentStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    const lock = (walFile: string, procStart: string) =>
      fs.writeFileSync(
        `${walFile}.lock`,
        JSON.stringify({ pid: process.ppid, instance_id: "earlier-writer", at_unix_ms: Date.now(), proc_start: procStart, boot_id: boot }) + "\n",
      );

    // The parent is alive and its start time matches: held.
    const held = path.join(dir, "held.wal.jsonl");
    lock(held, parentStart);
    assert.throws(() => createFileSvmWal(held), /wal_single_writer_lock/);

    // Same pid, another start time: the pid was reused, so the lock is stale.
    const reused = path.join(dir, "reused.wal.jsonl");
    lock(reused, String(Number(parentStart) + 12345));
    const wal = createFileSvmWal(reused);
    (wal as { close?: () => void }).close?.();
  } finally {
    __resetSharedFileSvmWals();
    rm(dir);
  }
});
