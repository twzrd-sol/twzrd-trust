import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import {
  ANCHOR_MEMO_PREFIX,
  ANCHOR_HEAD_DISCRIMINATOR,
  ANCHOR_RPC_REPORTED_FACTS,
  EVIDENCE_LEDGER_PROGRAM_ID,
  MEMO_PROGRAM_IDS,
  parseAnchorMemo,
  parseAnchorHeadData,
  parseRawTransaction,
  formatAnchorMemo,
  anchorMatchesSth,
  fetchAnchorTransaction,
  verifyAnchor,
  verifyTransactionSignatures,
} from "../src/anchor.js";
import { STH_DOMAIN, signSth } from "../src/sth.js";
import { b58decode, b58encode, base64ToBytes, bytesToHex, concatBytes, hexToBytes, u64le } from "../src/util.js";
import { merkleRoot } from "../src/merkle.js";

const kp = nacl.sign.keyPair();
const pub = b58encode(kp.publicKey);
/** The anchor authority is a real keypair here: the verifier now checks its signature over the bytes. */
const authorityKp = nacl.sign.keyPair();
const AUTHORITY = b58encode(authorityKp.publicKey);
const otherKp = nacl.sign.keyPair();
const OTHER = b58encode(otherKp.publicKey);

const root = bytesToHex(merkleRoot([new Uint8Array(32)]));
const sth = signSth(
  {
    domain: STH_DOMAIN,
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 42,
    timestamp_unix: 1755072000,
    root,
  },
  kp.secretKey,
);
const memo = formatAnchorMemo({ log_id: "intel.twzrd.xyz/v6", tree_size: 42, root });

const MEMO_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LEDGER = "8EpPmDkQQ9uqMQH166kx7nu4wT415bobWcWfyiZDvgv3";
const ROOT_ENTRY = "CKzEZNiNcJLqvwoCoVATtqufedxi67DXosFr2R6caP7f";
const SYSTEM = "11111111111111111111111111111111";
const IX_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";

// --- a serializer for test transactions, written independently of the parser ---

function compactU16(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

interface TestIx {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

interface BuildOpts {
  /** Keypairs that sign, in order; their pubkeys are the first account keys. */
  signers?: nacl.SignKeyPair[];
  /** Extra account keys listed before the ones the instructions reference (to control index order). */
  extraKeys?: string[];
  instructions: TestIx[];
  /** Emit a versioned (v0) message with the given lookup-table section appended; default legacy. */
  v0?: { lookups: Uint8Array; forceIndex?: number; /** Message prefix byte; default 0x80 (version 0). */ prefix?: number };
  /** Replace signature i with zeros: the shape of a transaction the RPC made up. */
  zeroSignature?: number;
}

/** Serialize + sign a transaction the way the Solana runtime defines it (header, keys, blockhash, instructions). */
function buildTx(opts: BuildOpts): string {
  const signers = opts.signers ?? [authorityKp];
  const keys: string[] = signers.map((s) => b58encode(s.publicKey));
  for (const k of opts.extraKeys ?? []) if (!keys.includes(k)) keys.push(k);
  for (const ix of opts.instructions) {
    for (const k of [...ix.accounts, ix.programId]) if (!keys.includes(k)) keys.push(k);
  }
  const header = Uint8Array.of(signers.length, 0, keys.length - signers.length);
  const ixBytes = opts.instructions.map((ix) =>
    concatBytes(
      Uint8Array.of(keys.indexOf(ix.programId)),
      compactU16(ix.accounts.length),
      Uint8Array.from(ix.accounts.map((a) => (opts.v0?.forceIndex !== undefined ? opts.v0.forceIndex : keys.indexOf(a)))),
      compactU16(ix.data.length),
      ix.data,
    ),
  );
  const message = concatBytes(
    opts.v0 ? Uint8Array.of(opts.v0.prefix ?? 0x80) : new Uint8Array(0),
    header,
    compactU16(keys.length),
    ...keys.map((k) => b58decode(k)),
    new Uint8Array(32), // recent blockhash
    compactU16(ixBytes.length),
    ...ixBytes,
    opts.v0 ? opts.v0.lookups : new Uint8Array(0),
  );
  const sigs = signers.map((s, i) =>
    opts.zeroSignature === i ? new Uint8Array(64) : nacl.sign.detached(message, s.secretKey),
  );
  const raw = concatBytes(compactU16(sigs.length), ...sigs, message);
  return Buffer.from(raw).toString("base64");
}

function txSigOf(b64: string): string {
  return b58encode(new Uint8Array(Buffer.from(b64, "base64")).subarray(1, 65));
}

function rpcResult(b64: string, opts: { err?: unknown; meta?: null; slot?: number; blockTime?: number } = {}) {
  return {
    slot: opts.slot ?? 355000000,
    blockTime: opts.blockTime ?? 1755072100,
    meta: opts.meta === null ? null : { err: opts.err ?? null },
    transaction: [b64, "base64"],
    version: "legacy",
  };
}

function mockRpc(result: unknown) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  });
}

