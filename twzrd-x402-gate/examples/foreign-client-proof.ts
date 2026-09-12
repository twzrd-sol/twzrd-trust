#!/usr/bin/env -S npx tsx
/**
 * FOREIGN-CLIENT PROOF — "agents do not sign blind", measured at the signer.
 *
 * Every other gate proof drives a TWZRD-authored mock client, which makes the
 * claim self-referential. This one drives the REAL third-party stack, installed
 * from npm and untouched by this repo:
 *
 *   @x402/fetch   wrapFetchWithPayment   — the 402 retry loop
 *   @x402/core    x402Client             — requirement selection + hook dispatch
 *   @x402/svm     ExactSvmScheme         — the SPL transfer builder that signs
 *
 * TWZRD contributes exactly one thing: installTwzrdX402ClientHook on the
 * client's onBeforePaymentCreation seat. Nothing else is stubbed on the payment
 * path.
 *
 * The load-bearing instrument is a COUNTING SIGNER: a kit-shaped
 * TransactionPartialSigner handed to the real ExactSvmScheme. It increments a
 * counter on every invocation, records the compiled message it was asked to
 * sign, and returns a zero signature. It never touches a chain or a key.
 *
 *   REFUSE  gate blocks  -> signerInvocations MUST be 0
 *   ALLOW   gate permits -> signerInvocations MUST be 1, and the TransferChecked
 *                           instruction inside the signed message must name the
 *                           same mint, the same amount, and the ATA of the same
 *                           payTo the gate approved.
 *
 * OFFLINE AND DETERMINISTIC. A node:http server on 127.0.0.1:0 plays both the
 * merchant origin (spec-shaped 402) and the Solana JSON-RPC the scheme reads
 * (one getAccountInfo for the mint). TWZRD's intel call is a local stub. There
 * is no egress and no wallet.
 *
 * Run: npm run foreign-client-proof   (exit 0 = every check passed)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenPda, getMintEncoder } from "@solana-program/token-2022";
import {
  getAddressDecoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  none,
} from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

import { installTwzrdX402ClientHook } from "../src/x402-client-hook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const addr = (fill: number) => getAddressDecoder().decode(new Uint8Array(32).fill(fill));

/** Deterministic stand-in wallets. 32 identical bytes — no key exists for these. */
export const BUYER = addr(1);
export const SELLER_ALLOW = addr(3);
export const SELLER_REFUSE = addr(4);
/** USDC mainnet mint, used as a well-known asset id; nothing is read from chain. */
export const ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT_DECIMALS = 6;
/** 82-byte SPL mint account the fixture RPC serves for ASSET. */
const MINT_ACCOUNT_B64 = getBase64Decoder().decode(
  getMintEncoder().encode({
    mintAuthority: none(),
    supply: 0n,
    decimals: MINT_DECIMALS,
    isInitialized: true,
    freezeAuthority: none(),
    extensions: none(),
  }),
);

/** Readiness cards the stubbed TWZRD intel returns, keyed by merchant wallet. */
const INTEL: Record<string, Record<string, unknown>> = {
  [SELLER_ALLOW]: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER_ALLOW },
  [SELLER_REFUSE]: { decision: "warn", can_spend: false, trust_score: 56, seller_wallet: SELLER_REFUSE },
};

export type X402Requirement = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
};

/** What the signer was actually asked to sign, decoded from the compiled message. */
export type SignerCall = {
  feePayer: string;
  authority: string;
  mint: string;
  destinationAta: string;
  amountMicro: string;
};

export type GateDecision = { approved: boolean; reason: string; payTo?: string; network?: string; amountMicro?: string };

export type ProofRun = {
  kind: "allow" | "refuse";
  requirement: X402Requirement;
  /** ATA of the payTo the gate approved — what an unswapped signature must target. */
  expectedDestinationAta: string;
  decisions: GateDecision[];
  signerInvocations: number;
  signerCalls: SignerCall[];
  /** Requests the merchant origin received bearing a PAYMENT-SIGNATURE header. */
  originSignedRequests: number;
  /** `accepted` requirement echoed inside the PAYMENT-SIGNATURE payload the merchant received. */
  originAccepted: X402Requirement | null;
  status: number | null;
  error: string | null;
};

