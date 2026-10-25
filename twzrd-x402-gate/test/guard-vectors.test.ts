/**
 * Shared guard vectors (twzrd.guard_vectors.v1), run through the x402-gate.
 *
 * Every vector in test/fixtures/twzrd.payment_decision.v1.guard-vectors.json
 * (byte-identical to docs/vectors in this repo) is evidence intel serves, the
 * buyer's policy, and the outcome every pre-sign guard must reach. This runner
 * plays each one through the shipped entry point, offline:
 *
 *   HTTP 402 -> createGuardedX402Fetch -> TWZRD before-payment hook
 *     -> intel stub serving the vector's preflight and merchant card
 *     -> real @x402/svm ExactSvmScheme -> counting TransactionPartialSigner
 *
 * and checks three things per vector, naming the vector in every failure:
 *   - pays: an expected payment is signed once and paid once; an expected
 *     refusal makes zero signer calls, zero RPC calls, and pays nothing;
 *   - the approval, projected by decisionFromApproval, is the expected
 *     payment_decision.v1 decision and reason_code;
 *   - that pair issues as a signed v1 record that the v1 verifier accepts.
 *
 * Policy is passed in full on every run (policy_baseline merged with the
 * vector's policy) and TWZRD_* env is cleared, so no expected outcome rests on
 * a default. Any fetch that is not to loopback fails the run: no live intel.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getMintEncoder } from "@solana-program/token-2022";
import { getAddressDecoder, getBase64Decoder, none } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { createSeededDecisionSigner } from "../src/decision-token.js";
import { createGuardedX402Fetch } from "../src/guarded-x402-fetch.js";
import {
  decisionFromApproval,
  issuePaymentDecisionRecord,
  verifyPaymentDecisionRecord,
} from "../src/payment-decision.js";
import type { TwzrdApprovalResult } from "../src/types.js";

type Served = { status: number; body?: unknown } | { error: string };
type Vector = {
  id: string;
  covers: string;
  description: string;
  applies_to: string[];
  not_applicable?: Record<string, string>;
  evidence: { preflight: Served; merchant_card: Served; receipt?: unknown };
  policy: Record<string, unknown>;
  expect: { pays: boolean; decision: string; reason_code: string };
};
type VectorFile = {
  schema: string;
  decision_contract: string;
  challenge: { scheme: string; network: string; asset: string; amount: string; price_usdc: number; pay_to: string };
  policy_baseline: Record<string, unknown>;
  guards: Record<string, string>;
  vectors: Vector[];
};

const FIXTURE = new URL("./fixtures/twzrd.payment_decision.v1.guard-vectors.json", import.meta.url);
const CANONICAL = new URL("../../docs/vectors/twzrd.payment_decision.v1.guard-vectors.json", import.meta.url);
const FILE = JSON.parse(readFileSync(FIXTURE, "utf8")) as VectorFile;
const GUARD = "x402-gate";
const INTEL = "https://intel.vectors.invalid";
/** The categories the P0 brief requires the set to cover. */
const REQUIRED_COVERAGE = [
  "allow",
  "warn under cap",
  "warn over cap",
  "block",
  "missing card",
  "unevaluated",
  "wash true",
  "wash unknown",
  "stale receipt",
  "outage",
];

for (const k of Object.keys(process.env)) if (k.startsWith("TWZRD_")) delete process.env[k];

const BUYER = getAddressDecoder().decode(new Uint8Array(32).fill(1));
const MINT_ACCOUNT_B64 = getBase64Decoder().decode(
  getMintEncoder().encode({
    mintAuthority: none(),
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: none(),
    extensions: none(),
  }),
);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
/** Record key: derived, never a real deployment key. */
const recordSigner = createSeededDecisionSigner(
  createHash("sha256").update("twzrd.guard_vectors.v1 test records — NOT A DEPLOYMENT KEY").digest("hex"),
  "twzrd-guard-vectors",
);