function memoIx(m: string): TestIx {
  return { programId: MEMO_V2, accounts: [], data: new TextEncoder().encode(m) };
}

/** The program's layout (programs/evidence-ledger, anchor.rs), built independently of the parser. */
function anchorHeadData(h: { log_id: string; tree_size: number; timestamp_unix: number; root: string }) {
  const lid = new TextEncoder().encode(h.log_id);
  return concatBytes(
    ANCHOR_HEAD_DISCRIMINATOR,
    u64le(h.tree_size),
    u64le(h.timestamp_unix),
    hexToBytes(h.root),
    Uint8Array.of(lid.length),
    lid,
  );
}

const precompileIx: TestIx = { programId: ED25519, accounts: [], data: new Uint8Array(16) };

/** A landed anchor: the precompile, then anchor_head, signed by the authority. */
function headTx(opts: { data?: Uint8Array; programId?: string; accounts?: string[]; signers?: nacl.SignKeyPair[] } = {}) {
  return buildTx({
    signers: opts.signers,
    extraKeys: [LEDGER, ROOT_ENTRY, SYSTEM, ED25519, IX_SYSVAR],
    instructions: [
      precompileIx,
      {
        programId: opts.programId ?? EVIDENCE_LEDGER_PROGRAM_ID,
        accounts: opts.accounts ?? [AUTHORITY, AUTHORITY, LEDGER, ROOT_ENTRY, SYSTEM, IX_SYSVAR],
        data: opts.data ?? anchorHeadData(sth),
      },
    ],
  });
}

function memoTx(opts: { memos?: string[]; signers?: nacl.SignKeyPair[] } = {}) {
  return buildTx({ signers: opts.signers, instructions: (opts.memos ?? [memo]).map(memoIx) });
}

function verifyWith(b64: string, result: unknown, extra: { ledger?: string; anchorProgramId?: string; txSignature?: string } = {}) {
  return verifyAnchor({
    sth,
    txSignature: extra.txSignature ?? txSigOf(b64),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(result),
    ledger: extra.ledger,
    anchorProgramId: extra.anchorProgramId,
  });
}
const verifyTx = (b64: string, extra: Parameters<typeof verifyWith>[2] = {}) => verifyWith(b64, rpcResult(b64), extra);

test("anchor memo round trip, including a log_id containing colons", () => {
  const p = parseAnchorMemo(memo);
  assert.ok(p);
  assert.equal(p.log_id, "intel.twzrd.xyz/v6");
  assert.equal(p.tree_size, 42);
  assert.equal(p.root, root.replace(/^0x/, ""));

  const weird = formatAnchorMemo({ log_id: "a:b:c/v1", tree_size: 7, root });
  const wp = parseAnchorMemo(weird);
  assert.ok(wp);
  assert.equal(wp.log_id, "a:b:c/v1");
  assert.equal(wp.tree_size, 7);
});

