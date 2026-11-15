// The buying agent: twzrd.safeFetch on one rail, with a spend cap, the seller
// check, and a demo signer that counts its own calls.
import { join } from "node:path";

import { twzrd } from "twzrd-x402-gate";

/** Per-call cap and cumulative budget, in USDC. */
export const MAX_SPEND = "0.10";
export const AGENT_ID = "showcase-agent";

export function createAgent({ rail, dataDir, sellerOrigin, sellerCheck, ledger }) {
  // The agent talks to the loopback seller and nothing else.
  const fetchSeller = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== sellerOrigin) {
      return Promise.reject(new Error(`refused ${url.origin}: this agent only talks to ${sellerOrigin}`));
    }
    return fetch(url, init);
  };

  // The demo signer. A real one signs `selected`, the one offer the gate
  // approved, with the agent's key. This one holds no key and builds no
  // transaction: it sends a demo PAYMENT-SIGNATURE naming that offer, so the
  // seller can count a paid request, and it counts its own calls so the
  // gate's signerInvocations can be checked against it.
  const signer = { calls: 0 };
  const pay = async ({ url, selected }) => {
    signer.calls += 1;
    const payment = { x402Version: 2, accepted: selected, payload: { demo: true } };
    const response = await fetchSeller(url, {
      headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payment)).toString("base64") },
    });
    return { response };
  };

  const buy = (url) =>
    twzrd.safeFetch(url, {
      maxSpend: MAX_SPEND,
      allowNetworks: rail.allowNetworks,
      agentId: AGENT_ID,
      ledger,
      fetch: fetchSeller,
      preflight: sellerCheck.check,
      pay,
      // Sentinel files live in this example's data dir only. Explicit paths
      // win over TWZRD_STATE_DIR, KILLSWITCH_KILL_FILE and
      // KILLSWITCH_PAUSE_FILE, so a run never reads or writes another
      // agent's kill file.
      stateDir: dataDir,
      killFilePath: join(dataDir, ".kill"),
      pauseFilePath: join(dataDir, ".pause"),
      // A fatal refusal writes no .pause (0 wins over
      // TWZRD_TRIP_PAUSE_ON_BLOCK_MS), and no write-ahead log file is opened
      // (TWZRD_SVM_WAL_FILE in the environment would otherwise add one). A
      // cumulative-budget trip would still write .pause in the data dir; the
      // acts spend 0.04 of the 0.10 budget, so none happens.
      tripPauseOnBlockMs: 0,
      svmWalFile: "",
    });

  return { rail, signer, buy };
}
