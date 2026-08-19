/**
 * W2 — fee-payer preference in pickRequirements.
 * When a seller multi-lists facilitators in accepts[] (e.g. Dexter + TWZRD), the
 * gate SELECTS the entry whose extra.feePayer matches the preferred fee payer.
 * It must never add/rewrite/force an entry — only choose among what the seller
 * already offers, and fall through cleanly when nothing matches.
 * Run: npx tsx test/payto-prefer.test.ts
 */
import assert from "node:assert/strict";

import { pickRequirements, TWZRD_FEE_PAYER } from "../src/payto.js";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEXTER = "DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8";
const PAYAI = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

function entry(feePayer: string, network = SOLANA_MAINNET) {
  return {
    scheme: "exact",
    network,
    payTo: "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs",
    amount: "50000",
    extra: { feePayer, recentBlockhash: "BMVnWAL4YWSLu5TS2xWP6idT8MZEeEMU8XeLpRTgaXrL" },
  };
}

async function run() {
  // Multi-list [Dexter, PayAI, TWZRD]: explicit prefer TWZRD -> picks OUR entry
  // even though Dexter is first (Dexter would win the default network pref).
  {
    const accepts = [entry(DEXTER), entry(PAYAI), entry(TWZRD_FEE_PAYER)];
    const picked = pickRequirements(accepts, { preferFeePayer: TWZRD_FEE_PAYER });
    assert.equal((picked as any).extra.feePayer, TWZRD_FEE_PAYER, "prefer must select our entry");
  }

  // Env alias "twzrd" resolves to TWZRD_FEE_PAYER; applies with no explicit opts.
  {
    const prev = process.env.TWZRD_PREFER_FEE_PAYER;
    process.env.TWZRD_PREFER_FEE_PAYER = "twzrd";
    try {
      const accepts = [entry(DEXTER), entry(TWZRD_FEE_PAYER)];
      const picked = pickRequirements(accepts);
      assert.equal((picked as any).extra.feePayer, TWZRD_FEE_PAYER, "env alias twzrd must select our entry");
    } finally {
      if (prev === undefined) delete process.env.TWZRD_PREFER_FEE_PAYER;
      else process.env.TWZRD_PREFER_FEE_PAYER = prev;
    }
  }

  // Backward compat: NO preference -> existing behavior (first solana-mainnet,
  // i.e. Dexter when it is first). Preference must be strictly opt-in.
  {
    const prev = process.env.TWZRD_PREFER_FEE_PAYER;
    delete process.env.TWZRD_PREFER_FEE_PAYER;
    try {
      const accepts = [entry(DEXTER), entry(TWZRD_FEE_PAYER)];
      const picked = pickRequirements(accepts);
      assert.equal((picked as any).extra.feePayer, DEXTER, "no preference must keep prior behavior");
    } finally {
      if (prev !== undefined) process.env.TWZRD_PREFER_FEE_PAYER = prev;
    }
  }

  // No-force: prefer TWZRD but seller does NOT offer us -> must NOT invent our
  // entry; falls back to the network preference (the seller's Dexter entry).
  {
    const accepts = [entry(DEXTER), entry(PAYAI)];
    const picked = pickRequirements(accepts, { preferFeePayer: TWZRD_FEE_PAYER });
    assert.equal((picked as any).extra.feePayer, DEXTER, "must not force our entry when unoffered");
    assert.ok(
      accepts.some((e) => (e as any).extra.feePayer === (picked as any).extra.feePayer),
      "picked entry must be one the seller actually offered",
    );
  }

  // Preference only applies within Solana mainnet: a matching feePayer on a
  // non-mainnet entry is not preferred over the real mainnet entry.
  {
    const accepts = [
      entry(TWZRD_FEE_PAYER, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), // devnet
      entry(DEXTER, SOLANA_MAINNET),
    ];
    const picked = pickRequirements(accepts, { preferFeePayer: TWZRD_FEE_PAYER });
    assert.equal(picked.network, SOLANA_MAINNET, "must stay on mainnet, not chase a devnet feePayer match");
  }

  // Single entry -> returned regardless of preference.
  {
    const accepts = [entry(DEXTER)];
    const picked = pickRequirements(accepts, { preferFeePayer: TWZRD_FEE_PAYER });
    assert.equal((picked as any).extra.feePayer, DEXTER, "single entry returned as-is");
  }

  console.log("payto-prefer.test: all assertions passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