test("malformed memos parse to null", () => {
  assert.equal(parseAnchorMemo("hello"), null);
  assert.equal(parseAnchorMemo(ANCHOR_MEMO_PREFIX), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}log:notanumber:${"ab".repeat(32)}`), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}log:42:tooshort`), null);
  assert.equal(parseAnchorMemo(`${ANCHOR_MEMO_PREFIX}:42:${"ab".repeat(32)}`), null);
});

test("anchorMatchesSth flags every field mismatch", () => {
  const good = parseAnchorMemo(memo)!;
  assert.deepEqual(anchorMatchesSth(good, sth), []);
  assert.equal(anchorMatchesSth({ ...good, tree_size: 43 }, sth).length, 1);
  assert.equal(anchorMatchesSth({ ...good, log_id: "other" }, sth).length, 1);
  assert.equal(anchorMatchesSth({ ...good, root: "ab".repeat(32) }, sth).length, 1);
});

test("anchor_head discriminator is sha256('global:anchor_head')[0..8]", () => {
  const want = createHash("sha256").update("global:anchor_head").digest().subarray(0, 8);
  assert.equal(bytesToHex(ANCHOR_HEAD_DISCRIMINATOR), bytesToHex(want));
});

test("anchor_head data decodes the bytes the TWZRD anchor job builds", () => {
  // Built by the anchor job's Python builder (log_anchor_publisher.anchor_head_ix) for a
  // synthetic head: log_id intel.twzrd.xyz/v6, tree_size 42, timestamp 1755072000, root 00..1f.
  const fromPython = hexToBytes(
    "6dab203dc598eb712a0000000000000000469c6800000000000102030405060708090a0b0c0d0e0f" +
      "101112131415161718191a1b1c1d1e1f12696e74656c2e74777a72642e78797a2f7636",
  );
  const want = { log_id: "intel.twzrd.xyz/v6", tree_size: 42, timestamp_unix: 1755072000, root: bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)) };
  assert.deepEqual(parseAnchorHeadData(fromPython), want);
  assert.deepEqual(anchorHeadData(want), fromPython);
});

test("anchor_head data that is not exactly one head parses to null", () => {
  const good = anchorHeadData(sth);
  const at = (i: number, v: number) => Uint8Array.from(good, (b, j) => (j === i ? v : b));
  const u64max = concatBytes(good.subarray(0, 8), new Uint8Array(8).fill(0xff), good.subarray(16));
  assert.ok(parseAnchorHeadData(good));
  assert.equal(parseAnchorHeadData(at(0, good[0] ^ 1)), null); // another instruction
  assert.equal(parseAnchorHeadData(concatBytes(good, Uint8Array.of(0))), null); // trailing byte
  assert.equal(parseAnchorHeadData(good.subarray(0, good.length - 1)), null); // truncated log_id
  assert.equal(parseAnchorHeadData(at(56, 0)), null); // empty log_id
  assert.equal(parseAnchorHeadData(concatBytes(good.subarray(0, 8), u64le(0), good.subarray(16))), null); // size 0
  assert.equal(parseAnchorHeadData(u64max), null); // beyond Number.MAX_SAFE_INTEGER
  assert.equal(parseAnchorHeadData(at(57, 0xff)), null); // not UTF-8
  const long = anchorHeadData({ ...sth, log_id: "x".repeat(65) } as never);
  assert.equal(parseAnchorHeadData(long), null); // longer than the program accepts
});

// --- raw transaction parsing ------------------------------------------------

