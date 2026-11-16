// The buying agents, one per seat and rail. All buy from the loopback seller
// through the published gate, and all report each purchase as the same
// decision record (lib/guarded-fetch.mjs describes its fields).
//
//   safe-fetch   twzrd.safeFetch with a spend cap, the recorded seller check
//                and a demo signer that counts its own calls.
//   x402-fetch   the gate's createGuardedX402Fetch on an @x402/fetch client,
//                through createGuardedX402FetchWithEvents, with a demo "exact"
//                scheme that counts its own calls.
//   x402-solana  the stock x402-solana client through
//                createGuardedX402SolanaFetch, Solana only. The client builds
//                a real USDC transfer from the loopback RPC stub's answers
//                and hands it to a demo wallet that holds no key: the wallet
//                reads the transfer, counts the call and signs nothing.
//                Opt-in: its packages are not in the lockfile, and
//                npm run setup:x402-solana installs them (loadX402Solana).
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { x402Client } from "@x402/fetch";
import { twzrd } from "twzrd-x402-gate";

import {
  createGuardedX402FetchWithEvents,
  createGuardedX402SolanaFetch,
  describeOffer,
  isHaltReason,
  roundMs,
  verifyReceipt,
} from "./guarded-fetch.mjs";
import { RAIL_IDS } from "./rails.mjs";

/** Per-call cap and budget, in USDC. */
export const MAX_SPEND = "0.10";
export const AGENT_ID = "showcase-agent";
export const SEATS = Object.freeze(["safe-fetch", "x402-fetch", "x402-solana"]);
/** The rails each seat buys on. x402-solana is a Solana client. */
export const SEAT_RAILS = Object.freeze({
  "safe-fetch": RAIL_IDS,
  "x402-fetch": RAIL_IDS,
  "x402-solana": Object.freeze(["solana"]),
});
/** Demo instrumentation: each agent names itself so the seller can count per agent. A real agent sends no such header. */
export const AGENT_HEADER = "x-showcase-agent";

/** The packages the x402-solana seat needs. They are not in the lockfile. */
export const X402_SOLANA_PACKAGES = Object.freeze(["x402-solana", "@solana/web3.js", "@solana/spl-token"]);
/** Installs them at pinned versions without changing package.json or package-lock.json. */
export const X402_SOLANA_SETUP = "npm run setup:x402-solana";
/** The SPL Token program, whose TransferChecked instruction readTransfer reads. */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * This example's own node_modules. The x402-solana seat loads only from here:
 * a copy in a parent directory (in this repository, the root's) is ignored,
 * so the seat runs on what the setup installed or not at all.
 */
const OWN_MODULES = (() => {
  const dir = fileURLToPath(new URL("../node_modules", import.meta.url));
  return (existsSync(dir) ? realpathSync(dir) : dir) + sep;
})();

/** True when `specifier` resolves inside OWN_MODULES. Any resolution error but a missing package is thrown. */
function installedHere(specifier) {
  let url;
  try {
    url = import.meta.resolve(specifier);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return false;
    throw error;
  }
  return fileURLToPath(url).startsWith(OWN_MODULES);
}

/**
 * The x402-solana seat, if its packages are installed in this example:
 * { available: true, createX402Client } with the stock client's factory, or
 * { available: false, missing } naming the packages that are not.
 */
export async function loadX402Solana() {
  const missing = X402_SOLANA_PACKAGES.filter((name) => !installedHere(name === "x402-solana" ? "x402-solana/client" : name));
  if (missing.length > 0) return { available: false, missing };
  const { createX402Client } = await import("x402-solana/client");
  return { available: true, createX402Client };
}

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

  return { seat, rail, tag, signer, events, buy: buyer(pay, events) };
}

/** A buy() for a guarded fetch that reports through events: the call's one decision record, and the paid body. */
function buyer(pay, events) {
  return async function buy(url) {
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
  };
}

/**
 * The token transfer in a transaction x402-solana built: its one SPL
 * TransferChecked (instruction 12: amount u64 and decimals u8; accounts
 * source, mint, destination, owner), the fee payer and the blockhash.
 * `transfers` counts the TransferChecked instructions found.
 */
export function readTransfer(transaction) {
  const message = transaction?.message;
  const keys = (message?.staticAccountKeys ?? []).map((key) => key.toBase58());
  const found = (message?.compiledInstructions ?? []).filter(
    (ix) => keys[ix.programIdIndex] === TOKEN_PROGRAM && ix.data.length === 10 && ix.data[0] === 12,
  );
  const base = { transfers: found.length, feePayer: keys[0] ?? null, blockhash: message?.recentBlockhash ?? null };
  if (found.length !== 1) return base;
  const data = Buffer.from(found[0].data);
  const [source, mint, destination, owner] = found[0].accountKeyIndexes.map((i) => keys[i] ?? null);
  return { ...base, source, mint, destination, owner, amount: data.readBigUInt64LE(1).toString(), decimals: data[9] };
}

/**
 * A demo Solana wallet at `address`, in the place a wallet adapter or keypair
 * signer takes. It holds no key: signTransaction records the transfer it was
 * handed (readTransfer), counts the call, and returns the transaction as it
 * came, unsigned.
 */
export function createDemoSolanaWallet(address) {
  const signer = { calls: 0, transfers: [] };
  const wallet = {
    address,
    async signTransaction(transaction) {
      signer.calls += 1;
      signer.transfers.push(readTransfer(transaction));
      return transaction;
    },
  };
  return { wallet, signer };
}

/** `createX402Client` is x402-solana's own factory, from loadX402Solana. */
export function createX402SolanaAgent({ rail, dataDir, sellerOrigin, rpcUrl, createX402Client }) {
  const seat = "x402-solana";
  const tag = `${seat}/${rail.id}`;
  const { wallet, signer } = createDemoSolanaWallet(rail.buyer);

  const events = newEvents();
  const pay = createGuardedX402SolanaFetch({
    createX402Client,
    wallet,
    network: "solana",
    // The loopback RPC stub (lib/solana-rpc.mjs): x402-solana reads the mint,
    // both token accounts and a blockhash from it.
    rpcUrl,
    customFetch: sellerTransport(sellerOrigin, tag),
    maxPricePerCall: MAX_SPEND,
    hourlyBudgetCap: MAX_SPEND,
    allowedRecipients: [rail.sellers.good],
    // As on the x402-fetch seat: the TWZRD evaluator is off in this offline
    // run, and .kill and .pause stay on.
    twzrd: { disabled: true, ...sentinelFiles(dataDir) },
    receipt: true,
    onDecision: (record) => events.decisions.push(record),
    onKill: (record) => events.kills.push(record),
    onReceiptVerified: (event) => events.receipts.push(event),
  });

  return { seat, rail, tag, signer, events, buy: buyer(pay, events) };
}
