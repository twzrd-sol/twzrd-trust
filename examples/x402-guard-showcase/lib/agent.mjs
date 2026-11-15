// The buying agents, one per seat and rail. Both buy from the loopback seller
// through the published gate, and both report each purchase as the same
// decision record (lib/guarded-fetch.mjs describes its fields).
//
//   safe-fetch  twzrd.safeFetch with a spend cap, the recorded seller check
//               and a demo signer that counts its own calls.
//   x402-fetch  the gate's createGuardedX402Fetch on an @x402/fetch client,
//               through createGuardedX402FetchWithEvents, with a demo "exact"
//               scheme that counts its own calls.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { x402Client } from "@x402/fetch";
import { twzrd } from "twzrd-x402-gate";

import { createGuardedX402FetchWithEvents, describeOffer, isHaltReason, roundMs, verifyReceipt } from "./guarded-fetch.mjs";

/** Per-call cap and budget, in USDC. */
export const MAX_SPEND = "0.10";
export const AGENT_ID = "showcase-agent";
export const SEATS = Object.freeze(["safe-fetch", "x402-fetch"]);
/** Demo instrumentation: each agent names itself so the seller can count per agent. A real agent sends no such header. */
export const AGENT_HEADER = "x-showcase-agent";

const sentinelFiles = (dataDir) => ({
  // Sentinel files live in this example's data dir only. Explicit paths win
  // over TWZRD_STATE_DIR, KILLSWITCH_KILL_FILE and KILLSWITCH_PAUSE_FILE, so a
  // run never reads or writes another agent's kill file.
  stateDir: dataDir,
  killFilePath: join(dataDir, ".kill"),
  pauseFilePath: join(dataDir, ".pause"),
});

/** A fetch that reaches the loopback seller and nothing else, and tags each request with the agent's name. */
function sellerTransport(sellerOrigin, tag, onResponse) {
  return async (input, init) => {
    const request = new Request(input, init);
    const { origin } = new URL(request.url);
    if (origin !== sellerOrigin) throw new Error(`refused ${origin}: this agent only talks to ${sellerOrigin}`);
    request.headers.set(AGENT_HEADER, tag);
    const response = await fetch(request);
    onResponse?.(response);
    return response;
  };
}

/** The offer on `network` in a 402's PAYMENT-REQUIRED header, or null. Reads headers only. */
function offerIn402(response, network) {
  try {
    const required = JSON.parse(Buffer.from(response.headers.get("payment-required") ?? "", "base64").toString("utf8"));
    return required.accepts.find((offer) => offer.network === network) ?? null;
  } catch {
    return null;
  }
}

const newEvents = () => ({ decisions: [], kills: [], receipts: [] });

export function createSafeFetchAgent({ rail, dataDir, sellerOrigin, sellerCheck, ledger }) {
  const seat = "safe-fetch";
  const tag = `${seat}/${rail.id}`;
  const calls = new AsyncLocalStorage();
  const fetchSeller = sellerTransport(sellerOrigin, tag, (response) => {
    const call = calls.getStore();
    if (call && response.status === 402) call.offer = offerIn402(response, rail.network);
  });

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

  const events = newEvents();
  async function buy(url) {
    const call = { offer: null };
    return calls.run(call, async () => {
      const started = performance.now();
      const result = await twzrd.safeFetch(url, {
        maxSpend: MAX_SPEND,
        allowNetworks: rail.allowNetworks,
        agentId: AGENT_ID,
        ledger,
        fetch: fetchSeller,
        preflight: sellerCheck.check,
        pay,
        ...sentinelFiles(dataDir),
        // A fatal refusal writes no .pause (0 wins over
        // TWZRD_TRIP_PAUSE_ON_BLOCK_MS), and no write-ahead log file is opened
        // (TWZRD_SVM_WAL_FILE in the environment would otherwise add one). A
        // cumulative-budget trip would still write .pause in the data dir; the
        // acts spend at most 0.06 of the 0.10 budget, so none happens.
        tripPauseOnBlockMs: 0,
        svmWalFile: "",
      });
      const ok = result.verdict !== "block" && result.response?.ok === true;
      const body = ok ? await result.response.json().catch(() => null) : null;
      // After safeFetch returns: check a receipt in the paid body, by hand.
      const receiptVerified =
        body?.twzrd_receipt !== undefined
          ? verifyReceipt(body.twzrd_receipt, { onReceiptVerified: (e) => events.receipts.push(e) }).valid
          : null;
      // The stage is read off the run: a refusal before any 402 came back was made on entry.
      const stage =
        result.verdict === "block" ? (call.offer ? "pre_sign" : "entry") : result.signerInvocations > 0 ? "pre_sign" : null;
      const record = {
        ...describeOffer(call.offer),
        decision: result.verdict,
        reason: result.reason ?? null,
        stage,
        signerInvocations: result.signerInvocations,
        status: result.response?.status ?? null,
        receiptVerified,
        elapsedMs: roundMs(performance.now() - started),
      };
      events.decisions.push(record);
      if (record.decision === "block" && isHaltReason(record.reason)) events.kills.push(record);
      return { record, body };
    });
  }

  return { seat, rail, tag, signer, events, buy };
}

export function createX402Agent({ rail, dataDir, sellerOrigin }) {
  const seat = "x402-fetch";
  const tag = `${seat}/${rail.id}`;

  // The demo scheme, in the place @x402/evm (Base) or @x402/svm (Solana) takes
  // in a real client. It holds no key and builds no transaction; it counts
  // its own calls so signerInvocations can be checked against it.
  const signer = { calls: 0 };
  const scheme = {
    scheme: "exact",
    async createPaymentPayload(x402Version) {
      signer.calls += 1;
      return { x402Version, payload: { demo: true } };
    },
  };
  // One rail per client, so the client pays only that rail's offer. Core's own
  // spend controls (recognized assets, 1 USD per payment) are off so the
  // gate's checks are the ones that refuse here.
  const client = x402Client.fromConfig({ schemes: [{ network: rail.network, client: scheme }], spendControls: false });

  const events = newEvents();
  const pay = createGuardedX402FetchWithEvents({
    client,
    fetch: sellerTransport(sellerOrigin, tag),
    maxPricePerCall: MAX_SPEND,
    hourlyBudgetCap: MAX_SPEND,
    allowedRecipients: [rail.sellers.good],
    // The TWZRD evaluator calls TWZRD's live preflight, so this offline run
    // switches it off. .kill and .pause stay on: the gate reads them with the
    // evaluator on or off.
    twzrd: { disabled: true, ...sentinelFiles(dataDir) },
    receipt: true,
    onDecision: (record) => events.decisions.push(record),
    onKill: (record) => events.kills.push(record),
    onReceiptVerified: (event) => events.receipts.push(event),
  });

  async function buy(url) {
    const before = events.decisions.length;
    let response = null;
    try {
      response = await pay(url);
    } catch {
      // A refusal throws; the decision record says why.
    }
    const emitted = events.decisions.length - before;
    const record = events.decisions[before] ?? { ...describeOffer(null), decision: "error", reason: "no decision record" };
    const body = response?.ok ? await response.json().catch(() => null) : null;
    return { record, body, emitted };
  }

  return { seat, rail, tag, signer, events, buy };
}