/** Vector policy names -> gate options. A key the gate cannot honour fails the run. */
function gateOptions(policy: Record<string, unknown>): Record<string, unknown> {
  const names: Record<string, string> = {
    fail_open: "failOpen",
    min_trust_score: "preflightMinScore",
    gate_on_can_spend: "gateOnCanSpend",
    refuse_unevaluated: "refuseUnevaluated",
    refuse_uncapped_warn: "refuseUncappedWarn",
    refuse_wash_flagged: "refuseWashFlagged",
    refuse_wash_unknown: "refuseWashUnknown",
    wash_max_usdc: "washMaxUsdc",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(policy)) {
    const name = names[k];
    assert.ok(name, `policy key ${k} has no x402-gate option`);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** Loopback merchant (402, then 200 on PAYMENT-SIGNATURE) and Solana RPC, recording every RPC method. */
async function startOrigin() {
  const c = FILE.challenge;
  let paid = 0;
  const rpcMethods: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (req.method === "POST" && req.url === "/rpc") {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        rpcMethods.push(rpc.method);
        const result =
          rpc.method === "getAccountInfo"
            ? {
                context: { apiVersion: "offline-fixture", slot: 1 },
                value: { data: [MINT_ACCOUNT_B64, "base64"], executable: false, lamports: 1_000_000, owner: TOKEN_PROGRAM_ADDRESS, rentEpoch: 0, space: 82 },
              }
            : null;
        return json(200, { jsonrpc: "2.0", id: rpc.id, result });
      }
      if (req.url === "/paid") {
        if (!req.headers["payment-signature"]) {
          const required = {
            x402Version: 2,
            resource: { url: `${origin}/paid` },
            accepts: [
              {
                scheme: c.scheme,
                network: c.network,
                asset: c.asset,
                amount: c.amount,
                payTo: c.pay_to,
                maxTimeoutSeconds: 60,
                extra: { feePayer: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR", recentBlockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: "100" },
              },
            ],
          };
          return json(402, required, { "PAYMENT-REQUIRED": b64(required) });
        }
        paid += 1;
        return json(200, { ok: true }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "offline-fixture", network: c.network }) });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, paid: () => paid, rpcMethods, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Intel at its HTTP boundary: the vector's preflight and merchant card, nothing else. */
function intelStub(v: Vector, unexpected: string[]): typeof fetch {
  const serve = (s: Served) => {
    if ("error" in s) throw new TypeError(`fetch failed (${s.error})`);
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status, headers: { "content-type": "application/json" } });
  };
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${INTEL}/v1/intel/preflight`) return serve(v.evidence.preflight);
    if (url.startsWith(`${INTEL}/v1/intel/merchant_card/${FILE.challenge.pay_to}`)) return serve(v.evidence.merchant_card);
    unexpected.push(url);
    throw new TypeError(`vector runner: unexpected intel request ${url}`);
  }) as unknown as typeof fetch;
}

async function runVector(v: Vector) {
  const origin = await startOrigin();
  const unexpectedIntel: string[] = [];
  const offLoopback: string[] = [];
  const approvals: TwzrdApprovalResult[] = [];
  let signerInvocations = 0;
  const countingSigner = {
    address: BUYER,
    async signTransactions(txs: ReadonlyArray<{ messageBytes: Uint8Array }>) {
      signerInvocations += 1;
      return txs.map(() => ({ [BUYER]: new Uint8Array(64) }));
    },
  };
  const realFetch = globalThis.fetch;
  const loopbackOnly = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://127.0.0.1:")) {
      offLoopback.push(url);
      throw new TypeError(`vector runner: refused a non-loopback fetch ${url}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = loopbackOnly;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const client = new x402Client();
    client.register(FILE.challenge.network as never, new ExactSvmScheme(countingSigner as never, { rpcUrl: `${origin.origin}/rpc` }));
    const paidFetch = createGuardedX402Fetch({
      client: client as never,
      fetch: loopbackOnly,
      twzrd: {
        intelBase: INTEL,
        fetch: intelStub(v, unexpectedIntel),
        blockDecisions: ["block"],
        unsupportedNetworkMode: "observe",
        intelTimeoutMs: 2000,
        onApproval: (a: TwzrdApprovalResult) => approvals.push(a),
        ...gateOptions({ ...FILE.policy_baseline, ...v.policy }),
      } as never,
    });
    status = (await paidFetch(`${origin.origin}/paid`)).status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    globalThis.fetch = realFetch;
  }
  const merchantPaid = origin.paid();
  await origin.close();
  return { origin: origin.origin, approvals, signerInvocations, merchantPaid, rpcMethods: origin.rpcMethods, status, error, unexpectedIntel, offLoopback };
}