test("parseRawTransaction reads keys, instructions and signatures of a legacy message", () => {
  const b64 = headTx();
  const tx = parseRawTransaction(new Uint8Array(Buffer.from(b64, "base64")));
  assert.equal(tx.version, "legacy");
  assert.equal(tx.num_required_signatures, 1);
  assert.equal(tx.static_keys[0], AUTHORITY);
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[1].program_id, EVIDENCE_LEDGER_PROGRAM_ID);
  assert.deepEqual(tx.instructions[1].accounts, [AUTHORITY, AUTHORITY, LEDGER, ROOT_ENTRY, SYSTEM, IX_SYSVAR]);
  assert.deepEqual(parseAnchorHeadData(tx.instructions[1].data), {
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 42,
    timestamp_unix: 1755072000,
    root,
  });
  assert.deepEqual(verifyTransactionSignatures(tx), [AUTHORITY]);
});

test("parseRawTransaction: a v0 message with only static keys parses; a looked-up account is refused", () => {
  const ok = buildTx({ instructions: [memoIx(memo)], v0: { lookups: compactU16(0) } });
  const tx = parseRawTransaction(new Uint8Array(Buffer.from(ok, "base64")));
  assert.equal(tx.version, 0);
  assert.deepEqual(verifyTransactionSignatures(tx), [AUTHORITY]);

  const lookup = buildTx({ instructions: [{ ...memoIx(memo), accounts: [AUTHORITY] }], v0: { lookups: compactU16(0), forceIndex: 200 } });
  assert.throws(() => parseRawTransaction(new Uint8Array(Buffer.from(lookup, "base64"))), /address-table lookups/);
});

test("parseRawTransaction: truncated bytes throw instead of reading past the end", () => {
  const raw = new Uint8Array(Buffer.from(headTx(), "base64"));
  for (const cut of [0, 1, 30, 65, 70, 100, raw.length - 1]) {
    assert.throws(() => parseRawTransaction(raw.subarray(0, cut)), /truncated|compact/, `cut at ${cut}`);
  }
});

test("verifyTransactionSignatures rejects a signature that does not verify", () => {
  const forged = buildTx({ instructions: [memoIx(memo)], zeroSignature: 0 });
  const tx = parseRawTransaction(new Uint8Array(Buffer.from(forged, "base64")));
  assert.throws(() => verifyTransactionSignatures(tx), /does not verify/);
});

// --- verifyAnchor: memo form -------------------------------------------------

test("verifyAnchor: happy path (memo form) and the trust split", async () => {
  const b64 = memoTx();
  const res = await verifyTx(b64);
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.anchor_kind, "memo");
  assert.equal(res.slot, 355000000);
  assert.equal(res.block_time, 1755072100);
  assert.deepEqual(res.verified_locally.sort(), ["authority_signature", "head_binding", "sth_signature", "transaction_identity"]);
  assert.deepEqual(res.rpc_reported, [...ANCHOR_RPC_REPORTED_FACTS]);
  assert.equal(res.rpc_url, "https://api.mainnet-beta.solana.com");
});

test("verifyAnchor: authority not a signer fails", async () => {
  const res = await verifyTx(memoTx({ signers: [otherKp] }));
  assert.ok(!res.valid);
  assert.ok(!res.authority_signed);
  assert.match(res.errors.join(" "), /did not sign/);
  assert.ok(!res.verified_locally.includes("authority_signature"));
});

test("verifyAnchor: memo for a different head fails", async () => {
  const otherMemo = formatAnchorMemo({ log_id: "intel.twzrd.xyz/v6", tree_size: 41, root });
  const res = await verifyTx(memoTx({ memos: [otherMemo] }));
  assert.ok(!res.valid);
  assert.ok(!res.memo_found);
  assert.ok(res.authority_signed);
});

