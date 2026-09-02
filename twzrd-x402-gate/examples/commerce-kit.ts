#!/usr/bin/env tsx
/**
 * Don't let your agent sign blind.
 *
 * One outsider-copyable path for the commerce loop:
 *   directory → preflight → policy → pay-or-refuse → verify → evidence bundle
 *
 * Default is the refuse-first demo (live refuse-fixture, 0 USDC, signer never called).
 * This run is dogfood unless a foreign operator sets their own --integration id
 * and publishes the bundle from their own environment.
 *
 *   npx tsx examples/commerce-kit.ts
 *   npx tsx examples/commerce-kit.ts --offline
 *   npx tsx examples/commerce-kit.ts --directory
 *   npx tsx examples/commerce-kit.ts --integration acme-ops-agent-v1 --run-id <uuid>
 */

import { randomUUID } from "node:crypto";

import { installTwzrdAutoGate } from "../src/auto-gate.js";
import { resolveConfig } from "../src/config.js";
import {
  listDirectoryCallables,
  pickCallable,
  type DirectoryListing,
} from "../src/directory.js";
import {
  exportEvidenceBundle,
  writeEvidenceBundle,
  exportEvidenceBundleFromAdoptionProof,
  type EvidenceBundle,
} from "../src/evidence-bundle.js";
import { fetchMerchantCard } from "../src/merchant-card.js";
import { twzrdApprovePayment } from "../src/policy.js";

const INTEL = (process.env.TWZRD_INTEL_BASE ?? "https://intel.twzrd.xyz").replace(/\/+$/, "");
const REFUSE_URL = `${INTEL}/v1/intel/refuse-fixture`;
const REFUSE_PAYTO = "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};
const offline = args.includes("--offline");
const directoryOnly = args.includes("--directory");
const integration = flag("--integration") ?? "demo-commerce-kit";
const runId = flag("--run-id") ?? randomUUID();
const outPath = flag("--out");

function logStep(n: number, title: string, data: unknown) {
  console.log(`\n[${n}] ${title}`);
  console.log(JSON.stringify(data, null, 2));
}

async function stepDirectory(): Promise<DirectoryListing | null> {
  try {
    const listings = await listDirectoryCallables({ intelBase: INTEL, limit: 10, live402Only: true });
    const picked = pickCallable(listings);
    logStep(2, "Directory (trust beside, not inside)", {
      count: listings.length,
      picked: picked
        ? { resourceUrl: picked.resourceUrl, payTo: picked.payTo, live402: picked.live402, source: picked.source }
        : null,
      note: "Bazaars list callables. TWZRD decides whether to pay pay_to.",
    });
    return picked;
  } catch (err) {
    logStep(2, "Directory unavailable — continuing with refuse fixture", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function stepPreflight(payTo: string, resourceUrl: string) {
  const approval = await twzrdApprovePayment(
    {
      sellerWallet: payTo,
      resourceUrl,
      resourceName: "commerce-kit",
      priceUsdc: 0.001,
      agentIntent: "commerce_kit_preflight",
    },
    resolveConfig({
      intelBase: INTEL,
      attribution: { integration, runId },
    }),
  );
  const card = await fetchMerchantCard(payTo, { intelBase: INTEL, fetch });
  logStep(3, "Preflight + merchant_card", {
    verdict: approval.verdict,
    approved: approval.approved,
    reason: approval.reason,
    preflight_id: approval.card?.preflight_id ?? null,
    wash_flagged: card?.wash_flagged ?? null,
    note: "Free preflight does not enforce. AutoGate on the pay path enforces.",
  });
  return approval;
}

async function stepAutogateRefuse(resourceUrl: string) {
  let signerInvocations = 0;
  const payingFetch = installTwzrdAutoGate(
    (guarded) => {
      return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await guarded(input, init);
        if (response.status === 402) {
          signerInvocations += 1;
          throw new Error("commerce-kit: signer reached — gate should have blocked first");
        }
        return response;
      };
    },
    {
      intelBase: INTEL,
      refuseWashFlagged: true,
      failOpen: false,
      attribution: { integration, runId },
    },
  );

  let blocked = false;
  let reason: string | undefined;
  try {
    await payingFetch(resourceUrl);
  } catch (err) {
    blocked = true;
    reason = err instanceof Error ? err.message : String(err);
  }

  const result = {
    seat: "installTwzrdAutoGate",
    blocked,
    signerInvocations,
    reason,
  };
  logStep(4, "Pay only when policy allows (AutoGate)", result);
  if (signerInvocations !== 0) {
    throw new Error("commerce-kit: signerInvocations must be 0 on the refuse path");
  }
  return result;
}

async function main() {
  console.log("Don't let your agent sign blind.");
  console.log(`integration=${integration} runId=${runId} lineage hint=${/^demo-|^gate-|^twzrd-|^ops-/.test(integration) ? "dogfood" : "external_candidate"}`);

  if (offline) {
    const bundle = await exportEvidenceBundleFromAdoptionProof({ integration, runId });
    logStep(1, "Offline adoption harness (0 USDC)", {
      schema: bundle.schema,
      decision: bundle.decision,
      lineage: bundle.lineage,
      notExternalRunProof: bundle.notExternalRunProof,
    });
    if (outPath) writeEvidenceBundle(bundle, outPath);
    else console.log("\n[6] Evidence bundle\n" + JSON.stringify(bundle, null, 2));
    return;
  }

  logStep(1, "Install", {
    package: "twzrd-x402-gate@0.9.3",
    seat: "installTwzrdAutoGate",
    mcp: "https://intel.twzrd.xyz/mcp",
  });

  const picked = await stepDirectory();
  if (directoryOnly) return;

  const resourceUrl = REFUSE_URL;
  const payTo = REFUSE_PAYTO;
  console.log("\n[2b] Refuse-first target (owned fixture, not a brand judgment)");
  console.log(JSON.stringify({
    resourceUrl,
    payTo,
    directoryPickIgnoredForRefuseDemo: picked?.resourceUrl ?? null,
  }, null, 2));

  const approval = await stepPreflight(payTo, resourceUrl);
  const gate = await stepAutogateRefuse(resourceUrl);

  logStep(5, "Verify receipt", {
    skipped: true,
    reason: "refuse path produces no settlement; bind-v1 / V6 apply after an allowed pay",
  });

  const bundle: EvidenceBundle = exportEvidenceBundle({
    attribution: { integration, runId },
    decision: {
      verdict: approval.verdict,
      approved: approval.approved,
      reason: approval.reason ?? gate.reason,
      signerInvocations: gate.signerInvocations,
      preflightId: approval.card?.preflight_id ?? null,
    },
    outcomeAttestation: { outcome: "blocked_never_signed" },
    ledger: { spendRows: 0, verdicts: [{ outcome: "block", signer_invocations: 0 }] },
  });
  logStep(6, "Evidence bundle (not EXTERNAL_RUN by itself)", bundle);
  if (outPath) writeEvidenceBundle(bundle, outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
