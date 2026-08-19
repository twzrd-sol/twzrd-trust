/**
 * Gate Adoption Proof Harness — deterministic, no-spend, package-local.
 *
 * Closes the install→transcript gap for operators who already installed
 * installTwzrdX402ClientHook / installTwzrdAutoGate:
 *   1) exact selectedRequirements reach the pre-sign hook
 *   2) onDecision emits a verdict
 *   3) block path aborts and never invokes a wallet/signer stub
 *   4) attribution (integration + runId + client) is stamped on preflight only
 *
 * This harness is correlation / integration evidence. It is NOT EXTERNAL_RUN
 * by itself (see docs/strategy/gate-adoption-operator-proof.md).
 */

import { CLIENT_VERSION } from "./version.js";
import {
  installTwzrdX402ClientHook,
  type BeforePaymentCreationContext,
  type BeforePaymentCreationResult,
  type X402ClientLike,
  type X402SelectedRequirements,
} from "./x402-client-hook.js";

export const ADOPTION_TRANSCRIPT_SCHEMA = "twzrd.gate_adoption_transcript.v1" as const;

/** Fixture merchant pubkey (base58-shaped); not a live spend target. */
export const ADOPTION_PROOF_SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
export const ADOPTION_PROOF_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ADOPTION_PROOF_RESOURCE = "https://merchant.example/twzrd-adoption-proof";

export type GateAdoptionStepName = "block_path" | "allow_path";

export type GateAdoptionStep = {
  name: GateAdoptionStepName;
  selectedRequirements: X402SelectedRequirements;
  abort: boolean;
  reason?: string;
  decisionEmitted: boolean;
  verdict: string;
  approved: boolean;
  /**
   * payTo as reported by the hook's onDecision callback (hook-derived).
   * Used to prove selectedRequirements reached the real hook path — not
   * merely echoed from harness-local selectedRequirements.
   */
  hookPayTo?: string;
  /**
   * seller_wallet from the preflight JSON body the hook actually POSTed
   * (hook-derived via mocked fetch recorder).
   */
  preflightSellerWallet?: string | null;
  /** Count of wallet/signer stub invocations during this step (must be 0). */
  signerInvocations: number;
  /** Headers observed on the mocked preflight fetch for this step. */
  preflightAttribution: {
    integration: string | null;
    runId: string | null;
    client: string | null;
  };
};

export type GateAdoptionAssertions = {
  selectedRequirementReachedHook: boolean;
  decisionEmitted: boolean;
  blockedPathNeverInvokesSigner: boolean;
  allowPathNeverInvokesSigner: boolean;
  attributionSurfaced: boolean;
};

/**
 * Lineage of this transcript.
 * - dogfood: package harness, CI, or TWZRD-authored run
 * - external_candidate: operator-supplied integration id (still needs server-side join for EXTERNAL_RUN)
 */
export type GateAdoptionLineage = "dogfood" | "external_candidate";

export type GateAdoptionTranscript = {
  schema: typeof ADOPTION_TRANSCRIPT_SCHEMA;
  package: "twzrd-x402-gate";
  packageVersion: string;
  proofKind: "local_deterministic_harness";
  mode: "no_spend";
  integration: string;
  runId: string;
  lineage: GateAdoptionLineage;
  clientHeader: string;
  steps: GateAdoptionStep[];
  assertions: GateAdoptionAssertions;
  ok: boolean;
  /**
   * What this transcript is NOT. Operators must not treat package downloads,
   * free preflight hits alone, or self-authored runIds as EXTERNAL_RUN.
   */
  notExternalRunProof: string[];
  /** Human pointer to the acceptance contract. */
  acceptanceDoc: "docs/strategy/gate-adoption-operator-proof.md";
};

export type RunGateAdoptionProofOptions = {
  /** Stable integration label (e.g. "acme-agent-v1"). Default dogfood label. */
  integration?: string;
  /** Per-run id. Default random UUID. Echo in your issue / transcript. */
  runId?: string;
  /**
   * Mark lineage external_candidate when the operator sets a non-internal integration id.
   * Still not EXTERNAL_RUN without server-side observation (see acceptance doc).
   */
  lineage?: GateAdoptionLineage;
};

function mockClient(): {
  client: X402ClientLike;
  fire: (ctx: BeforePaymentCreationContext) => Promise<BeforePaymentCreationResult>;
} {
  let hook:
    | ((
        ctx: BeforePaymentCreationContext,
      ) => Promise<BeforePaymentCreationResult> | BeforePaymentCreationResult)
    | undefined;
  const client: X402ClientLike = {
    onBeforePaymentCreation(h) {
      hook = h;
      return client;
    },
  };
  return {
    client,
    async fire(ctx) {
      if (!hook) throw new Error("adoption-proof: hook not installed");
      return hook(ctx);
    },
  };
}