test("verifyAnchor: missing tx and RPC errors are reported, not thrown", async () => {
  const notFound = await verifyWith(memoTx(), null);
  assert.ok(!notFound.valid);
  assert.match(notFound.errors.join(" "), /not found/);
  assert.deepEqual(notFound.verified_locally, ["sth_signature"]);
  assert.deepEqual(notFound.rpc_reported, []);

  const httpErr = await verifyAnchor({
    sth,
    txSignature: "x".repeat(87),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.ok(!httpErr.valid);
  assert.match(httpErr.errors.join(" "), /HTTP 500/);

  const parsedOnly = await verifyWith(memoTx(), { slot: 1, blockTime: 1, meta: { err: null }, transaction: { message: {} } });
  assert.ok(!parsedOnly.valid);
  assert.match(parsedOnly.errors.join(" "), /base64/);
});

test("verifyAnchor: invalid STH signature fails even with a matching memo", async () => {
  const b64 = memoTx();
  const res = await verifyAnchor({
    sth: { ...sth, tree_size: 43 }, // breaks the signature; memo also mismatches
    txSignature: txSigOf(b64),
    sthPubkey: pub,
    anchorAuthority: AUTHORITY,
    fetchImpl: mockRpc(rpcResult(b64)),
  });
  assert.ok(!res.valid);
  assert.ok(!res.sth_valid);
});

// --- verifyAnchor: what the RPC cannot forge ----------------------------------

test("verifyAnchor: a fabricated transaction that lists the authority as signer without its signature is invalid", async () => {
  // The audit's F2 reproduction in the raw form: matching memo, authority in the signer slot,
  // meta.err null, slot 1, block time 1, but no signature the authority ever made.
  const forged = buildTx({ instructions: [memoIx(memo)], zeroSignature: 0 });
  const res = await verifyWith(forged, rpcResult(forged, { slot: 1, blockTime: 1 }));
  assert.ok(!res.valid);
  assert.ok(!res.authority_signed);
  assert.match(res.errors.join(" "), /does not verify/);
  assert.deepEqual(res.verified_locally, ["sth_signature"]);
  assert.equal(res.block_time, null);
});

test("verifyAnchor: a genuine transaction served under a different signature is not the requested anchor", async () => {
  const b64 = memoTx();
  const decoy = b58encode(new Uint8Array(64).fill(7)); // well-formed, so it reaches the identity check
  const res = await verifyWith(b64, rpcResult(b64), { txSignature: decoy });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), new RegExp(`not the requested ${decoy}`));
  assert.ok(!res.verified_locally.includes("transaction_identity"));
});

test("verifyAnchor: a transaction another key signed with the authority merely listed is invalid", async () => {
  // Signed by OTHER only; the authority appears as a non-signer account in the memo instruction's keys.
  const b64 = buildTx({ signers: [otherKp], extraKeys: [AUTHORITY], instructions: [memoIx(memo)] });
  const res = await verifyTx(b64);
  assert.ok(!res.valid && !res.authority_signed);
});

test("verifyAnchor: a looked-up account in a versioned message is an explicit error, not a verdict", async () => {
  const b64 = buildTx({ instructions: [{ ...memoIx(memo), accounts: [AUTHORITY] }], v0: { lookups: compactU16(0), forceIndex: 200 } });
  const res = await verifyTx(b64);
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /address-table lookups/);
});

// --- verifyAnchor: program form ------------------------------------------------

test("verifyAnchor: a landed anchor_head of the pinned program verifies", async () => {
  const res = await verifyTx(headTx(), { ledger: LEDGER });
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.anchor_kind, "anchor_head");
  assert.ok(res.anchor_head_found && res.tx_succeeded && res.authority_signed && !res.memo_found);
});

test("verifyAnchor: a failed anchor transaction anchors nothing", async () => {
  const b64 = headTx();
  const res = await verifyWith(b64, rpcResult(b64, { err: { InstructionError: [1, { Custom: 6 }] } }));
  assert.ok(!res.valid);
  assert.ok(!res.tx_succeeded && res.anchor_head_found && res.authority_signed);
  assert.match(res.errors.join(" "), /failed/);
  const noMeta = await verifyWith(b64, rpcResult(b64, { meta: null }));
  assert.ok(!noMeta.valid && !noMeta.tx_succeeded);
});

