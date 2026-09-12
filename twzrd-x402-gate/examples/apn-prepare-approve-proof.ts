#!/usr/bin/env -S npx tsx
/**
 * Agent Payment Node seat proof: TWZRD decides between `prepare` and `approve`.
 *
 * Mirrors nuanu-ai/agent-payment-node 0.5.x public shapes (FreshChallenge,
 * InspectCandidate, SelectedPrepareOffer) and its contract that `prepare`
 * freezes one offer and `approve` creates exactly one EIP-3009 authorization.
 * No APN dependency: the fake runtime only proves what the seam changes.
 *
 *   A. clean Base merchant   -> approve runs once, one authorization,
 *                               record unavailable / NETWORK_NOT_SCORED
 *   B. flagged Base merchant -> approve never runs, zero signing/broadcast/spend,
 *                               record block / WASH_FLAGGED
 *   C. strict (all-local)    -> no network call at all, zero authorizations,
 *                               record unavailable
 *
 * Offline, deterministic. Run: npx tsx examples/apn-prepare-approve-proof.ts
 * See docs/apn-compatibility-packet.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createLocalDecisionSigner, type DecisionSigner } from "../src/decision-token.js";
import {
  decisionFromApproval,
  issuePaymentDecisionRecord,
  type PaymentDecisionRecordV1,
} from "../src/payment-decision.js";
import type { TwzrdApprovalResult } from "../src/types.js";
import {
  evaluateBeforePaymentCreation,
  type X402SelectedRequirements,
} from "../src/x402-client-hook.js";

export const BASE = "eip155:8453" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const CLEAN_PAYEE = "0x9D3d9410Be95fa1d230734B961997427fc61D837";
export const FLAGGED_PAYEE = "0x3803A19280DeeFe533D177C4A169412BD341101b";
export const RESOURCE = "https://merchant.example/paid/brief";
export const AMOUNT_ATOMIC = "10000"; // $0.01 USDC

/* ---------------- APN public shapes (0.5.x) ---------------- */

export type PaymentRequirements = {
  scheme: "exact";
  network: typeof BASE;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  resource: string;
  extra: { name: string; version: string; assetTransferMethod: "eip3009" };
};

export type InspectCandidate = {
  index: string;
  scheme: "exact";
  network: typeof BASE;
  asset: string;
  amountAtomic: string;
  payTo: string;
  maxTimeoutSeconds: string;
  offerHash: string;
  tokenName: string;
  tokenVersion: string;
  assetTransferMethod: "eip3009";
  paymentFlow: "transferWithAuthorization";
};

export type FreshChallenge = {
  paymentRequired: {
    x402Version: 2;
    resource: { url: string };
    accepts: readonly PaymentRequirements[];
  };
  staticCandidates: readonly InspectCandidate[];
};

export type SelectedPrepareOffer = {
  operationId: string;
  requirements: PaymentRequirements;
  selectedOffer: {
    index: string;
    declaredCanonicalJson: string;
    resolved: {
      tokenName: string;
      tokenVersion: string;
      assetTransferMethod: "eip3009";
      paymentFlow: "transferWithAuthorization";
    };
    offerHash: string;
  };
  amountAtomic: string;
  payee: string;
  maxTimeoutSeconds: number;
};