test("guard vectors: the fixture copy is byte-identical to docs/vectors", () => {
  // Skipped where only the package directory exists (the wzrd-final mirror).
  if (!existsSync(CANONICAL)) return;
  assert.equal(readFileSync(FIXTURE, "utf8"), readFileSync(CANONICAL, "utf8"), "test/fixtures guard vectors drifted from docs/vectors");
});

test("guard vectors: the set covers every required case, and states x402-gate's part in each", () => {
  assert.equal(FILE.schema, "twzrd.guard_vectors.v1");
  assert.equal(FILE.decision_contract, "twzrd.payment_decision.v1");
  const covered = new Set(FILE.vectors.map((v) => v.covers));
  for (const c of REQUIRED_COVERAGE) assert.ok(covered.has(c), `no vector covers "${c}"`);
  const ids = FILE.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate vector ids: ${ids.join(", ")}`);
  for (const v of FILE.vectors) {
    for (const g of v.applies_to) assert.ok(FILE.guards[g], `[vector ${v.id}] applies_to names an undeclared guard ${g}`);
    const applies = v.applies_to.includes(GUARD);
    const reason = v.not_applicable?.[GUARD];
    assert.ok(applies !== Boolean(reason), `[vector ${v.id}] must either apply to ${GUARD} or say why not, not both or neither`);
  }
});

for (const v of FILE.vectors) {
  if (!v.applies_to.includes(GUARD)) continue;
  test(`guard vector ${v.id} (${v.covers}): x402-gate`, async () => {
    const at = `[vector ${v.id}] ${GUARD}`;
    const r = await runVector(v);
    assert.deepEqual(r.offLoopback, [], `${at}: fetched off loopback`);
    assert.deepEqual(r.unexpectedIntel, [], `${at}: asked intel for something the vector does not serve`);
    assert.equal(r.approvals.length, 1, `${at}: expected one approval, got ${r.approvals.length} (error: ${r.error})`);
    const approval = r.approvals[0];
    const got = decisionFromApproval(approval);
    assert.deepEqual(
      got,
      { decision: v.expect.decision, reason_code: v.expect.reason_code },
      `${at}: recorded ${got.decision}/${got.reason_code}, expected ${v.expect.decision}/${v.expect.reason_code} (gate reason: ${approval.reason})`,
    );
    if (v.expect.pays) {
      assert.equal(approval.approved, true, `${at}: refused (${approval.reason}); expected to pay`);
      assert.equal(r.signerInvocations, 1, `${at}: signer ran ${r.signerInvocations} times; expected once`);
      assert.equal(r.merchantPaid, 1, `${at}: merchant paid ${r.merchantPaid} times; expected once`);
      assert.equal(r.status, 200, `${at}: status ${r.status} (error: ${r.error})`);
      assert.ok(
        r.rpcMethods.every((m) => m === "getAccountInfo"),
        `${at}: RPC beyond a mint read: ${r.rpcMethods.join(", ")}`,
      );
    } else {
      assert.equal(approval.approved, false, `${at}: approved (${approval.reason}); expected a refusal`);
      assert.equal(r.signerInvocations, 0, `${at}: CRITICAL: a refusal reached the signer`);
      assert.equal(r.merchantPaid, 0, `${at}: CRITICAL: a refusal paid the merchant`);
      assert.deepEqual(r.rpcMethods, [], `${at}: a refusal made RPC calls`);
      assert.match(String(r.error), /\[twzrd\]/, `${at}: the refusal does not name TWZRD`);
    }

    // The projected pair must be a record the v1 verifier accepts.
    const challenge = {
      scheme: FILE.challenge.scheme,
      network: FILE.challenge.network,
      payTo: FILE.challenge.pay_to,
      asset: FILE.challenge.asset,
      amount: FILE.challenge.amount,
      resource: `${r.origin}/paid`,
    };
    const record = await issuePaymentDecisionRecord(
      {
        challenge,
        decision: got.decision,
        reason_code: got.reason_code,
        evidence_id: approval.decisionId,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      },
      recordSigner,
    );
    const verified = verifyPaymentDecisionRecord(record, { publicKeyPem: recordSigner.publicKeyPem, challenge });
    assert.equal(verified.ok, true, `${at}: v1 verifier rejected the record: ${JSON.stringify(verified)}`);
  });
}