test("verifyAnchor: the same bytes from another program prove nothing", async () => {
  const res = await verifyTx(headTx({ programId: "11111111111111111111111111111112" }));
  assert.ok(!res.valid);
  assert.equal(res.anchor_kind, null);
  assert.match(res.errors.join(" "), /no anchor_head instruction of Bz/);
  const pinnedElsewhere = await verifyTx(headTx(), { anchorProgramId: "11111111111111111111111111111112" });
  assert.ok(!pinnedElsewhere.valid);
});

test("verifyAnchor: the authority must be the instruction's authority, not only a signer", async () => {
  const res = await verifyTx(
    headTx({ accounts: [OTHER, AUTHORITY, LEDGER, ROOT_ENTRY, SYSTEM, IX_SYSVAR], signers: [authorityKp, otherKp] }),
  );
  assert.ok(res.authority_signed);
  assert.ok(!res.valid && !res.anchor_head_found);
  assert.match(res.errors.join(" "), /anchor_head authority/);
});

test("verifyAnchor: a ledger pin rejects another ledger account", async () => {
  const res = await verifyTx(headTx(), { ledger: "11111111111111111111111111111112" });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /pinned ledger/);
});

test("verifyAnchor: an anchor_head for another head fails on every field", async () => {
  for (const changed of [
    { tree_size: 41 },
    { timestamp_unix: Number(sth.timestamp_unix) + 1 },
    { root: "ab".repeat(32) },
    { log_id: "intel.twzrd.xyz/v7" },
  ]) {
    const res = await verifyTx(headTx({ data: anchorHeadData({ ...sth, ...changed } as never) }));
    assert.ok(!res.valid, JSON.stringify(changed));
    assert.ok(!res.anchor_head_found);
  }
});

test("verifyAnchor: a memo anchor in a failed transaction no longer verifies", async () => {
  const b64 = memoTx();
  const res = await verifyWith(b64, rpcResult(b64, { err: { InstructionError: [0, "Custom"] } }));
  assert.ok(!res.valid);
  assert.ok(res.memo_found && !res.tx_succeeded);
  assert.equal(res.anchor_kind, "memo");
});

test("parseRawTransaction: a versioned message other than version 0 is refused even when the authority signed it", () => {
  const v1 = buildTx({ instructions: [memoIx(memo)], v0: { lookups: compactU16(0), prefix: 0x81 } });
  assert.throws(() => parseRawTransaction(base64ToBytes(v1)), /unsupported message version 1/);
  const v127 = buildTx({ instructions: [memoIx(memo)], v0: { lookups: compactU16(0), prefix: 0xff } });
  assert.throws(() => parseRawTransaction(base64ToBytes(v127)), /unsupported message version 127/);
});

test("verifyAnchor: a version-1 message is an error, not a verdict", async () => {
  const v1 = buildTx({ instructions: [memoIx(memo)], v0: { lookups: compactU16(0), prefix: 0x81 } });
  const res = await verifyTx(v1);
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /transaction: unsupported message version 1/);
  assert.deepEqual(res.rpc_reported, []);
});