function preflightCard(decision: "allow" | "block" | "warn", canSpend: boolean) {
  return {
    readiness_card: {
      decision,
      can_spend: canSpend,
      trust_score: decision === "block" || !canSpend ? 10 : 90,
      seller_wallet: ADOPTION_PROOF_SELLER,
    },
    preflight_id: decision === "block" || !canSpend ? 1 : 2,
  };
}

function recordingPreflightFetch(body: unknown): {
  fetch: typeof fetch;
  lastHeaders: () => Headers | null;
  lastSellerWallet: () => string | null;
} {
  let last: Headers | null = null;
  let lastSeller: string | null = null;
  const fetchImpl = (async (_url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    last = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    lastSeller = null;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as { seller_wallet?: unknown };
        if (typeof parsed.seller_wallet === "string") lastSeller = parsed.seller_wallet;
      } catch {
        // ignore non-JSON bodies
      }
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    lastHeaders: () => last,
    lastSellerWallet: () => lastSeller,
  };
}

function baseRequirements(amount: string): X402SelectedRequirements {
  return {
    payTo: ADOPTION_PROOF_SELLER,
    network: ADOPTION_PROOF_NETWORK,
    amount,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    resource: ADOPTION_PROOF_RESOURCE,
    scheme: "exact",
  };
}

function isInternalIntegration(integration: string): boolean {
  const i = integration.toLowerCase();
  return (
    i.startsWith("twzrd-") ||
    i.startsWith("twzrd/") ||
    i.startsWith("ops-") ||
    i.startsWith("test-") ||
    i === "dogfood" ||
    i.includes("dogfood") ||
    i.includes("internal") ||
    i.includes("ci-") ||
    i === "gate-adoption-proof"
  );
}

/**
 * Run the deterministic no-spend adoption proof.
 * Never contacts a wallet; never spends USDC. Preflight is mocked.
 */
