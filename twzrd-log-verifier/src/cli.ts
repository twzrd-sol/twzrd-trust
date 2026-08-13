#!/usr/bin/env node
/*
 * twzrd-log-verifier CLI — offline verification of the TWZRD Receipt
 * Transparency log. Exit code 0 = VALID, 1 = INVALID / error.
 *
 *   twzrd-log-verifier inclusion --receipt receipt.json --proof proof.json [--sth sth.json] [--pubkey KEY]
 *   twzrd-log-verifier inclusion --leaf <hex32> --proof proof.json [--sth sth.json] [--pubkey KEY]
 *   twzrd-log-verifier consistency --old old-sth.json --new new-sth.json --proof proof.json [--pubkey KEY]
 *   twzrd-log-verifier anchor --sth sth.json --tx <signature> --authority <b58> [--rpc URL] [--pubkey KEY]
 *   twzrd-log-verifier equivocation --a a-sth.json --b b-sth.json [--proof proof.json] [--pubkey KEY]
 *   twzrd-log-verifier selftest
 */
import fs from "node:fs";
import nacl from "tweetnacl";
import {
  assertHashBackend,
  merkleRoot,
  inclusionProof,
  consistencyProof,
  verifyInclusion,
  verifyConsistency,
} from "./merkle.js";
import { signSth, verifySth, STH_DOMAIN, type SignedTreeHead } from "./sth.js";
import { verifyAnchor } from "./anchor.js";
import { checkEquivocation } from "./equivocation.js";
import { bytesToHex, hexToBytes } from "./util.js";
import { DEFAULT_STH_PUBKEY } from "./index.js";

const HELP = `twzrd-log-verifier — offline verifier for the TWZRD Receipt Transparency log

Spec: docs/transparency-log.md (twzrd-sol/twzrd-trust). Verifies, with no trust
in TWZRD's servers or code: inclusion proofs, consistency proofs, Solana
anchors, and equivocation (contradictory signed tree heads).

commands:
  inclusion    --receipt FILE | --leaf HEX32, --proof FILE, [--sth FILE] [--pubkey KEY]
  consistency  --old FILE --new FILE --proof FILE [--pubkey KEY]
  anchor       --sth FILE --tx SIGNATURE --authority KEY [--rpc URL] [--pubkey KEY]
  equivocation --a FILE --b FILE [--proof FILE] [--pubkey KEY]
  selftest     build an in-memory log with a throwaway key; every check must
               pass and every tampered variant must fail

common flags:
  --pubkey KEY   pinned STH signing key (default: built-in ${DEFAULT_STH_PUBKEY.slice(0, 8)}…)

file shapes:
  proof (inclusion):   { "leaf_index": n, "tree_size": n, "audit_path": ["0x…", …], "sth"?: {…} }
  proof (consistency): { "path": ["0x…", …] }  or a bare JSON array
  sth:                 { "domain", "log_id", "tree_size", "timestamp_unix", "root", "signature", "signing_pubkey"? }

exit code: 0 = VALID, 1 = INVALID / error`;

