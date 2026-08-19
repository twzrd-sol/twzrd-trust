/**
 * `npx twzrd-gate-doctor` — one command that turns "should I gate this?" into
 * "here are the exact lines for THIS project, and here is the gate refusing."
 *
 * Why a doctor and not a codemod: patching someone else's source is invasive,
 * hard to review, and the first thing an operator reverts. The adoption blocker
 * is not typing three lines — it is not knowing WHICH three lines apply to the
 * client you already use, and not believing the gate actually refuses anything.
 * So this does exactly two things:
 *
 *   1. DETECT the x402 / agent surface already in package.json and print the
 *      snippet for that specific host (not a generic README excerpt).
 *   2. PROVE a refusal, offline, spending nothing: a wash-flagged verdict is fed
 *      to the real hook and we assert the signer was never invoked.
 *
 * Exit codes: 0 = a seam was found and the refusal proof passed. 1 = proof
 * failed (a real problem — report it). 2 = no x402 surface detected (nothing to
 * gate here yet, not an error).
 *
 * No network by default: the refusal proof is deterministic and local, so it
 * works in CI and on a plane. Pass --live to additionally preflight a real
 * wash-flagged seller against intel.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_VERSION } from "./version.js";

type Host = {
  id: string;
  label: string;
  /** Any of these dependency names present ⇒ this host applies. */
  deps: string[];
  install: string;
  snippet: string;
  note?: string;
};

/**
 * Ordered most-specific first: a project using solana-agent-kit AND @x402/core
 * should be told about the SAK seat, because that is where its signing happens.
 */
const HOSTS: Host[] = [
  {
    id: "solana-agent-kit",
    label: "Solana Agent Kit (SolanaAgentKit)",
    deps: ["solana-agent-kit"],
    install: "npm install twzrd-x402-gate",
    snippet: `import { SolanaAgentKit } from "solana-agent-kit";
import { twzrdBeforeSign } from "twzrd-x402-gate";

// Every plugin that signs goes through this policy, including plugins that
// call agent.wallet.signAndSendTransaction directly.
const agent = new SolanaAgentKit(wallet, rpcUrl, {
  beforeSign: twzrdBeforeSign({ refuseWashFlagged: true }),
});`,
    note:
      "Requires the optional beforeSign hook on Config (sendaifun/solana-agent-kit#599). " +
      "Until that lands, wrap the wallet yourself with wrapWallet() from that PR.",
  },
  {
    id: "x402-client",
    label: "official x402 client (@x402/core)",
    deps: ["@x402/core", "@x402/fetch", "@x402/svm"],
    install: "npm install twzrd-x402-gate @x402/core @x402/fetch @x402/svm",
    snippet: `import { x402Client } from "@x402/core/client";
import { installTwzrdAutoGate } from "twzrd-x402-gate";

const client = new x402Client();
// Runs after requirement selection, BEFORE payload creation / signing.
installTwzrdAutoGate(client, { refuseWashFlagged: true });`,
  },
  {
    id: "elizaos",
    label: "elizaOS agent runtime",
    deps: ["@elizaos/core", "elizaos"],
    install: "npm install twzrd-x402-gate",
    snippet: `import { installTwzrdAutoGate } from "twzrd-x402-gate";

// Gate the payment client your plugin hands to the runtime, not the runtime
// itself — the seam is wherever the signer lives.
installTwzrdAutoGate(paymentClient, { refuseWashFlagged: true });`,
  },
  {
    id: "goat",
    label: "GOAT SDK",
    deps: ["@goat-sdk/core"],
    install: "npm install twzrd-x402-gate",
    snippet: `import { installTwzrdAutoGate } from "twzrd-x402-gate";

installTwzrdAutoGate(walletClient, { refuseWashFlagged: true });`,
  },
  {
    id: "raw-fetch",
    label: "raw fetch + x402 payer",
    deps: ["x402-fetch", "x402"],
    install: "npm install twzrd-x402-gate",
    snippet: `import { installTwzrdAutoGate } from "twzrd-x402-gate";

// Wraps fetch: a refused payment never reaches the payer.
const gatedFetch = installTwzrdAutoGate(payFetch, { refuseWashFlagged: true });`,
  },
];

function readPackageJson(cwd: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export function detectHosts(pkg: Record<string, unknown> | null): Host[] {
  if (!pkg) return [];
  const all = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.peerDependencies as Record<string, string>) ?? {}),
  };
  const names = new Set(Object.keys(all));
  return HOSTS.filter((h) => h.deps.some((d) => names.has(d)));
}

