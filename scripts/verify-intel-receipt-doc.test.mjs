// Binds docs/verify-intel-receipt.md to the receipt it publishes.
//
// The page claims that one real receipt from intel.twzrd.xyz verifies with public
// material only. This test runs the same checks on the committed bytes, offline
// (no network call), so the page cannot drift from the files it points at:
//   - the reference verifier recomputes the leaf and checks Ed25519 against a key
//     pinned HERE, never the key the receipt names;
//   - the standard-library script in docs/proofs/examples agrees, and refuses a
//     different key;
//   - edited copies fail;
//   - the inclusion proof is for this receipt's leaf and verifies under the same pin;
//   - the page quotes this receipt and no other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "docs", "proofs", "intel-receipt");
const DOC = join(ROOT, "docs", "verify-intel-receipt.md");
const SIGNATURE_SCRIPT = join(ROOT, "docs", "proofs", "examples", "verify-receipt-signature.mjs");
const LOG_VERIFIER_CLI = join(ROOT, "twzrd-log-verifier", "src", "cli.ts");

// The reference verifier is a dependency of the Eliza plugin workspace; resolve it from there.
const verifier = createRequire(join(ROOT, "eliza-plugin-source", "package.json"))("twzrd-receipt-verifier");

// Pinned in this file. docs/receipt-v6-spec.md publishes the same value.
const PINNED_KEY = "Ak5SQwHpuQAqU7ty7ZWX7qgF39A9yi72c22KNn8sHzvS";
const OTHER_KEY = "9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf"; // the retired v1 key: real, but not this receipt's
// TWZRD's own seller wallet: the payTo of the paid intel routes.
const TWZRD_SELLER_WALLET = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

const readJson = (name) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const receipt = readJson("receipt.json");
const inclusion = readJson("log-inclusion.json");
const paymentResponse = readJson("payment-response.json");
const pre = receipt.preimage;

async function exitCode(args) {
  try {
    await run(process.execPath, args);
    return 0;
  } catch (e) {
    return e.code;
  }
}

function withTempFile(value, fn) {
  const dir = mkdtempSync(join(tmpdir(), "twzrd-receipt-doc-"));
  const file = join(dir, "receipt.json");
  writeFileSync(file, JSON.stringify(value));
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the published receipt verifies under the pinned key: leaf recomputed, Ed25519 checked", () => {
  const res = verifier.verify(receipt, PINNED_KEY);
  assert.equal(res.leaf_valid, true, res.errors.join("; "));
  assert.equal(res.signature_valid, true, res.errors.join("; "));
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.leaf_version, "v7");
  assert.deepEqual(res.unauthenticated_fields, [], "V7 binds the freshness fields");
  assert.equal(receipt.key_id, "twzrd-receipt-ed25519-v2");
});

test("the receipt scores TWZRD's own seller wallet, so this page publishes no third party's score", () => {
  assert.equal(pre.agent_id, TWZRD_SELLER_WALLET);
});

test("an edited score, an edited freshness field and a different key each fail", () => {
  const editedScore = structuredClone(receipt);
  editedScore.preimage.score = pre.score === 99 ? 98 : 99;
  assert.equal(verifier.verify(editedScore, PINNED_KEY).valid, false);

  const editedRecheck = structuredClone(receipt);
  editedRecheck.preimage.recheck_after_unix = pre.recheck_after_unix + 86_400;
  assert.equal(verifier.verify(editedRecheck, PINNED_KEY).valid, false);

  assert.equal(verifier.verify(receipt, OTHER_KEY).valid, false);
});

test("a receipt that names its own key does not verify under the pin", () => {
  // A forger controls every field of the receipt, signing_pubkey included.
  const selfNamed = structuredClone(receipt);
  selfNamed.signing_pubkey = OTHER_KEY;
  selfNamed.preimage.score = pre.score === 99 ? 98 : 99;
  assert.equal(verifier.verify(selfNamed, PINNED_KEY).valid, false);
});

test("the standard-library script agrees, and exits 1 for a different key", async () => {
  const file = join(DIR, "receipt.json");
  const { stdout } = await run(process.execPath, [SIGNATURE_SCRIPT, file, PINNED_KEY]);
  assert.match(stdout, /signature\s*: VALID/);
  assert.equal(await exitCode([SIGNATURE_SCRIPT, file, OTHER_KEY]), 1);

  // A changed leaf is no longer what the key signed.
  const editedLeaf = structuredClone(receipt);
  editedLeaf.leaf = receipt.leaf.slice(0, -1) + (receipt.leaf.endsWith("0") ? "1" : "0");
  await withTempFile(editedLeaf, async (tmp) => {
    assert.equal(await exitCode([SIGNATURE_SCRIPT, tmp, PINNED_KEY]), 1);
  });
  assert.equal(await exitCode([SIGNATURE_SCRIPT, file]), 2, "a missing key is a usage error, never a pass");
});

test("settlement_anchor is the last 32 characters of settlement_tx", () => {
  assert.match(pre.settlement_tx, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(Buffer.from(pre.settlement_tx.slice(-32), "ascii").toString("hex"), pre.settlement_anchor);
});

test("the payment response names the transaction and payer the receipt binds", () => {
  assert.equal(paymentResponse.success, true);
  assert.equal(paymentResponse.transaction, pre.settlement_tx);
  assert.equal(paymentResponse.payer, pre.payer);
  assert.equal(paymentResponse.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
});

test("the inclusion proof is for this receipt's leaf and verifies under the same pin", async () => {
  assert.equal(inclusion.leaf, receipt.leaf);
  assert.equal(inclusion.sth.signing_pubkey, PINNED_KEY);
  const args = ["--import", "tsx", LOG_VERIFIER_CLI, "inclusion"];
  const proof = join(DIR, "log-inclusion.json");
  const { stdout } = await run(process.execPath, [
    ...args, "--proof", proof, "--receipt", join(DIR, "receipt.json"), "--pubkey", PINNED_KEY,
  ], { cwd: ROOT });
  assert.match(stdout, /sth signature\s*: valid/);
  assert.match(stdout, /RESULT\s*: VALID/);

  const editedRoot = structuredClone(inclusion);
  editedRoot.sth.root = inclusion.sth.root.slice(0, -1) + (inclusion.sth.root.endsWith("0") ? "1" : "0");
  await withTempFile(editedRoot, async (tmp) => {
    let stdoutOnFailure = "";
    const code = await run(process.execPath, [...args, "--proof", tmp, "--pubkey", PINNED_KEY], { cwd: ROOT })
      .then(() => 0, (e) => { stdoutOnFailure = String(e.stdout ?? ""); return e.code; });
    assert.notEqual(code, 0);
    assert.doesNotMatch(stdoutOnFailure, /RESULT\s*: VALID/);
  });
});

test("the page quotes this receipt, the pinned key, and has no unfilled field", () => {
  const doc = readFileSync(DOC, "utf8");
  for (const value of [receipt.leaf, pre.settlement_tx, pre.payer, pre.agent_id, PINNED_KEY, inclusion.sth.root]) {
    assert.ok(doc.includes(value), `docs/verify-intel-receipt.md does not quote ${value}`);
  }
  assert.ok(doc.includes(new Date(pre.timestamp_unix * 1000).toISOString().replace(".000Z", "Z")));
  assert.doesNotMatch(doc, /\{\{|\}\}/, "an unrendered template field is left in the page");
});