function readJson(path: string): unknown {
  const raw = path === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Accept a bare receipt or an API response nesting it under twzrd_receipt. */
function extractLeafHex(receiptDoc: unknown): string {
  let doc = receiptDoc as Record<string, unknown>;
  if (doc && typeof doc === "object" && !doc.leaf && typeof doc.twzrd_receipt === "object" && doc.twzrd_receipt) {
    doc = doc.twzrd_receipt as Record<string, unknown>;
  }
  const leaf = String(doc?.leaf || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(leaf)) {
    throw new Error("receipt has no 64-hex-char .leaf field (is this a keccak-leaf receipt?)");
  }
  return leaf;
}

function parsePathArray(value: unknown, name: string): Uint8Array[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of 32-byte hex strings`);
  return value.map((h) => {
    const b = hexToBytes(String(h));
    if (b.length !== 32) throw new Error(`${name} entries must be 32 bytes`);
    return b;
  });
}

function requireSthValid(sth: SignedTreeHead, pubkey: string, label: string): boolean {
  const res = verifySth(sth, pubkey);
  console.log(`${label} signature : ${res.valid ? "valid" : "INVALID"}`);
  res.errors.forEach((e) => console.log(`  - ${e}`));
  return res.valid;
}

function cmdInclusion(args: string[]): number {
  const pubkey = getOpt(args, "--pubkey") || DEFAULT_STH_PUBKEY;
  const receiptPath = getOpt(args, "--receipt");
  const leafHexArg = getOpt(args, "--leaf");
  const proofPath = getOpt(args, "--proof");
  if (!proofPath || (!receiptPath && !leafHexArg)) {
    console.error("inclusion requires --proof and one of --receipt / --leaf");
    return 1;
  }
  const leafHex = receiptPath ? extractLeafHex(readJson(receiptPath)) : String(leafHexArg).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(leafHex)) {
    console.error("--leaf must be 64 hex chars");
    return 1;
  }
  const proof = readJson(proofPath) as Record<string, unknown>;
  const sthPath = getOpt(args, "--sth");
  const sth = (sthPath ? readJson(sthPath) : proof.sth) as SignedTreeHead | undefined;
  if (!sth) {
    console.error("no STH: pass --sth or embed one in the proof file as .sth");
    return 1;
  }

  console.log(`leaf            : 0x${leafHex}`);
  console.log(`log_id          : ${sth.log_id}`);
  console.log(`tree_size       : ${sth.tree_size}`);
  console.log(`pinned pubkey   : ${pubkey}`);
  const sthOk = requireSthValid(sth, pubkey, "sth");

  const included = verifyInclusion(
    hexToBytes(leafHex),
    Number(proof.leaf_index),
    Number(proof.tree_size ?? sth.tree_size),
    parsePathArray(proof.audit_path, "audit_path"),
    hexToBytes(String(sth.root)),
  );
  console.log(`inclusion       : ${included ? "valid" : "INVALID"}`);
  const ok = sthOk && included && Number(proof.tree_size ?? sth.tree_size) === Number(sth.tree_size);
  console.log(`RESULT          : ${ok ? "VALID (leaf is in the signed log)" : "INVALID"}`);
  return ok ? 0 : 1;
}

function cmdConsistency(args: string[]): number {
  const pubkey = getOpt(args, "--pubkey") || DEFAULT_STH_PUBKEY;
  const oldPath = getOpt(args, "--old");
  const newPath = getOpt(args, "--new");
  const proofPath = getOpt(args, "--proof");
  if (!oldPath || !newPath || !proofPath) {
    console.error("consistency requires --old, --new, and --proof");
    return 1;
  }
  const oldSth = readJson(oldPath) as SignedTreeHead;
  const newSth = readJson(newPath) as SignedTreeHead;
  const proofDoc = readJson(proofPath);
  const pathValue = Array.isArray(proofDoc) ? proofDoc : (proofDoc as Record<string, unknown>).path;
  const path = parsePathArray(pathValue, "path");

  console.log(`old head        : size ${oldSth.tree_size}, root ${oldSth.root}`);
  console.log(`new head        : size ${newSth.tree_size}, root ${newSth.root}`);
  console.log(`pinned pubkey   : ${pubkey}`);
  const okOld = requireSthValid(oldSth, pubkey, "old sth");
  const okNew = requireSthValid(newSth, pubkey, "new sth");
  if (String(oldSth.log_id) !== String(newSth.log_id)) {
    console.log("RESULT          : INVALID (different log_id values)");
    return 1;
  }
  const consistent = verifyConsistency(
    Number(oldSth.tree_size),
    hexToBytes(String(oldSth.root)),
    Number(newSth.tree_size),
    hexToBytes(String(newSth.root)),
    path,
  );
  console.log(`consistency     : ${consistent ? "valid" : "INVALID"}`);
  const ok = okOld && okNew && consistent;
  console.log(`RESULT          : ${ok ? "VALID (append-only between the two heads)" : "INVALID"}`);
  if (okOld && okNew && !consistent) {
    console.log("NOTE            : two validly signed heads that fail consistency are");
    console.log("                  a portable misbehavior proof — keep both files.");
  }
  return ok ? 0 : 1;
}

async function cmdAnchor(args: string[]): Promise<number> {
  const pubkey = getOpt(args, "--pubkey") || DEFAULT_STH_PUBKEY;
  const sthPath = getOpt(args, "--sth");
  const tx = getOpt(args, "--tx");
  const authority = getOpt(args, "--authority");
  if (!sthPath || !tx || !authority) {
    console.error("anchor requires --sth, --tx, and --authority");
    return 1;
  }
  const sth = readJson(sthPath) as SignedTreeHead;
  const res = await verifyAnchor({
    sth,
    txSignature: tx,
    sthPubkey: pubkey,
    anchorAuthority: authority,
    rpcUrl: getOpt(args, "--rpc"),
  });
  console.log(`sth signature   : ${res.sth_valid ? "valid" : "INVALID"}`);
  console.log(`memo binding    : ${res.memo_found ? "found" : "NOT FOUND"}`);
  console.log(`authority signed: ${res.authority_signed}`);
  if (res.slot !== null) console.log(`slot            : ${res.slot}`);
  if (res.block_time !== null) console.log(`block_time      : ${res.block_time} (${new Date(res.block_time * 1000).toISOString()})`);
  res.errors.forEach((e) => console.log(`  - ${e}`));
  console.log(`RESULT          : ${res.valid ? "VALID (head anchored on Solana)" : "INVALID"}`);
  return res.valid ? 0 : 1;
}

function cmdEquivocation(args: string[]): number {
  const pubkey = getOpt(args, "--pubkey") || DEFAULT_STH_PUBKEY;
  const aPath = getOpt(args, "--a");
  const bPath = getOpt(args, "--b");
  if (!aPath || !bPath) {
    console.error("equivocation requires --a and --b");
    return 1;
  }
  let consistencyPath: string[] | undefined;
  const proofPath = getOpt(args, "--proof");
  if (proofPath) {
    const doc = readJson(proofPath);
    const value = Array.isArray(doc) ? doc : (doc as Record<string, unknown>).path;
    consistencyPath = (value as unknown[]).map(String);
  }
  const res = checkEquivocation(
    readJson(aPath) as SignedTreeHead,
    readJson(bPath) as SignedTreeHead,
    pubkey,
    consistencyPath,
  );
  res.errors.forEach((e) => console.log(`  - ${e}`));
  console.log(`reason          : ${res.reason}`);
  console.log(`RESULT          : ${res.equivocation ? "EQUIVOCATION PROVEN (publish both STH files)" : "no equivocation proven"}`);
  // Exit 0 when the check itself ran; the finding is in the output. A proven
  // equivocation is a *successful* verification of misbehavior.
  return res.errors.length > 0 ? 1 : 0;
}

/** Build a full in-memory log with a throwaway key; every honest check must
 *  pass and every tampered variant must fail. Proves the checker checks. */
function cmdSelftest(): number {
  assertHashBackend();
  const kp = nacl.sign.keyPair();
  const entries: Uint8Array[] = [];
  for (let i = 0; i < 137; i++) {
    const e = new Uint8Array(32);
    for (let j = 0; j < 32; j++) e[j] = (i * 31 + j * 7 + 13) & 0xff;
    entries.push(e);
  }
  const logId = "selftest.local/v0";
  const mkSth = (size: number, ts: number): SignedTreeHead =>
    signSth(
      {
        domain: STH_DOMAIN,
        log_id: logId,
        tree_size: size,
        timestamp_unix: ts,
        root: bytesToHex(merkleRoot(entries.slice(0, size))),
      },
      kp.secretKey,
    );
  const pub = mkSth(1, 0).signing_pubkey as string;

  let pass = 0;
  let fail = 0;
  const check = (name: string, got: boolean, want: boolean) => {
    const ok = got === want;
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };

  const sthFull = mkSth(entries.length, 1000);
  check("sth signature verifies", verifySth(sthFull, pub).valid, true);
  check("sth rejects wrong key", verifySth(sthFull, DEFAULT_STH_PUBKEY).valid, false);

  const root = merkleRoot(entries);
  for (const i of [0, 1, 63, 64, 100, entries.length - 1]) {
    const proof = inclusionProof(entries, i);
    check(`inclusion leaf ${i}`, verifyInclusion(entries[i], i, entries.length, proof, root), true);
    check(
      `inclusion leaf ${i} rejects wrong index`,
      verifyInclusion(entries[i], (i + 1) % entries.length, entries.length, proof, root),
      false,
    );
  }
  const tampered = entries[5].slice();
  tampered[0] ^= 0xff;
  check(
    "inclusion rejects tampered leaf",
    verifyInclusion(tampered, 5, entries.length, inclusionProof(entries, 5), root),
    false,
  );

  for (const [oldSize, newSize] of [[1, 137], [64, 137], [100, 137], [137, 137], [0, 137]] as const) {
    const proof = consistencyProof(entries, oldSize);
    const proofForPair =
      newSize === entries.length ? proof : consistencyProof(entries.slice(0, newSize), oldSize);
    check(
      `consistency ${oldSize} -> ${newSize}`,
      verifyConsistency(
        oldSize,
        merkleRoot(entries.slice(0, oldSize)),
        newSize,
        merkleRoot(entries.slice(0, newSize)),
        proofForPair,
      ),
      true,
    );
  }
  check(
    "consistency rejects rewritten history",
    verifyConsistency(
      64,
      leafForgeryRoot(),
      entries.length,
      root,
      consistencyProof(entries, 64),
    ),
    false,
  );

  function leafForgeryRoot(): Uint8Array {
    const forged = entries.slice(0, 64).map((e) => e.slice());
    forged[0][0] ^= 0x01;
    return merkleRoot(forged);
  }

  const evilSth = signSth(
    {
      domain: STH_DOMAIN,
      log_id: logId,
      tree_size: entries.length,
      timestamp_unix: 2000,
      root: bytesToHex(leafForgeryRoot()),
    },
    kp.secretKey,
  );
  check(
    "equivocation detected (same size, two roots)",
    checkEquivocation(sthFull, evilSth, pub).equivocation,
    true,
  );
  check(
    "no false equivocation on identical heads",
    checkEquivocation(sthFull, mkSth(entries.length, 1000), pub).equivocation,
    false,
  );

  console.log(`\nselftest: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }
  assertHashBackend();
  let code: number;
  switch (cmd) {
    case "inclusion":
      code = cmdInclusion(args);
      break;
    case "consistency":
      code = cmdConsistency(args);
      break;
    case "anchor":
      code = await cmdAnchor(args);
      break;
    case "equivocation":
      code = cmdEquivocation(args);
      break;
    case "selftest":
      code = cmdSelftest();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(HELP);
      code = 1;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("error:", (e as Error).message);
  process.exit(1);
});
