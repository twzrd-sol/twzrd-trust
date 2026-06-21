/**
 * First-installer example: the smallest real buyer-side trust gate.
 *
 * What a real agent does before paying an x402 seller it hasn't vetted:
 *
 *   npm i @wzrd_sol/plugin-trustgate
 *   npx tsx first-installer.ts
 *
 * No auth, no API key, no cost — the gate calls the FREE TWZRD preflight.
 *
 * Live proof case: 34w53Ukh is a real, non-TWZRD merchant the corpus flags
 * (wash_flagged, 91.4% captive payers) that a real shopper actually paid ~$7,957.
 * The gate returns decision=block, so the agent aborts the spend.
 */
import { checkTrust, canSpendSafely } from "@wzrd_sol/plugin-trustgate";

// A wash-flagged seller (block) and a clean hub (warn) on the live PayAI rail.
const FLAGGED = "34w53Ukhf4Bv5SZjU8Dez76r8fhxaKvdqc4eoCzeete6";
const CLEAN = "7uh2ibD1nAoL9UohbaNTubsMZK5321cKB8E8kPQQVZyj";

async function main() {
  // --- 1. The full verdict (checkTrust returns the object) ---
  const verdict = await checkTrust(FLAGGED);
  console.log("seller:    ", FLAGGED.slice(0, 8) + "...");
  console.log("decision:  ", verdict.decision, `(trust ${verdict.trustScore})`);
  console.log("agent:     ", verdict.blocked ? "ABORT — do not sign" : "OK to pay");
  console.log("reason:    ", verdict.reason);

  // --- 2. The one-line guard your payment action calls (returns boolean) ---
  //     canSpendSafely(sellerWallet) === false  =>  abort the spend.
  if (!(await canSpendSafely(FLAGGED))) {
    console.log("\nAUTONOMOUS BLOCK: guard refused the wash-flagged seller.");
  }

  // --- 3. Control: a clean seller is not hard-blocked ---
  const clean = await checkTrust(CLEAN);
  console.log(
    `\ncontrol ${CLEAN.slice(0, 8)}... -> ${clean.decision} (trust ${clean.trustScore}); ` +
      `${clean.blocked ? "blocked" : "proceeds"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
