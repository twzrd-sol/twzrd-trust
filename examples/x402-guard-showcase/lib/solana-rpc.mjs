// A loopback Solana JSON-RPC stub for the x402-solana seat.
//
// The stock x402-solana client reads the chain after its beforePayment hook
// approves and before it asks the wallet to sign: the token mint (twice: its
// owner program, then its decimals), the buyer's and the seller's token
// accounts, and a recent blockhash. This stub answers exactly those reads from
// fixed demo data:
//
//   getAccountInfo      the mint: a USDC mint (6 decimals, token program);
//                       each holder's associated token account for that mint;
//                       null for any other account
//   getLatestBlockhash  one fixed demo blockhash
//
// Any other method gets a JSON-RPC "method not found" error. It listens on
// 127.0.0.1 only, sends nothing anywhere, holds no key, and counts the calls it
// answered.
import http from "node:http";

import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { demoKey } from "./rails.mjs";

/** The blockhash every getLatestBlockhash returns: demoKey("blockhash/solana"). */
export const DEMO_BLOCKHASH = demoKey("blockhash/solana");
const SLOT = 300_000_000;
// Rent-exempt minimums for an 82-byte mint and a 165-byte token account.
const MINT_LAMPORTS = 1_461_600;
const ACCOUNT_LAMPORTS = 2_039_280;

/** An initialized SPL mint with no authorities: the token program's 82-byte layout. */
function mintData(decimals) {
  const data = Buffer.alloc(MINT_SIZE);
  // 0: mint authority option (none), 4: authority, 36: supply (0)
  data[44] = decimals;
  data[45] = 1; // is_initialized
  // 46: freeze authority option (none), 50: authority
  return data;
}

/** An initialized SPL token account: the token program's 165-byte layout. */
function tokenAccountData(mint, owner, amount) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  // 72: delegate option (none), 76: delegate
  data[108] = 1; // state: initialized
  // 109: is_native option (none), 121: delegated amount, 129: close authority option (none)
  return data;
}

/** The associated token account of `owner` for `mint`, as x402-solana derives it. */
export function tokenAccountOf(owner, mint) {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_PROGRAM_ID).toBase58();
}

/**
 * Start the stub. `mint` is the token's mint address; each of `holders` gets a
 * token account for it holding `balance` base units.
 */
export async function startSolanaRpc({ mint, holders, decimals = 6, balance = 1_000_000_000n }) {
  const accounts = new Map([[mint, { owner: TOKEN_PROGRAM_ID.toBase58(), lamports: MINT_LAMPORTS, data: mintData(decimals) }]]);
  for (const holder of holders) {
    accounts.set(tokenAccountOf(holder, mint), {
      owner: TOKEN_PROGRAM_ID.toBase58(),
      lamports: ACCOUNT_LAMPORTS,
      data: tokenAccountData(mint, holder, balance),
    });
  }
  const calls = { getAccountInfo: 0, getLatestBlockhash: 0, other: 0, accountsRead: [] };
  // Holds not yet met by a request, and every hold not yet released.
  const holds = [];
  const unreleased = new Set();

  const answer = async (request) => {
    const { id = null, method, params } = request ?? {};
    const ok = (value) => ({ jsonrpc: "2.0", id, result: { context: { slot: SLOT }, value } });
    if (method === "getAccountInfo") {
      calls.getAccountInfo += 1;
      const address = String(Array.isArray(params) ? params[0] : "");
      calls.accountsRead.push(address);
      const account = accounts.get(address);
      if (!account) return ok(null);
      return ok({
        data: [account.data.toString("base64"), "base64"],
        executable: false,
        lamports: account.lamports,
        owner: account.owner,
        rentEpoch: 0,
        space: account.data.length,
      });
    }
    if (method === "getLatestBlockhash") {
      calls.getLatestBlockhash += 1;
      const hold = holds.shift();
      if (hold) {
        hold.arrived();
        await hold.released;
      }
      return ok({ blockhash: DEMO_BLOCKHASH, lastValidBlockHeight: SLOT + 150 });
    }
    calls.other += 1;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method).slice(0, 64)}` } };
  };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}');
      return;
    }
    const reply = Array.isArray(request) ? await Promise.all(request.map(answer)) : await answer(request);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls: () => structuredClone(calls),
    /**
     * Hold the next getLatestBlockhash until release(): the client has its
     * hook's approval and is building the transaction, and the wallet has not
     * been asked to sign. `reached` settles once that request is waiting.
     */
    holdNextBlockhash() {
      let resolveReleased;
      const released = new Promise((resolve) => {
        resolveReleased = resolve;
      });
      let arrived;
      const reached = new Promise((resolve) => {
        arrived = resolve;
      });
      const hold = { released, arrived };
      const release = () => {
        const i = holds.indexOf(hold);
        if (i >= 0) holds.splice(i, 1);
        unreleased.delete(release);
        resolveReleased();
      };
      holds.push(hold);
      unreleased.add(release);
      return { reached, release };
    },
    close: () =>
      new Promise((resolve) => {
        // Release every hold, so no request handler is left waiting.
        for (const release of [...unreleased]) release();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