test("verifyAnchor and fetchAnchorTransaction refuse a malformed --tx before calling the RPC", async () => {
  for (const bad of ["not-a-real-transaction", "", "0OIl", b58encode(new Uint8Array(32)), b58encode(new Uint8Array(65))]) {
    let calls = 0;
    const counting = async (...a: Parameters<ReturnType<typeof mockRpc>>) => {
      calls++;
      return mockRpc(rpcResult(memoTx()))(...a);
    };
    const res = await verifyAnchor({ sth, txSignature: bad, sthPubkey: pub, anchorAuthority: AUTHORITY, fetchImpl: counting });
    assert.ok(!res.valid, JSON.stringify(bad));
    assert.ok(res.sth_valid);
    assert.match(res.errors.join(" "), /transaction: txSignature is not a Solana transaction signature/);
    assert.deepEqual(res.rpc_reported, []);
    assert.equal(calls, 0, `fetchImpl called for ${JSON.stringify(bad)}`);
    await assert.rejects(fetchAnchorTransaction(bad, "https://rpc.example", counting), /not a Solana transaction signature/);
    assert.equal(calls, 0);
  }
  // A well-formed signature does reach the RPC.
  let calls = 0;
  const b64 = memoTx();
  const counting = async (...a: Parameters<ReturnType<typeof mockRpc>>) => {
    calls++;
    return mockRpc(rpcResult(b64))(...a);
  };
  const ok = await verifyAnchor({ sth, txSignature: txSigOf(b64), sthPubkey: pub, anchorAuthority: AUTHORITY, fetchImpl: counting });
  assert.ok(ok.valid);
  assert.equal(calls, 1);
});

test("base64ToBytes matches Node's decoder and refuses garbage", () => {
  const b64 = headTx();
  assert.deepEqual(base64ToBytes(b64), new Uint8Array(Buffer.from(b64, "base64")));
  assert.throws(() => base64ToBytes("not base64!"), /invalid base64/);
});

// --- golden vector: the live log's mainnet anchor for tree_size 2 ---------------

/**
 * getTransaction(base64) for 3k3vDAqn...i8u, the mainnet anchor of tree_size 2
 * (GET /v1/log/anchors, cluster mainnet), fetched 2026-10-30 from
 * api.mainnet-beta.solana.com. The signed head is reconstructed from the
 * transaction's own ed25519 precompile instruction, which carries the STH
 * preimage and signature; it verifies under the published issuer key.
 */
const LIVE_ANCHOR = {
  tx_signature: "3k3vDAqnPsdxTYaAzrG6wpLrwQcpQJivAGo2BdvBMsRgNjr2opbvMULSYvbtrypcyTWDApSmN4HGqaAFYiUii8u",
  authority: "4hFrTSfugb8cHJ5EXmciAECG2EKo6FzKUzoHczQbrNqC",
  ledger: "8EpPmDkQQ9uqMQH166kx7nu4wT415bobWcWfyiZDvgv3",
  sth_pubkey: "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
  slot: 444957113,
  block_time: 1788749816,
  base64:
    "AQJdZCUIofmyYoALg4zvVfuQeoxnyeEbh6pxdiMEkTc3ARPRz6XWORJunIU5NldekltZ/lK4FNtng7Fg4dnRlAYBAAQHNuMWTiZyTI7nU9pEa3l6v0/QfHbgj9truhNI7xtwGcdri/IhbSBiDiexRHUngrSsOvzPNZu9qpcJZsmowYgfyNxTGOk+EwbCVSdoIygZKAFHUy1/Am9A3up1N9sYY7RBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADfUbWfJP7vhL5Qo+DjUD/BXB0SSf0imT8ynBEgAAAAAan1RcYe9FmNdrUBFX9wsDBJMaPIVZ1pdu6y18IAAAAozp36LVe8Kr+u0htJi4WQp+js0Mh32OGPvGQFiYBL5dbmEs3SUHqqf/qSu3euAV7ENMGkTpoMmxLLQ4431woRgIEAMwBAQAwAP//EAD//3AAXAD//5DCLORau8PDUy2TQTOLcd22+o4phnnG7Nbmlupyuo3f5Bh0geaA+exZygN3xQS42J27fMlBcFWZwEl3FivgRYcX8PBVXH1oghkoMYldAqWwkpd7NZr/I6x1UZdgQ7f6DVRXWlJEOlJFQ0VJUFRfTE9HX1NUSF9WMRIAaW50ZWwudHd6cmQueHl6L3Y2AgAAAAAAAAArKZxqAAAAADRQqp+P5I+Hp8hw+eCEnIcUbIIJXihU7R2syMDyZPJhBgYAAAECAwVLbasgPcWY63ECAAAAAAAAACspnGoAAAAANFCqn4/kj4enyHD54ISchxRsggleKFTtHazIwPJk8mESaW50ZWwudHd6cmQueHl6L3Y2",
  sth: {
    domain: "TWZRD:RECEIPT_LOG_STH_V1",
    log_id: "intel.twzrd.xyz/v6",
    tree_size: 2,
    timestamp_unix: 1788619051,
    root: "0x3450aa9f8fe48f87a7c870f9e0849c87146c82095e2854ed1dacc8c0f264f261",
    signature: "5ZW3zjo13zftCmrubh4a9dQfH1g9GCxoTyZgUeMkGfsP6ZZvRnAurSRJ4Y3FatzGMcyPLWdWxQHhdMKp1vRCuVPJ",
    signing_pubkey: "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS",
  },
};