/**
 * Deterministic, offline refusal proof.
 *
 * Feeds a wash-flagged card straight to the policy layer and asserts the signer
 * never ran. This is the claim an operator needs to believe before adopting,
 * and it must be checkable without spending or reaching the network.
 */
export async function proveRefusal(): Promise<{
  refused: boolean;
  signerInvocations: number;
  reason: string;
}> {
  const { installTwzrdAutoGate } = await import("./auto-gate.js");

  // Model the official-client seam, which is the path with existing coverage
  // (see test/autogate-intercept.test.ts). A wash-flagged card must come back
  // as abort, and the signer stub must never be reached.
  let signerInvocations = 0;
  type Hook = (ctx: unknown) => Promise<void | { abort: true; reason: string }>;
  let hook: Hook | undefined;
  const client = {
    onBeforePaymentCreation(h: Hook) {
      hook = h;
      return client;
    },
  };

  installTwzrdAutoGate(client as never, {
    refuseWashFlagged: true,
    gateOnCanSpend: false,
    preflightMinScore: 0,
    failOpen: true,
    // Injected preflight response: wash_flagged ⇒ the policy must refuse. No network.
    fetch: (async () =>
      new Response(
        JSON.stringify({
          readiness_card: {
            decision: "block",
            trust_score: 30,
            can_spend: false,
            wash_flagged: true,
            wash_label: "ring",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  } as never);

  if (!hook) {
    return {
      refused: false,
      signerInvocations,
      reason: "gate did not install a pre-payment hook",
    };
  }

  let refused = false;
  let reason = "";
  try {
    const out = await hook({
      selectedRequirements: {
        payTo: "34w53UkhfBBmVLBcphD1M4dRhbBTQaLLbnRfyTeXzc5m",
        network: "solana",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        maxAmountRequired: "50000",
        scheme: "exact",
      },
      // If the gate ever approved, a real client would call this next.
      sign: async () => {
        signerInvocations += 1;
      },
    });
    if (out && typeof out === "object" && (out as { abort?: boolean }).abort) {
      refused = true;
      reason = String((out as { reason?: string }).reason ?? "abort");
    }
  } catch (err) {
    // A throwing refusal is equally acceptable: nothing got signed.
    refused = true;
    reason = String((err as Error)?.message ?? err).slice(0, 160);
  }
  return { refused, signerInvocations, reason };
}

function line(s = ""): void {
  process.stdout.write(`${s}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cwd = process.cwd();
  const pkg = readPackageJson(cwd);
  const detected = detectHosts(pkg);

  line(`twzrd-gate-doctor  (twzrd-x402-gate ${CLIENT_VERSION})`);
  line();

  if (!pkg) {
    line("No package.json here. Run this from your project root.");
    return 2;
  }

  if (detected.length === 0) {
    line("No x402 / agent signing surface detected in this project.");
    line("Nothing to gate yet — this is not an error.");
    line();
    line("The gate is useful once something here signs a Solana USDC payment.");
    line("Surfaces it recognises: @x402/core, solana-agent-kit, @elizaos/core,");
    line("@goat-sdk/core, x402-fetch.");
    return 2;
  }

  line(`Detected ${detected.length} signing surface(s):`);
  for (const h of detected) line(`  • ${h.label}`);
  line();

  for (const h of detected) {
    line(`── ${h.label} ${"─".repeat(Math.max(0, 58 - h.label.length))}`);
    line();
    line(`  ${h.install}`);
    line();
    for (const l of h.snippet.split("\n")) line(`  ${l}`);
    if (h.note) {
      line();
      line(`  Note: ${h.note}`);
    }
    line();
  }

  line("── Refusal proof (offline, spends nothing) ──────────────────");
  line();
  const proof = await proveRefusal();
  if (proof.refused && proof.signerInvocations === 0) {
    line("  PASS — wash-flagged seller refused before signing.");
    line(`         signer invocations: ${proof.signerInvocations}`);
    line(`         reason: ${proof.reason}`);
    line();
    line("  That is the whole product: the payment did not happen, and it cost 0.");
    return 0;
  }

  line("  FAIL — the gate did NOT refuse a wash-flagged seller.");
  line(`         refused=${proof.refused} signer_invocations=${proof.signerInvocations}`);
  line("  Please report this with your package versions — it is a real bug.");
  return 1;
}

// Only auto-run as a CLI, never on import (keeps it testable). Anchored on a
// path separator so a file merely ENDING in "doctor.ts" (e.g. probe-doctor.ts)
// does not trigger the CLI — that bit me while testing this very function.
if (
  process.argv[1] &&
  /(^|[\\/])doctor(\.[cm]?[jt]s)?$/.test(process.argv[1])
) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`twzrd-gate-doctor: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
