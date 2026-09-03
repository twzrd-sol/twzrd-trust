#!/usr/bin/env node
/*
 * twzrd-log-verifier CLI — offline verification of the TWZRD Receipt
 * Transparency log. Exit code 0 = VALID, 1 = INVALID / error, 2 = equivocation
 * proven (monitor only — a successful detection of misbehavior).
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
import {
  signSth,
  verifySth,
  STH_DOMAIN_V1,
  STH_DOMAIN_V2,
  type SignedTreeHead,
} from "./sth.js";
import {
  KEY_MODE_SIGN,
  KEY_MODE_VERIFY_ONLY,
  validateLogKeyDirectory,
  isLogKeyDirectory,
  type LogKeyDirectory,
} from "./keydir.js";
import { verifyAnchor } from "./anchor.js";
import { checkEquivocation } from "./equivocation.js";
import { createSthPinStore, type PinnedHead } from "./pinning.js";
import {
  fetchLogDescriptor,
  fetchSth,
  fetchConsistencyProof,
  resolveTrust,
  type LogDescriptor,
} from "./client.js";
import { bytesToHex, hexToBytes, b58encode } from "./util.js";
import { DEFAULT_STH_PUBKEY } from "./index.js";

const HELP = `twzrd-log-verifier — offline verifier for the TWZRD Receipt Transparency log

Spec: docs/transparency-log.md (twzrd-sol/twzrd-trust). Verifies, with no trust
in TWZRD's servers or code: inclusion proofs, consistency proofs, Solana
anchors, and equivocation (contradictory signed tree heads).

commands:
  inclusion    --receipt FILE | --leaf HEX32, --proof FILE, [--sth FILE]
  consistency  --old FILE --new FILE --proof FILE
  anchor       --sth FILE --tx SIGNATURE --authority KEY [--rpc URL]
  equivocation --a FILE --b FILE [--proof FILE] [--proof-out FILE]
  monitor      --base-url URL --state FILE [--trust-descriptor] [--proof-out FILE]
               fetch the log's current head, prove it only appended since the
               head you last pinned, and persist the new pin. The pin never
               advances on an unproven step.
  selftest     build an in-memory log with throwaway keys; every honest check
               must pass and every tampered variant must fail

key pinning (all commands):
  --pubkey KEY   pin one base58 Ed25519 key (default: built-in ${DEFAULT_STH_PUBKEY.slice(0, 8)}…)
  --keys FILE    pin a key directory (JSON) — required to verify heads across a
                 key rotation, since each head names the key_id that signed it

file shapes:
  proof (inclusion):   { "leaf_index": n, "tree_size": n, "audit_path": ["0x…", …], "sth"?: {…} }
  proof (consistency): { "path": ["0x…", …] }  or a bare JSON array
  sth:                 { "domain", "log_id", "key_id", "tree_size", "timestamp_unix", "root", "signature" }
  keys:                { "version": 1, "log_id": "…", "keys": [
                           { "key_id", "public_key", "mode": "sign"|"verify-only",
                             "not_before_unix", "not_after_unix": n|null } ] }

exit code: 0 = VALID, 1 = INVALID / error, 2 = equivocation proven (monitor)`;

function readJson(path: string): unknown {
  const raw = path === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Caller-pinned keys: a directory when --keys is given, otherwise a single key. */
function resolveTrusted(args: string[]): string | LogKeyDirectory {
  const keysPath = getOpt(args, "--keys");
  if (!keysPath) return getOpt(args, "--pubkey") || DEFAULT_STH_PUBKEY;
  const dir = readJson(keysPath) as LogKeyDirectory;
  const errors = validateLogKeyDirectory(dir);
  if (errors.length > 0) {
    throw new Error(`invalid key directory ${keysPath}: ${errors.join("; ")}`);
  }
  return dir;
}

function describeTrust(trusted: string | LogKeyDirectory): string {
  if (isLogKeyDirectory(trusted)) {
    return `key directory for ${trusted.log_id} (${trusted.keys.length} key(s): ${trusted.keys
      .map((k) => `${k.key_id}/${k.mode}`)
      .join(", ")})`;
  }
  return String(trusted);
}