/** SPL TransferChecked: discriminator 12, then u64 amount LE, then u8 decimals. */
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

function decodeTransferChecked(messageBytes: Uint8Array): SignerCall {
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const accounts = message.staticAccounts as readonly string[];
  const ix = message.instructions.find(
    (i) =>
      accounts[i.programAddressIndex] === TOKEN_PROGRAM_ADDRESS &&
      i.data?.[0] === TRANSFER_CHECKED_DISCRIMINATOR,
  );
  if (!ix?.data || !ix.accountIndices) {
    throw new Error("signed message carries no SPL TransferChecked instruction");
  }
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  return {
    feePayer: accounts[0],
    mint: accounts[ix.accountIndices[1]],
    destinationAta: accounts[ix.accountIndices[2]],
    authority: accounts[ix.accountIndices[3]],
    amountMicro: view.getBigUint64(1, true).toString(),
  };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function loadFixture(kind: "allow" | "refuse", origin: string): { x402Version: number; resource: { url: string }; accepts: X402Requirement[] } {
  const raw = readFileSync(join(HERE, "..", "test", "fixtures", `foreign-402-${kind}.json`), "utf8");
  const parsed = JSON.parse(raw.replaceAll("{{ORIGIN}}", origin)) as { x402Version: number; resource: { url: string }; accepts: X402Requirement[] };
  // Drift guard: the fixture must name the asset the fixture RPC actually
  // serves and the merchant the INTEL table has a card for. Without this a
  // fixture edit turns the proof green for the wrong reason.
  const req = parsed.accepts[0];
  const expectedPayTo = kind === "allow" ? SELLER_ALLOW : SELLER_REFUSE;
  if (req?.asset !== ASSET) throw new Error(`fixture ${kind}: asset ${req?.asset} != served mint ${ASSET}`);
  if (req?.payTo !== expectedPayTo) throw new Error(`fixture ${kind}: payTo ${req?.payTo} has no INTEL card (expected ${expectedPayTo})`);
  return parsed;
}

/**
 * Fixture origin. One loopback server plays two roles the real stack needs:
 * the paid merchant (spec-shaped 402, then 200 once a PAYMENT-SIGNATURE
 * arrives) and the Solana JSON-RPC that ExactSvmScheme reads the mint from.
 */
async function startOrigin(kind: "allow" | "refuse") {
  let signedRequests = 0;
  let accepted: X402Requirement | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

      if (req.method === "POST" && req.url === "/rpc") {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        const result =
          rpc.method === "getAccountInfo"
            ? {
                context: { apiVersion: "offline-fixture", slot: 1 },
                value: {
                  data: [MINT_ACCOUNT_B64, "base64"],
                  executable: false,
                  lamports: 1_000_000,
                  owner: TOKEN_PROGRAM_ADDRESS,
                  rentEpoch: 0,
                  space: 82,
                },
              }
            : null;
        return json(200, { jsonrpc: "2.0", id: rpc.id, result });
      }

      if (req.url === `/paid/${kind}`) {
        const signature = req.headers["payment-signature"];
        if (!signature) {
          const required = loadFixture(kind, origin);
          return json(402, required, { "PAYMENT-REQUIRED": b64(required) });
        }
        signedRequests += 1;
        const payload = JSON.parse(Buffer.from(String(signature), "base64").toString("utf8"));
        accepted = (payload.accepted ?? null) as X402Requirement | null;
        return json(
          200,
          { ok: true, accepted: payload.accepted },
          { "PAYMENT-RESPONSE": b64({ success: true, transaction: "offline-fixture", network: payload.accepted?.network }) },
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    signedRequests: () => signedRequests,
    accepted: () => accepted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Stubbed TWZRD intel: answers /v1/intel/preflight from the INTEL table. No egress. */
function intelStub(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { seller_wallet?: string };
    const card = INTEL[body.seller_wallet ?? ""] ?? { decision: "warn", can_spend: false, trust_score: 0 };
    return new Response(JSON.stringify({ readiness_card: card }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * Drives the real foreign client end to end and reports what the signer saw.
 *
 * `installGate: false` is the negative control. Same fixture, same client, same
 * signer — TWZRD simply absent. It must reach the signer, which is what makes
 * the refuse path's `signerInvocations === 0` attributable to the gate rather
 * than to a fixture that could never have been signed in the first place.
 */
export async function runForeignClientProof(
  kind: "allow" | "refuse",
  opts: { installGate?: boolean; tamperAfterGate?: boolean } = {},
): Promise<ProofRun> {
  const fixtureOrigin = await startOrigin(kind);
  const decisions: GateDecision[] = [];
  const signerCalls: SignerCall[] = [];
  let signerInvocations = 0;

  const countingSigner = {
    address: BUYER,
    async signTransactions(transactions: ReadonlyArray<{ messageBytes: Uint8Array }>) {
      signerInvocations += 1;
      for (const tx of transactions) signerCalls.push(decodeTransferChecked(tx.messageBytes));
      return transactions.map(() => ({ [BUYER]: new Uint8Array(64) }));
    },
  };

  const requirement = loadFixture(kind, fixtureOrigin.origin).accepts[0];
  const [expectedDestinationAta] = await findAssociatedTokenPda({
    mint: requirement.asset as never,
    owner: requirement.payTo as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const client = new x402Client();
  client.register(requirement.network as never, new ExactSvmScheme(countingSigner as never, { rpcUrl: `${fixtureOrigin.origin}/rpc` }));
  if (opts.installGate !== false) {
    installTwzrdX402ClientHook(client as never, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch: intelStub(),
      onDecision: (d) =>
        decisions.push({ approved: d.approved, reason: d.reason, payTo: d.payTo, network: d.network, amountMicro: d.amountMicro }),
    });
  }

  // TOCTOU control. @x402/core runs beforePaymentCreation hooks in registration
  // order and then appends the SCHEME's own hook after every manual one
  // (getLabeledHooks in @x402/core/client), so code can always run after TWZRD.
  // installTwzrdX402ClientHook evaluates a shallow COPY of selectedRequirements
  // (pickReq, src/x402-client-hook.ts:202) while the client keeps the mutable
  // original, so a later hook can rewrite the recipient after approval. This
  // flag reproduces that; it is a documented limitation, not a TWZRD entry point.
  if (opts.tamperAfterGate) {
    (client as unknown as { onBeforePaymentCreation: (h: (c: { selectedRequirements: Record<string, unknown> }) => Promise<void>) => void })
      .onBeforePaymentCreation(async (ctx) => {
        ctx.selectedRequirements.payTo = SELLER_REFUSE;
      });
  }
  const paidFetch = wrapFetchWithPayment(fetch, client as never);
  let status: number | null = null;
  let error: string | null = null;
  try {
    status = (await paidFetch(`${fixtureOrigin.origin}/paid/${kind}`, { method: "GET" })).status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const originSignedRequests = fixtureOrigin.signedRequests();
  const originAccepted = fixtureOrigin.accepted();
  await fixtureOrigin.close();

  return {
    kind,
    requirement,
    expectedDestinationAta,
    decisions,
    signerInvocations,
    signerCalls,
    originSignedRequests,
    originAccepted,
    status,
    error,
  };
}

export type Check = { name: string; ok: boolean; detail: string };

/**
 * Turns a run into named, independently-assertable claims. The test asserts
 * each by name so a failure says which safety property broke; the CLI prints
 * them as the transcript. One definition, two consumers — no drift.
 */
export function verifyForeignClientProof(run: ProofRun): Check[] {
  const decision = run.decisions.at(-1);
  const signed = run.signerCalls[0];
  const check = (name: string, ok: boolean, detail: string): Check => ({ name: `${run.kind}/${name}`, ok, detail });

  if (run.kind === "refuse") {
    return [
      check("gate_evaluated_once", run.decisions.length === 1, `decisions=${run.decisions.length}`),
      check("gate_refused", decision?.approved === false, `reason=${decision?.reason ?? "<none>"}`),
      // PRIORITY #1 of the whole project: a refused payment reaches no signer.
      check("signer_never_invoked", run.signerInvocations === 0, `signerInvocations=${run.signerInvocations}`),
      check("nothing_was_signed", run.signerCalls.length === 0, `signedMessages=${run.signerCalls.length}`),
      check("no_paid_request_reached_merchant", run.originSignedRequests === 0, `signedRequests=${run.originSignedRequests}`),
      check("no_payload_reached_merchant", run.originAccepted === null, `accepted=${JSON.stringify(run.originAccepted)}`),
      check("refusal_surfaced_to_caller", run.status === null && /Payment creation aborted/.test(run.error ?? ""), `error=${run.error ?? "<none>"}`),
      check("refusal_names_the_merchant", (run.error ?? "").includes(run.requirement.payTo), `payTo=${run.requirement.payTo}`),
    ];
  }

  return [
    check("gate_evaluated_once", run.decisions.length === 1, `decisions=${run.decisions.length}`),
    check("gate_approved", decision?.approved === true, `reason=${decision?.reason ?? "<none>"}`),
    // The mirror of the refuse claim: an approved payment DOES reach the signer,
    // exactly once. Without this the block-path proof is vacuous.
    check("signer_invoked_exactly_once", run.signerInvocations === 1, `signerInvocations=${run.signerInvocations}`),
    check("one_message_signed", run.signerCalls.length === 1, `signedMessages=${run.signerCalls.length}`),
    // No swap between decision and signature: the signed SPL transfer must name
    // the amount, the asset and the recipient ATA the gate approved.
    check("signed_amount_matches_approved", signed?.amountMicro === run.requirement.amount && decision?.amountMicro === run.requirement.amount,
      `signed=${signed?.amountMicro} approved=${decision?.amountMicro} required=${run.requirement.amount}`),
    check("signed_recipient_matches_approved", signed?.destinationAta === run.expectedDestinationAta,
      `signed=${signed?.destinationAta} expectedAtaOf(${run.requirement.payTo})=${run.expectedDestinationAta}`),
    check("signed_asset_matches_approved", signed?.mint === run.requirement.asset, `signed=${signed?.mint} required=${run.requirement.asset}`),
    check("signed_authority_is_the_buyer", signed?.authority === BUYER, `authority=${signed?.authority}`),
    check("merchant_received_the_approved_requirement",
      run.originAccepted?.payTo === run.requirement.payTo &&
        run.originAccepted?.amount === run.requirement.amount &&
        run.originAccepted?.network === decision?.network &&
        run.originAccepted?.asset === run.requirement.asset,
      `accepted=${JSON.stringify(run.originAccepted && { payTo: run.originAccepted.payTo, amount: run.originAccepted.amount, network: run.originAccepted.network })}`),
    check("settled_once", run.status === 200 && run.originSignedRequests === 1, `status=${run.status} signedRequests=${run.originSignedRequests}`),
  ];
}

/**
 * Checks for the ungated control run. These are the falsification: if the
 * control does NOT sign, the refuse path's zero proves nothing.
 */
export function verifyNegativeControl(run: ProofRun): Check[] {
  return [
    { name: "control/gate_absent", ok: run.decisions.length === 0, detail: `decisions=${run.decisions.length}` },
    { name: "control/signer_reachable_without_gate", ok: run.signerInvocations === 1, detail: `signerInvocations=${run.signerInvocations}` },
    { name: "control/flagged_merchant_would_have_been_paid", ok: run.status === 200 && run.originSignedRequests === 1, detail: `status=${run.status} paidRequests=${run.originSignedRequests}` },
  ];
}

/**
 * Checks for the post-approval tamper control. It asserts the swap SUCCEEDS —
 * that is the honest limit of the onBeforePaymentCreation seat against a
 * non-cooperating foreign signer — and that this harness detects it.
 */
export function verifyPostApprovalTamper(run: ProofRun): Check[] {
  const signed = run.signerCalls[0];
  const detector = verifyForeignClientProof(run).filter((c) => !c.ok).map((c) => c.name);
  return [
    { name: "tamper/gate_approved_the_original_merchant", ok: run.decisions[0]?.payTo === run.requirement.payTo, detail: `approved=${run.decisions[0]?.payTo}` },
    { name: "tamper/later_hook_diverted_the_signature", ok: signed?.destinationAta !== undefined && signed.destinationAta !== run.expectedDestinationAta, detail: `signed=${signed?.destinationAta} approvedAta=${run.expectedDestinationAta}` },
    { name: "tamper/proof_detects_the_diversion", ok: detector.includes("allow/signed_recipient_matches_approved"), detail: `failedChecks=${detector.join(",") || "<none>"}` },
  ];
}

/** Standalone transcript. Exits non-zero on any failed check. */
export async function main(): Promise<number> {
  console.log("foreign-client-proof — real @x402 client, counting signer, offline fixture origin");
  let failures = 0;
  for (const kind of ["refuse", "allow"] as const) {
    const run = await runForeignClientProof(kind);
    console.log(`\n=== ${kind.toUpperCase()} PATH ===`);
    console.log(`  merchant       ${run.requirement.payTo}`);
    console.log(`  amount(micro)  ${run.requirement.amount}   network ${run.requirement.network}`);
    console.log(`  gate           ${run.decisions.map((d) => `${d.approved ? "APPROVE" : "REFUSE"} ${d.reason}`).join(" | ") || "<never ran>"}`);
    console.log(`  signer         invocations=${run.signerInvocations} signedMessages=${run.signerCalls.length}`);
    if (run.signerCalls[0]) console.log(`  signed         ${JSON.stringify(run.signerCalls[0])}`);
    console.log(`  merchant saw   status=${run.status} paidRequests=${run.originSignedRequests}`);
    if (run.error) console.log(`  surfaced       ${run.error}`);
    console.log("  checks:");
    for (const c of verifyForeignClientProof(run)) {
      if (!c.ok) failures += 1;
      console.log(`    ${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
    }
  }
  const tamper = await runForeignClientProof("allow", { tamperAfterGate: true });
  console.log("\n=== TOCTOU CONTROL (a hook registered AFTER TWZRD rewrites payTo) ===");
  console.log(`  approved       ${tamper.decisions[0]?.payTo}`);
  console.log(`  actually signed ATA of a different merchant: ${tamper.signerCalls[0]?.destinationAta}`);
  for (const c of verifyPostApprovalTamper(tamper)) {
    if (!c.ok) failures += 1;
    console.log(`    ${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  }

  const control = await runForeignClientProof("refuse", { installGate: false });
  console.log("\n=== NEGATIVE CONTROL (same flagged merchant, TWZRD not installed) ===");
  console.log(`  signer         invocations=${control.signerInvocations}   merchant saw status=${control.status}`);
  for (const c of verifyNegativeControl(control)) {
    if (!c.ok) failures += 1;
    console.log(`    ${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  }
  console.log(
    `\nRESULT: ${failures === 0 ? "GREEN — every check held. Refusals never reach the signer; approvals sign exactly what was approved, EXCEPT against code that runs after TWZRD in the hook chain (see TOCTOU control)." : `RED — ${failures} failed check(s)`}`,
  );
  return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  process.exit(
    await main().catch((e) => {
      console.error("foreign-client-proof THREW", e);
      return 1;
    }),
  );
}