test("golden: the live mainnet anchor for tree_size 2 verifies from its bytes", async () => {
  const result = { slot: LIVE_ANCHOR.slot, blockTime: LIVE_ANCHOR.block_time, meta: { err: null }, transaction: [LIVE_ANCHOR.base64, "base64"], version: "legacy" };
  assert.deepEqual(base64ToBytes(LIVE_ANCHOR.base64), new Uint8Array(Buffer.from(LIVE_ANCHOR.base64, "base64")));
  const fetched = await fetchAnchorTransaction(LIVE_ANCHOR.tx_signature, "https://rpc.example", mockRpc(result));
  assert.deepEqual(fetched.signers, [LIVE_ANCHOR.authority]);
  assert.equal(fetched.version, "legacy");
  assert.equal(fetched.anchorHeads.length, 1);
  assert.equal(fetched.anchorHeads[0].program_id, EVIDENCE_LEDGER_PROGRAM_ID);
  assert.equal(fetched.anchorHeads[0].accounts[0], LIVE_ANCHOR.authority);
  assert.equal(fetched.anchorHeads[0].accounts[2], LIVE_ANCHOR.ledger);
  assert.deepEqual(fetched.memos, []);

  const res = await verifyAnchor({
    sth: LIVE_ANCHOR.sth,
    txSignature: LIVE_ANCHOR.tx_signature,
    sthPubkey: LIVE_ANCHOR.sth_pubkey,
    anchorAuthority: LIVE_ANCHOR.authority,
    ledger: LIVE_ANCHOR.ledger,
    rpcUrl: "https://rpc.example",
    fetchImpl: mockRpc(result),
  });
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.equal(res.anchor_kind, "anchor_head");
  assert.equal(res.rpc_url, "https://rpc.example");

  // The same bytes under another requested signature are not this anchor.
  const swapped = await verifyAnchor({ ...{ sth: LIVE_ANCHOR.sth, sthPubkey: LIVE_ANCHOR.sth_pubkey, anchorAuthority: LIVE_ANCHOR.authority }, txSignature: b58encode(new Uint8Array(64).fill(7)), fetchImpl: mockRpc(result) });
  assert.ok(!swapped.valid);
  assert.match(swapped.errors.join(" "), /not the requested/);

  // One flipped byte in the message breaks the authority's signature.
  const raw = Buffer.from(LIVE_ANCHOR.base64, "base64");
  raw[raw.length - 1] ^= 1;
  const tampered = await verifyAnchor({ sth: LIVE_ANCHOR.sth, txSignature: LIVE_ANCHOR.tx_signature, sthPubkey: LIVE_ANCHOR.sth_pubkey, anchorAuthority: LIVE_ANCHOR.authority, fetchImpl: mockRpc({ ...result, transaction: [raw.toString("base64"), "base64"] }) });
  assert.ok(!tampered.valid);
  assert.match(tampered.errors.join(" "), /does not verify/);
});

test("MEMO_PROGRAM_IDS covers the memo program the tests build with", () => {
  assert.ok(MEMO_PROGRAM_IDS.has(MEMO_V2));
});