/** Accept a bare receipt or an API response nesting it under twzrd_receipt. */
function extractLeafHex(receiptDoc: unknown): string {
  let doc = receiptDoc as Record<string, unknown>;
  if (
    doc &&
    typeof doc === "object" &&
    !doc.leaf &&
    typeof doc.twzrd_receipt === "object" &&
    doc.twzrd_receipt
  ) {
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

function requireSthValid(
  sth: SignedTreeHead,
  trusted: string | LogKeyDirectory,
  label: string,
): boolean {
  const res = verifySth(sth, trusted);
  const via = res.key_id ? ` [key_id ${res.key_id}${res.key_mode ? `/${res.key_mode}` : ""}]` : "";
  console.log(`${label} signature : ${res.valid ? "valid" : "INVALID"}${via}`);
  res.errors.forEach((e) => console.log(`  - ${e}`));
  return res.valid;
}

function writeProofBundle(args: string[], bundle: unknown): void {
  const out = getOpt(args, "--proof-out");
  const json = JSON.stringify(bundle, null, 2);
  if (out) {
    fs.writeFileSync(out, json + "\n");
    console.log(`proof written    : ${out}`);
  } else {
    console.log("--- publishable proof bundle ---");
    console.log(json);
  }
}

function cmdInclusion(args: string[]): number {
  const trusted = resolveTrusted(args);
  const receiptPath = getOpt(args, "--receipt");
  const leafHexArg = getOpt(args, "--leaf");
  const proofPath = getOpt(args, "--proof");
  if (!proofPath || (!receiptPath && !leafHexArg)) {
    console.error("inclusion requires --proof and one of --receipt / --leaf");
    return 1;
  }
  const leafHex = receiptPath
    ? extractLeafHex(readJson(receiptPath))
    : String(leafHexArg).toLowerCase().replace(/^0x/, "");
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
  console.log(`pinned          : ${describeTrust(trusted)}`);
  const sthOk = requireSthValid(sth, trusted, "sth");

  const proofSize = Number(proof.tree_size ?? sth.tree_size);
  const included = verifyInclusion(
    hexToBytes(leafHex),
    Number(proof.leaf_index),
    proofSize,
    parsePathArray(proof.audit_path, "audit_path"),
    hexToBytes(String(sth.root)),
  );
  console.log(`inclusion       : ${included ? "valid" : "INVALID"}`);
  if (proofSize !== Number(sth.tree_size)) {
    console.log(
      `  - proof targets tree_size ${proofSize} but the signed head is at ${sth.tree_size}`,
    );
  }
  const ok = sthOk && included && proofSize === Number(sth.tree_size);
  console.log(`RESULT          : ${ok ? "VALID (leaf is in the signed log)" : "INVALID"}`);
  return ok ? 0 : 1;
}

function cmdConsistency(args: string[]): number {
  const trusted = resolveTrusted(args);
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
  console.log(`pinned          : ${describeTrust(trusted)}`);
  const okOld = requireSthValid(oldSth, trusted, "old sth");
  const okNew = requireSthValid(newSth, trusted, "new sth");
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
  const trusted = resolveTrusted(args);
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
    sthPubkey: trusted,
    anchorAuthority: authority,
    rpcUrl: getOpt(args, "--rpc"),
  });
  console.log(`sth signature   : ${res.sth_valid ? "valid" : "INVALID"}`);
  console.log(`memo binding    : ${res.memo_found ? "found" : "NOT FOUND"}`);
  console.log(`authority signed: ${res.authority_signed}`);
  if (res.slot !== null) console.log(`slot            : ${res.slot}`);
  if (res.block_time !== null) {
    console.log(
      `block_time      : ${res.block_time} (${new Date(res.block_time * 1000).toISOString()})`,
    );
  }
  res.errors.forEach((e) => console.log(`  - ${e}`));
  console.log(`RESULT          : ${res.valid ? "VALID (head anchored on Solana)" : "INVALID"}`);
  return res.valid ? 0 : 1;
}

function cmdEquivocation(args: string[]): number {
  const trusted = resolveTrusted(args);
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
    trusted,
    consistencyPath,
  );
  res.errors.forEach((e) => console.log(`  - ${e}`));
  if (res.cross_key) {
    console.log("cross-key       : the two heads were signed by different key_ids");
  }
  console.log(`reason          : ${res.reason}`);
  console.log(
    `RESULT          : ${res.equivocation ? "EQUIVOCATION PROVEN" : "no equivocation proven"}`,
  );
  if (res.equivocation && res.proof) writeProofBundle(args, res.proof);
  // Exit 0 when the check itself ran; the finding is in the output. A proven
  // equivocation is a *successful* verification of misbehavior.
  return res.errors.length > 0 ? 1 : 0;
}

