/**
 * Drift-resilient blocked-seller fixture for the block-proof examples.
 *
 * The wash overlay is corpus-derived and moves: BJGdsDXJ… was live
 * wash_flagged=true as of 2026-07-26 and had drifted to false by 2026-08-03,
 * which made both proof commands exit(2) on a fixture guard — a broken hero
 * command, not a broken gate. The gate refuses on EITHER wash_flagged or a
 * readiness decision=block, so the proof falls back to a live decision=block
 * seller when the wash fixture drifts.
 *
 * Resolution order:
 *   1. WASH_PAYTO (or the historical default) if merchant_card.wash_flagged=true
 *   2. BLOCK_PAYTO (or the default) if live preflight decision=block
 *   3. exit(2) with both hints
 */

export type BlockedFixture = {
  seller: string;
  /** Which refuse path the fixture exercises. */
  basis: "wash_flagged" | "decision_block";
};

/** Historically wash_flagged; re-verified live on every run. */
export const DEFAULT_WASH = "BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ";
/**
 * Live decision=block readiness card as of 2026-08-03 (trust 31,
 * can_spend=false): the pump.fun fee account — a real, heavily-probed payTo
 * that the corpus scores as block. Re-verified live on every run.
 */
export const DEFAULT_BLOCK = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export async function resolveBlockedSeller(intel: string): Promise<BlockedFixture> {
  const wash = process.env.WASH_PAYTO?.trim() || DEFAULT_WASH;
  const block = process.env.BLOCK_PAYTO?.trim() || DEFAULT_BLOCK;

  try {
    const res = await fetch(`${intel}/v1/intel/merchant_card/${wash}`);
    if (res.ok) {
      const card = (await res.json()) as { wash_flagged?: boolean };
      if (card.wash_flagged === true) return { seller: wash, basis: "wash_flagged" };
    }
  } catch {
    /* fall through to decision_block */
  }

  try {
    const res = await fetch(`${intel}/v1/intel/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seller_wallet: block,
        price_usdc: 0.05,
        agent_intent: "autogate_block_proof",
      }),
    });
    if (res.ok) {
      const j = (await res.json()) as { readiness_card?: { decision?: string } };
      if (j.readiness_card?.decision === "block")
        return { seller: block, basis: "decision_block" };
    }
  } catch {
    /* fall through to exit */
  }

  console.error(
    JSON.stringify({
      ok: false,
      error: "no_blocked_fixture",
      wash_candidate: wash,
      block_candidate: block,
      hint:
        "Set WASH_PAYTO to a merchant_card.wash_flagged=true wallet, or " +
        "BLOCK_PAYTO to a seller whose live preflight decision=block",
    }),
  );
  process.exit(2);
}
