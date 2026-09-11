const API = "https://intel.twzrd.xyz";

export async function twzrdPreflight(merchant, { fetchImpl = fetch, offline = false } = {}) {
  if (offline) return {
    decision: merchant.expected === "block" ? "block" : "allow",
    trust_score: merchant.expected === "block" ? 5 : 85,
    preflight_id: `offline:${merchant.id}`,
    source: "deterministic_twzrd_fixture"
  };
  const response = await fetchImpl(`${process.env.TWZRD_INTEL_URL ?? API}/v1/intel/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seller_wallet: merchant.seller, resource_url: merchant.resource, resource_name: merchant.name, price_usdc: 0.01, agent_intent: "agent_commerce_example" })
  });
  if (!response.ok) throw new Error(`TWZRD preflight HTTP ${response.status}`);
  const body = await response.json();
  const card = body.readiness_card ?? body.card ?? body;
  if (merchant.expected === "block" && card.decision !== "block") throw new Error(`unsafe fixture drifted to ${card.decision}; refusing to demonstrate a false block`);
  return { decision: card.decision, can_spend: card.can_spend, trust_score: card.trust_score, preflight_id: String(body.preflight_id ?? card.preflight_id ?? "unavailable"), source: "twzrd_live" };
}