async function cmdMonitor(args: string[]): Promise<number> {
  const baseUrl = getOpt(args, "--base-url");
  const statePath = getOpt(args, "--state");
  if (!baseUrl || !statePath) {
    console.error("monitor requires --base-url and --state");
    return 1;
  }
  const explicitPin = args.includes("--keys") || args.includes("--pubkey");
  const trustDescriptor = args.includes("--trust-descriptor");

  let descriptor: LogDescriptor | undefined;
  try {
    descriptor = await fetchLogDescriptor(baseUrl);
  } catch (e) {
    if (!explicitPin) {
      console.error(`could not fetch log descriptor: ${(e as Error).message}`);
      return 1;
    }
  }

  let trusted: string | LogKeyDirectory;
  let tofu = false;
  try {
    const resolution = resolveTrust({
      trusted: explicitPin ? resolveTrusted(args) : undefined,
      descriptor,
      trustDescriptorKeys: trustDescriptor,
    });
    trusted = resolution.trusted;
    tofu = resolution.tofu;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  let initial: PinnedHead | null = null;
  if (fs.existsSync(statePath)) {
    initial = readJson(statePath) as PinnedHead;
  }

  const store = createSthPinStore({
    trusted,
    initial,
    onPin: (head) => {
      fs.writeFileSync(statePath, JSON.stringify(head, null, 2) + "\n");
    },
  });

  let sth: SignedTreeHead;
  try {
    sth = await fetchSth(baseUrl, { descriptor });
  } catch (e) {
    console.error(`could not fetch current head: ${(e as Error).message}`);
    return 1;
  }

  console.log(`log             : ${baseUrl}`);
  console.log(`pinned          : ${describeTrust(trusted)}${tofu ? "  [TOFU — keys came from the log itself]" : ""}`);
  if (initial) console.log(`previous pin    : tree_size ${initial.tree_size}, root 0x${initial.root}`);
  console.log(`observed head   : tree_size ${sth.tree_size}, root ${sth.root}`);

  const result = await store.observe(sth, {
    fetchConsistencyProof: (oldSize, newSize) =>
      fetchConsistencyProof(baseUrl, oldSize, newSize, { descriptor }),
  });

  result.errors.forEach((e) => console.log(`  - ${e}`));
  console.log(`status          : ${result.status}`);
  console.log(`                  ${result.message}`);
  if (result.status === "equivocation" && result.equivocation?.proof) {
    writeProofBundle(args, result.equivocation.proof);
    console.log("RESULT          : EQUIVOCATION PROVEN — publish the proof bundle");
    return 2;
  }
  if (result.status === "error") {
    console.log("RESULT          : ERROR (pin unchanged)");
    return 1;
  }
  console.log(`RESULT          : OK (${result.status})`);
  return 0;
}

/** Build a full in-memory log with throwaway keys; every honest check must
 *  pass and every tampered variant must fail. Proves the checker checks. */
async function cmdSelftest(): Promise<number> {
  assertHashBackend();
  const kpV1 = nacl.sign.keyPair();
  const kpV2 = nacl.sign.keyPair();
  const entries: Uint8Array[] = [];
  for (let i = 0; i < 137; i++) {
    const e = new Uint8Array(32);
    for (let j = 0; j < 32; j++) e[j] = (i * 31 + j * 7 + 13) & 0xff;
    entries.push(e);
  }
  const logId = "selftest.local/v0";
  const ROTATION = 5000;
  const dir: LogKeyDirectory = {
    version: 1,
    log_id: logId,
    keys: [
      {
        key_id: "selftest-log-ed25519-v1",
        public_key: b58encode(kpV1.publicKey),
        mode: KEY_MODE_VERIFY_ONLY,
        not_before_unix: 0,
        not_after_unix: ROTATION,
      },
      {
        key_id: "selftest-log-ed25519-v2",
        public_key: b58encode(kpV2.publicKey),
        mode: KEY_MODE_SIGN,
        not_before_unix: ROTATION,
        not_after_unix: null,
      },
    ],
  };

  const head = (size: number, ts: number, list = entries): SignedTreeHead => {
    const retired = ts < ROTATION;
    return signSth(
      {
        domain: STH_DOMAIN_V2,
        log_id: logId,
        key_id: retired ? "selftest-log-ed25519-v1" : "selftest-log-ed25519-v2",
        tree_size: size,
        timestamp_unix: ts,
        root: bytesToHex(merkleRoot(list.slice(0, size))),
      },
      retired ? kpV1.secretKey : kpV2.secretKey,
    );
  };

  let pass = 0;
  let fail = 0;
  const check = (name: string, got: boolean, want: boolean) => {
    const ok = got === want;
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  };

  // --- key directory ---
  check("key directory validates", validateLogKeyDirectory(dir).length === 0, true);
  check(
    "directory rejects two signing keys",
    validateLogKeyDirectory({
      ...dir,
      keys: dir.keys.map((k) => ({ ...k, mode: KEY_MODE_SIGN })),
    }).length > 0,
    true,
  );
  check(
    "directory rejects overlapping windows",
    validateLogKeyDirectory({
      ...dir,
      keys: [{ ...dir.keys[0], not_after_unix: ROTATION + 1000 }, dir.keys[1]],
    }).length > 0,
    true,
  );

  // --- signatures across a rotation ---
  const current = head(entries.length, 9000);
  const preRotation = head(40, 1000);
  check("current head verifies via directory", verifySth(current, dir).valid, true);
  check(
    "pre-rotation head still verifies against the retired key",
    verifySth(preRotation, dir).valid,
    true,
  );
  check(
    "retired key cannot sign a post-rotation head",
    verifySth(
      signSth(
        {
          domain: STH_DOMAIN_V2,
          log_id: logId,
          key_id: "selftest-log-ed25519-v1",
          tree_size: 50,
          timestamp_unix: 9000,
          root: bytesToHex(merkleRoot(entries.slice(0, 50))),
        },
        kpV1.secretKey,
      ),
      dir,
    ).valid,
    false,
  );
  check(
    "unknown key_id is rejected",
    verifySth({ ...current, key_id: "selftest-log-ed25519-v9" }, dir).valid,
    false,
  );
  check(
    "V1 head carrying an unsigned key_id is rejected",
    verifySth(
      { ...preRotation, domain: STH_DOMAIN_V1, key_id: "selftest-log-ed25519-v1" },
      dir,
    ).valid,
    false,
  );

  // --- merkle ---
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

  const forkedEntries = entries.map((e) => e.slice());
  forkedEntries[3][0] ^= 0x01;
  const forkedRootAt = (n: number) => merkleRoot(forkedEntries.slice(0, n));

  for (const [oldSize, newSize] of [[1, 137], [64, 137], [100, 137], [137, 137], [0, 137]] as const) {
    check(
      `consistency ${oldSize} -> ${newSize}`,
      verifyConsistency(
        oldSize,
        merkleRoot(entries.slice(0, oldSize)),
        newSize,
        merkleRoot(entries.slice(0, newSize)),
        consistencyProof(entries.slice(0, newSize), oldSize),
      ),
      true,
    );
  }
  check(
    "consistency rejects rewritten history",
    verifyConsistency(64, forkedRootAt(64), entries.length, root, consistencyProof(entries, 64)),
    false,
  );

  // --- equivocation, including across a rotation ---
  const evil = head(entries.length, 9500, forkedEntries);
  check("equivocation detected (same size, two roots)", checkEquivocation(current, evil, dir).equivocation, true);
  check("no false equivocation on identical heads", checkEquivocation(current, head(entries.length, 9000), dir).equivocation, false);
  const crossKeyEvil = signSth(
    {
      domain: STH_DOMAIN_V2,
      log_id: logId,
      key_id: "selftest-log-ed25519-v1",
      tree_size: entries.length,
      timestamp_unix: 1000,
      root: bytesToHex(forkedRootAt(entries.length)),
    },
    kpV1.secretKey,
  );
  const crossKey = checkEquivocation(current, crossKeyEvil, dir);
  check("rotation does not launder equivocation", crossKey.equivocation && crossKey.cross_key, true);

  // --- pinning / split-view ---
  const fetchProof = async (oldSize: number, newSize: number) =>
    consistencyProof(entries.slice(0, newSize), oldSize).map((b) => bytesToHex(b));
  const store = createSthPinStore({ trusted: dir, now: () => 9000 });
  check("pin: first head pins", (await store.observe(head(40, 6000))).status === "pinned", true);
  check(
    "pin: same head is unchanged",
    (await store.observe(head(40, 6000))).status === "unchanged",
    true,
  );
  check(
    "pin: refuses to advance without a proof",
    (await store.observe(head(100, 7000))).status === "error",
    true,
  );
  check("pin: still at 40 after refusal", store.get()?.tree_size === 40, true);
  check(
    "pin: advances on a proven append",
    (await store.observe(head(100, 7000), { fetchConsistencyProof: fetchProof })).status === "advanced",
    true,
  );
  check("pin: advanced to 100", store.get()?.tree_size === 100, true);
  check(
    "pin: lagging replica is not an attack",
    (await store.observe(head(60, 6500), { fetchConsistencyProof: fetchProof })).status === "lagging",
    true,
  );
  check("pin: lag did not move the pin", store.get()?.tree_size === 100, true);
  const forkStore = createSthPinStore({ trusted: dir, now: () => 9000 });
  await forkStore.observe(head(100, 7000));
  check(
    "pin: fork at the same size is equivocation",
    (await forkStore.observe(head(100, 7100, forkedEntries))).status === "equivocation",
    true,
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
    case "monitor":
      code = await cmdMonitor(args);
      break;
    case "selftest":
      code = await cmdSelftest();
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