export async function runGateAdoptionProof(
  opts: RunGateAdoptionProofOptions = {},
): Promise<GateAdoptionTranscript> {
  const integration = opts.integration?.trim() || "gate-adoption-proof";
  const runId =
    opts.runId?.trim() ||
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `run-${Date.now()}`);
  const lineage: GateAdoptionLineage =
    opts.lineage ??
    (isInternalIntegration(integration) ? "dogfood" : "external_candidate");

  const clientHeader = `twzrd-x402-gate/${CLIENT_VERSION}`;
  const steps: GateAdoptionStep[] = [];

  // ── block path: can_spend false → abort, signer must stay 0 ─────────────
  {
    const signerInvocations = { n: 0 };
    const signer = {
      async sign() {
        signerInvocations.n += 1;
        throw new Error("adoption-proof: signer must not be called");
      },
    };
    const { fetch, lastHeaders, lastSellerWallet } = recordingPreflightFetch(
      preflightCard("warn", false),
    );
    const { client, fire } = mockClient();
    let decisionDetail:
      | { approved: boolean; verdict: string; reason: string; payTo?: string }
      | undefined;

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      fetch,
      attribution: { integration, runId },
      onDecision: (d) => {
        decisionDetail = {
          approved: d.approved,
          verdict: d.verdict,
          reason: d.reason,
          payTo: d.payTo,
        };
      },
    });

    // Operator would call wallet.signMessage only after hook returns non-abort.
    // We only invoke signer if the hook allows — proving block never reaches it.
    const req = baseRequirements("1000");
    const result = await fire({ selectedRequirements: req });
    const abort = Boolean(result && typeof result === "object" && "abort" in result && result.abort);
    if (!abort) {
      await signer.sign();
    }
    const h = lastHeaders();
    const abortReason =
      abort && result && typeof result === "object" && "reason" in result
        ? String((result as { reason: string }).reason)
        : undefined;
    steps.push({
      name: "block_path",
      selectedRequirements: req,
      abort,
      reason: abortReason,
      decisionEmitted: decisionDetail != null,
      verdict: decisionDetail?.verdict ?? "missing",
      approved: decisionDetail?.approved ?? false,
      hookPayTo: decisionDetail?.payTo,
      preflightSellerWallet: lastSellerWallet(),
      signerInvocations: signerInvocations.n,
      preflightAttribution: {
        integration: h?.get("x-twzrd-integration") ?? null,
        runId: h?.get("x-twzrd-run-id") ?? null,
        client: h?.get("x-twzrd-client") ?? null,
      },
    });
  }

  // ── allow path: decision allow, still no real wallet spend ──────────────
  {
    const signerInvocations = { n: 0 };
    const { fetch, lastHeaders, lastSellerWallet } = recordingPreflightFetch(
      preflightCard("allow", true),
    );
    const { client, fire } = mockClient();
    let decisionDetail:
      | { approved: boolean; verdict: string; reason: string; payTo?: string }
      | undefined;

    installTwzrdX402ClientHook(client, {
      gateOnCanSpend: true,
      refuseWashFlagged: false,
      preflightMinScore: 40,
      fetch,
      attribution: { integration, runId },
      onDecision: (d) => {
        decisionDetail = {
          approved: d.approved,
          verdict: d.verdict,
          reason: d.reason,
          payTo: d.payTo,
        };
      },
    });

    const req = baseRequirements("1000");
    const result = await fire({ selectedRequirements: req });
    const abort = Boolean(result && typeof result === "object" && "abort" in result && result.abort);
    // Allow path: payload construction would run next — we do not call a wallet signer
    // in this no_spend harness (proves allow decision without spend).
    void signerInvocations;
    const h = lastHeaders();
    steps.push({
      name: "allow_path",
      selectedRequirements: req,
      abort,
      reason: abort && result && typeof result === "object" && "reason" in result
        ? String((result as { reason: string }).reason)
        : undefined,
      decisionEmitted: decisionDetail != null,
      verdict: decisionDetail?.verdict ?? "missing",
      approved: decisionDetail?.approved ?? false,
      hookPayTo: decisionDetail?.payTo,
      preflightSellerWallet: lastSellerWallet(),
      signerInvocations: signerInvocations.n,
      preflightAttribution: {
        integration: h?.get("x-twzrd-integration") ?? null,
        runId: h?.get("x-twzrd-run-id") ?? null,
        client: h?.get("x-twzrd-client") ?? null,
      },
    });
  }

  const block = steps.find((s) => s.name === "block_path")!;
  const allow = steps.find((s) => s.name === "allow_path")!;

  // Hook-derived only: onDecision.payTo, abort reason, and preflight POST body.
  // Do NOT use step.selectedRequirements (harness-echo) for this flag.
  const blockHookSawSeller =
    block.hookPayTo === ADOPTION_PROOF_SELLER ||
    (typeof block.reason === "string" && block.reason.includes(ADOPTION_PROOF_SELLER)) ||
    block.preflightSellerWallet === ADOPTION_PROOF_SELLER;
  const allowHookSawSeller =
    allow.hookPayTo === ADOPTION_PROOF_SELLER ||
    allow.preflightSellerWallet === ADOPTION_PROOF_SELLER;

  const assertions: GateAdoptionAssertions = {
    selectedRequirementReachedHook: blockHookSawSeller && allowHookSawSeller,
    decisionEmitted: block.decisionEmitted && allow.decisionEmitted,
    blockedPathNeverInvokesSigner: block.abort === true && block.signerInvocations === 0,
    allowPathNeverInvokesSigner: allow.signerInvocations === 0 && allow.abort === false,
    attributionSurfaced:
      block.preflightAttribution.integration === integration &&
      block.preflightAttribution.runId === runId &&
      block.preflightAttribution.client === clientHeader &&
      allow.preflightAttribution.integration === integration &&
      allow.preflightAttribution.runId === runId,
  };

  const ok = Object.values(assertions).every(Boolean);

  return {
    schema: ADOPTION_TRANSCRIPT_SCHEMA,
    package: "twzrd-x402-gate",
    packageVersion: CLIENT_VERSION,
    proofKind: "local_deterministic_harness",
    mode: "no_spend",
    integration,
    runId,
    lineage,
    clientHeader,
    steps,
    assertions,
    ok,
    notExternalRunProof: [
      "package_download_counts",
      "preflight_hits_alone",
      "self_authored_run_id_without_operator_transcript",
      "this_harness_alone_without_server_side_join",
    ],
    acceptanceDoc: "docs/strategy/gate-adoption-operator-proof.md",
  };
}

/** CLI entry: print one JSON transcript to stdout; exit 0 if ok else 1. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let integration: string | undefined;
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--integration" && argv[i + 1]) integration = argv[++i];
    else if (a === "--run-id" && argv[i + 1]) runId = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: npm run adoption-proof -- [--integration <id>] [--run-id <uuid>]\n" +
          "Deterministic no-spend gate adoption transcript (JSON on stdout).\n" +
          "See docs/strategy/gate-adoption-operator-proof.md\n",
      );
      return 0;
    }
  }
  const transcript = await runGateAdoptionProof({ integration, runId });
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  return transcript.ok ? 0 : 1;
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("adoption-proof.ts") ||
    process.argv[1].endsWith("adoption-proof.js"));

if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
