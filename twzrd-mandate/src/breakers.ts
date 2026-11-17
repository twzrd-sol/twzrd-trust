/**
 * `verify-breakers`: prove, on this machine, that each of the six pre-sign
 * refusal layers stops a paid call before anything is signed.
 *
 * Every case runs against a loopback world (loopback.ts) with a payer that
 * would sign any 402 it is handed. A case passes when the runtime refuses
 * with the expected code at the expected layer, the payer has made no
 * signature, and the loopback seller has received no payment.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePauseSentinel } from "twzrd-x402-gate";
import { keyFromSeed } from "./keys.js";
import {
  BASE_USDC,
  LOOPBACK_BASE_SELLER,
  LOOPBACK_SELLER,
  LOOPBACK_WASH_SELLER,
  type LoopbackPayer,
  type LoopbackWorld,
  createLoopbackPayer,
  loopbackOnlyFetch,
  startLoopbackWorld,
} from "./loopback.js";
import { type IssueMandateInput, issueMandate, verifyMandate } from "./mandate.js";
import { type CallResult, type MandateRuntime, STATE_FILES, createMandateRuntime } from "./runtime.js";

export interface BreakerCase {
  layer: number;
  name: string;
  expectedCode: string;
  actualCode: string | null;
  actualLayer: number | null;
  signatures: number;
  sellerPayments: number;
  passed: boolean;
}

export interface BreakerReport {
  schema: "twzrd.mandate.breakers.v1";
  ok: boolean;
  layersProven: number[];
  totalSignatures: number;
  totalSellerPayments: number;
  strayRequests: number;
  cases: BreakerCase[];
}

interface Rig {
  world: LoopbackWorld;
  payer: LoopbackPayer;
  runtime: MandateRuntime;
  stateDir: string;
  now: { value: number };
}

/** Run every breaker case. Uses a temporary directory and loopback only; removes what it creates. */
export async function verifyBreakers(): Promise<BreakerReport> {
  const cases: BreakerCase[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twzrd-mandate-breakers-"));
  const guard = loopbackOnlyFetch();
  let totalSignatures = 0;
  let totalSellerPayments = 0;

  async function withRig(
    overrides: Partial<IssueMandateInput>,
    opts: { payer?: boolean },
    body: (rig: Rig) => Promise<{ code: string | null; layer: number | null }>,
  ): Promise<{ code: string | null; layer: number | null; signatures: number; sellerPayments: number }> {
    const payer = createLoopbackPayer();
    const world = await startLoopbackWorld(payer.publicKey);
    const stateDir = fs.mkdtempSync(path.join(root, "state-"));
    const agentKey = keyFromSeed(crypto.randomBytes(32));
    const now = { value: Date.now() };
    const mandate = issueMandate({
      issuerMode: "self-mandated",
      issuerKey: agentKey,
      maxPerCallUsd: "0.05",
      dailyCeilingUsd: "1.00",
      allowedChains: ["solana"],
      minTrustScore: 75,
      allowedTools: [`http:127.0.0.1:${new URL(world.base).port}`],
      requireV7Receipt: true,
      requireMerkleInclusion: true,
      killswitchDir: stateDir,
      lifetimeMs: 3_600_000,
      now: now.value,
      ...overrides,
    });
    const verified = verifyMandate(mandate, { heldAgentKey: agentKey.publicKey, now: now.value });
    if (!verified.ok) throw new Error(`breaker rig: the mandate did not verify (${verified.code})`);
    const runtime = createMandateRuntime({
      mandate: verified.mandate,
      expiresAtMs: verified.expiresAtMs,
      stateDir,
      intelBase: world.intelBase,
      fetch: guard.fetch,
      agentKey,
      now: () => now.value,
      // The loopback seller serves one fixed, signed fixture receipt on every paid call.
      receiptMaxAgeSeconds: null,
      refuseReceiptReplay: false,
      ...(opts.payer === false ? {} : { wrapPay: payer.wrapPay }),
    });
    try {
      const outcome = await body({ world, payer, runtime, stateDir, now });
      return { ...outcome, signatures: payer.signatures, sellerPayments: world.paidCount };
    } finally {
      runtime.close();
      await world.close();
    }
  }

  const refusalOf = (result: CallResult): { code: string | null; layer: number | null } => ({
    code: result.outcome === "refused" ? (result.refusal?.code ?? null) : `not refused (${result.outcome})`,
    layer: result.refusal?.layer ?? null,
  });
  const buy = (rig: Rig, name: string): Promise<CallResult> => rig.runtime.call({ tool: `http:127.0.0.1:${new URL(rig.world.base).port}`, url: rig.world.url(name) });

  async function check(
    layer: number,
    name: string,
    expectedCode: string,
    overrides: Partial<IssueMandateInput>,
    body: (rig: Rig) => Promise<{ code: string | null; layer: number | null }>,
    opts: { payer?: boolean } = {},
  ): Promise<void> {
    let got: { code: string | null; layer: number | null; signatures: number; sellerPayments: number };
    try {
      got = await withRig(overrides, opts, body);
    } catch (err) {
      got = { code: `error: ${(err as Error).message}`, layer: null, signatures: 0, sellerPayments: 0 };
    }
    totalSignatures += got.signatures;
    totalSellerPayments += got.sellerPayments;
    cases.push({
      layer,
      name,
      expectedCode,
      actualCode: got.code,
      actualLayer: got.layer,
      signatures: got.signatures,
      sellerPayments: got.sellerPayments,
      passed: got.code === expectedCode && got.layer === layer && got.signatures === 0 && got.sellerPayments === 0,
    });
  }

  try {
    // Layer 1: mandate integrity.
    await check(1, "an expired mandate", "mandate_expired", {}, async (rig) => {
      rig.now.value += 3_600_001;
      return refusalOf(await buy(rig, "ok"));
    });
    {
      // A mandate edited after it was signed never reaches a runtime: verification refuses it.
      const key = keyFromSeed(crypto.randomBytes(32));
      const mandate = issueMandate({
        issuerMode: "self-mandated",
        issuerKey: key,
        maxPerCallUsd: "0.05",
        dailyCeilingUsd: "1.00",
        allowedChains: ["solana"],
        minTrustScore: 75,
        allowedTools: ["http:127.0.0.1"],
        killswitchDir: ".",
        lifetimeMs: 3_600_000,
      });
      const tampered = { ...mandate, limits: { ...mandate.limits, dailyCeilingUsd: "1000.00" } };
      const verified = verifyMandate(tampered, { heldAgentKey: key.publicKey });
      const code = verified.ok ? "accepted" : verified.code;
      cases.push({
        layer: 1,
        name: "a mandate edited after signing (daily cap raised)",
        expectedCode: "mandate_signature_invalid",
        actualCode: code,
        actualLayer: 1,
        signatures: 0,
        sellerPayments: 0,
        passed: code === "mandate_signature_invalid",
      });
    }

    // Layer 2: halt switches.
    await check(2, "the kill file is present", "kill_switch", {}, async (rig) => {
      fs.writeFileSync(path.join(rig.stateDir, STATE_FILES.kill), "stop\n");
      return refusalOf(await buy(rig, "ok"));
    });
    await check(2, "spending is paused", "payment_gate_halt", {}, async (rig) => {
      writePauseSentinel(path.join(rig.stateDir, STATE_FILES.pause), { ttlMs: 60_000, reason: "breaker_check", now: rig.now.value });
      return refusalOf(await buy(rig, "ok"));
    });

    // Layer 3: tool allow-list.
    await check(3, "a tool the mandate does not name", "tool_not_allowed", { allowedTools: ["http:only.this.example"] }, async (rig) => {
      const result = await buy(rig, "ok");
      // Nothing may reach the seller for a tool that is not allowed.
      if (rig.world.hits.length !== 0) return { code: "a request reached the seller", layer: null };
      return refusalOf(result);
    });

    // Layer 4: spend caps.
    await check(4, "a price over the per-call cap", "per_request_cap", {}, async (rig) => {
      rig.world.product("dear").priceMicro = 60_000;
      return refusalOf(await buy(rig, "dear"));
    });

    // Layer 5: trust screen.
    await check(5, "a wash-flagged seller", "trust_gate_refused", {}, async (rig) => {
      rig.world.product("wash").payTo = LOOPBACK_WASH_SELLER;
      return refusalOf(await buy(rig, "wash"));
    });
    await check(5, "a seller under the minimum trust score", "trust_gate_refused", {}, async (rig) => {
      rig.world.defaultTrust = { decision: "allow", score: 40, washFlagged: false };
      return refusalOf(await buy(rig, "ok"));
    });
    await check(5, "a chain the mandate does not allow", "chain_not_allowed", {}, async (rig) => {
      Object.assign(rig.world.product("base"), { network: "base", asset: BASE_USDC, payTo: LOOPBACK_BASE_SELLER });
      return refusalOf(await buy(rig, "base"));
    });
    await check(5, "a blocked counterparty", "counterparty_blocked", { blockedCounterparties: [LOOPBACK_SELLER] }, async (rig) => refusalOf(await buy(rig, "ok")));

    // Layer 6: challenge integrity.
    await check(6, "a 402 header that is not canonical base64", "payment_required_unreadable", {}, async (rig) => {
      rig.world.product("loose").challenge = "noncanonical-header";
      return refusalOf(await buy(rig, "loose"));
    });
    await check(6, "an offer priced in something other than USDC", "unpriced_offer", {}, async (rig) => {
      rig.world.product("odd").asset = "So11111111111111111111111111111111111111112";
      return refusalOf(await buy(rig, "odd"));
    });
    await check(6, "a seller that swaps the recipient after approval", "offer_changed_after_approval", {}, async (rig) => {
      rig.world.product("swap").swapPayToAfterFirst = LOOPBACK_WASH_SELLER;
      return refusalOf(await buy(rig, "swap"));
    });
    await check(6, "no payer configured", "no_payer_configured", {}, async (rig) => refusalOf(await buy(rig, "ok")), { payer: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const layersProven = [1, 2, 3, 4, 5, 6].filter((layer) => cases.some((c) => c.layer === layer) && cases.filter((c) => c.layer === layer).every((c) => c.passed));
  return {
    schema: "twzrd.mandate.breakers.v1",
    ok: cases.every((c) => c.passed) && layersProven.length === 6 && totalSignatures === 0 && totalSellerPayments === 0 && guard.strays.length === 0,
    layersProven,
    totalSignatures,
    totalSellerPayments,
    strayRequests: guard.strays.length,
    cases,
  };
}

/** The report as a table for a terminal. */
export function formatBreakerReport(report: BreakerReport): string {
  const rows = report.cases.map(
    (c) => `  ${c.passed ? "PASS" : "FAIL"}  layer ${c.layer}  ${c.name.padEnd(52)} ${c.actualCode ?? "-"}  signatures=${c.signatures}`,
  );
  return [
    "TWZRD mandate breakers (loopback, no wallet, no network)",
    ...rows,
    `  layers proven: ${report.layersProven.join(", ") || "none"} of 1-6`,
    `  signatures: ${report.totalSignatures}   payments the seller received: ${report.totalSellerPayments}   requests off loopback: ${report.strayRequests}`,
    report.ok ? "  RESULT: every pre-sign layer refused with 0 signatures" : "  RESULT: FAILED",
  ].join("\n");
}