export type ApnReceipt = {
  kind: "x402_receipt";
  operationId: string;
  offerHash: string;
  payee: string;
  network: typeof BASE;
  amountAtomic: string;
  authorizationCount: 1;
  settlement: { transaction: string };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const domainHash = (domain: string, body: string) =>
  createHash("sha256").update(`${domain}\n${body}`).digest("hex");

/** Fake of APN's local runtime: inspect -> prepare (freeze) -> approve (one authorization). */
export function createApnFake() {
  const counters = { approveCalls: 0, authorizations: 0, broadcasts: 0, spendAtomic: 0n };
  return {
    counters,
    inspect(url: string, payTo: string, amountAtomic: string): FreshChallenge {
      const requirements: PaymentRequirements = {
        scheme: "exact", network: BASE, asset: USDC_BASE, payTo, amount: amountAtomic,
        maxTimeoutSeconds: 60, resource: url,
        extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
      };
      const candidate: InspectCandidate = {
        index: "0", scheme: "exact", network: BASE, asset: USDC_BASE, amountAtomic, payTo,
        maxTimeoutSeconds: "60", offerHash: domainHash("apn.x402.offer.v1", canonicalJson(requirements)),
        tokenName: "USD Coin", tokenVersion: "2",
        assetTransferMethod: "eip3009", paymentFlow: "transferWithAuthorization",
      };
      return { paymentRequired: { x402Version: 2, resource: { url }, accepts: [requirements] }, staticCandidates: [candidate] };
    },
    prepare(challenge: FreshChallenge, capAtomic: string): SelectedPrepareOffer {
      const candidate = challenge.staticCandidates.find(
        (c) => c.assetTransferMethod === "eip3009" && BigInt(c.amountAtomic) <= BigInt(capAtomic),
      );
      if (!candidate) throw new Error("APN_X402_UNSUPPORTED_OFFER: no eip3009 offer within the explicit cap");
      const requirements = challenge.paymentRequired.accepts[Number(candidate.index)];
      if (!requirements) throw new Error("APN_HTTP_PROTOCOL: selected index missing from the fresh challenge");
      const declaredCanonicalJson = canonicalJson(requirements);
      return {
        operationId: randomUUID(),
        requirements,
        selectedOffer: {
          index: candidate.index, declaredCanonicalJson,
          resolved: {
            tokenName: candidate.tokenName, tokenVersion: candidate.tokenVersion,
            assetTransferMethod: "eip3009", paymentFlow: "transferWithAuthorization",
          },
          offerHash: domainHash("apn.x402.offer.v1", declaredCanonicalJson),
        },
        amountAtomic: candidate.amountAtomic,
        payee: candidate.payTo,
        maxTimeoutSeconds: Number(candidate.maxTimeoutSeconds),
      };
    },
    approve(op: SelectedPrepareOffer): ApnReceipt {
      counters.approveCalls += 1;
      counters.authorizations += 1; // one EIP-3009 transferWithAuthorization signature
      counters.broadcasts += 1; // one paid seller request
      counters.spendAtomic += BigInt(op.amountAtomic);
      return {
        kind: "x402_receipt", operationId: op.operationId, offerHash: op.selectedOffer.offerHash,
        payee: op.payee, network: BASE, amountAtomic: op.amountAtomic, authorizationCount: 1,
        settlement: { transaction: `0x${createHash("sha256").update(op.selectedOffer.offerHash).digest("hex")}` },
      };
    },
  };
}

/* ---------------- the TWZRD seam ---------------- */

/** Injected intel: merchant_card only. Any other call is a violation on an unscored network. */
export function routedIntelFetch(washFlagged: boolean, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/intel/merchant_card/")) {
      const merchant = url.split("/v1/intel/merchant_card/")[1]?.split(/[?/]/)[0] ?? "";
      return new Response(JSON.stringify({ merchant, wash_flagged: washFlagged, in_corpus: true }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected network call on an unscored network: ${url}`);
  }) as unknown as typeof fetch;
}

export type BeforeApproveDecision = {
  proceed: boolean;
  approval: TwzrdApprovalResult;
  record: PaymentDecisionRecordV1;
};

/** Frozen APN offer as the selected-requirements shape the shipped evaluator already takes. */
export function selectedRequirementsFromOffer(op: SelectedPrepareOffer): X402SelectedRequirements {
  return {
    payTo: op.payee,
    network: op.requirements.network,
    amount: op.amountAtomic,
    resource: op.requirements.resource,
    scheme: op.requirements.scheme,
  };
}

/**
 * TWZRD on the frozen offer: same evaluator as PayKit / onBeforePaymentCreation.
 * Fake `approve` runs only when that evaluator does not abort.
 */
export async function decideOnFrozenOffer(
  op: SelectedPrepareOffer,
  opts: { fetch: typeof fetch; signer: DecisionSigner; unsupportedNetworkMode?: "observe" | "strict"; now?: number },
): Promise<BeforeApproveDecision> {
  let approval: TwzrdApprovalResult | undefined;
  const hook = await evaluateBeforePaymentCreation(selectedRequirementsFromOffer(op), {
    fetch: opts.fetch,
    unsupportedNetworkMode: opts.unsupportedNetworkMode ?? "observe",
    refuseWashFlagged: true,
    failOpen: false,
    onApproval: (a) => {
      approval = a;
    },
  });
  if (!approval) throw new Error("evaluateBeforePaymentCreation did not emit onApproval");
  const { decision, reason_code } = decisionFromApproval(approval);
  const now = opts.now ?? Date.now();
  const record = await issuePaymentDecisionRecord(
    {
      challenge: op.requirements,
      decision,
      reason_code,
      evidence_id: approval.decisionId,
      expires_at: new Date(now + 120_000).toISOString(),
    },
    opts.signer,
  );
  return { proceed: hook?.abort !== true, approval, record };
}

/* ---------------- fixtures ---------------- */

export type FixtureResult = {
  name: string;
  op: SelectedPrepareOffer;
  decision: BeforeApproveDecision;
  receipt: ApnReceipt | null;
  /** Stored next to APN's receipt, joined on offerHash / operationId. */
  sidecar: { operationId: string; offerHash: string; record: PaymentDecisionRecordV1 };
  counters: { approveCalls: number; authorizations: number; broadcasts: number; spendAtomic: string };
  intelCalls: string[];
};

export async function runFixture(
  name: string,
  input: { payTo: string; washFlagged: boolean; mode: "observe" | "strict" },
  signer: DecisionSigner,
  now?: number,
): Promise<FixtureResult> {
  const apn = createApnFake();
  const intelCalls: string[] = [];
  const challenge = apn.inspect(RESOURCE, input.payTo, AMOUNT_ATOMIC);
  const op = apn.prepare(challenge, "50000");
  const decision = await decideOnFrozenOffer(op, {
    fetch: routedIntelFetch(input.washFlagged, intelCalls), signer, unsupportedNetworkMode: input.mode, now,
  });
  const receipt = decision.proceed ? apn.approve(op) : null;
  return {
    name, op, decision, receipt,
    sidecar: { operationId: op.operationId, offerHash: op.selectedOffer.offerHash, record: decision.record },
    counters: { ...apn.counters, spendAtomic: apn.counters.spendAtomic.toString() },
    intelCalls,
  };
}

export async function runApnCompatFixtures(signer: DecisionSigner = createLocalDecisionSigner(), now?: number) {
  return {
    A: await runFixture("A_clean_base_merchant", { payTo: CLEAN_PAYEE, washFlagged: false, mode: "observe" }, signer, now),
    B: await runFixture("B_flagged_base_merchant", { payTo: FLAGGED_PAYEE, washFlagged: true, mode: "observe" }, signer, now),
    C: await runFixture("C_clean_merchant_strict_all_local", { payTo: CLEAN_PAYEE, washFlagged: false, mode: "strict" }, signer, now),
  };
}

async function main() {
  const signer = createLocalDecisionSigner({ keyId: "apn-packet-demo" });
  const out = await runApnCompatFixtures(signer);
  for (const f of Object.values(out)) {
    console.log(JSON.stringify({
      fixture: f.name,
      decision: f.decision.record.decision,
      reason_code: f.decision.record.reason_code,
      policy_action: f.decision.approval.policyAction ?? null,
      reputation_scored: f.decision.approval.reputationScored ?? null,
      approve_calls: f.counters.approveCalls,
      authorizations: f.counters.authorizations,
      broadcasts: f.counters.broadcasts,
      spend_atomic: f.counters.spendAtomic,
      intel_calls: f.intelCalls.length,
      receipt: f.receipt ? { offerHash: f.receipt.offerHash, transaction: f.receipt.settlement.transaction } : null,
      record: f.sidecar.record,
    }, null, 2));
  }
  console.log(`verifier public key (SPKI PEM):\n${signer.publicKeyPem}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
