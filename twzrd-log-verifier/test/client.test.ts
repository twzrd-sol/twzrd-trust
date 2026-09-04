import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  resolveTrust,
  keyDirectoryFromDescriptor,
  extractReceiptLeaf,
  fetchLogDescriptor,
  fetchConsistencyProof,
  verifyReceiptInLog,
  type LogDescriptor,
} from "../src/client.js";
import { STH_DOMAIN_V2, signSth } from "../src/sth.js";
import { KEY_MODE_SIGN, type LogKeyDirectory } from "../src/keydir.js";
import { merkleRoot, inclusionProof } from "../src/merkle.js";
import { b58encode, bytesToHex, type FetchLike } from "../src/util.js";

const kp = nacl.sign.keyPair();
const evilKp = nacl.sign.keyPair();
const LOG_ID = "intel.twzrd.xyz/v6";
const KEY_ID = "twzrd-log-ed25519-v2";
const BASE = "https://intel.twzrd.xyz";

const entries = Array.from({ length: 40 }, (_, i) => {
  const e = new Uint8Array(32);
  for (let j = 0; j < 32; j++) e[j] = (i * 17 + j * 5 + 2) & 0xff;
  return e;
});

const descriptor: LogDescriptor = {
  version: 1,
  log_id: LOG_ID,
  keys: [
    {
      key_id: KEY_ID,
      public_key: b58encode(kp.publicKey),
      mode: KEY_MODE_SIGN,
      not_before_unix: 0,
      not_after_unix: null,
    },
  ],
  anchor_authority: "4LkEFjJdXARkKx8FBx4LBFa2SvJNmjQpgGDLoJcypZUE",
  endpoints: {
    sth: "/v1/log/sth",
    inclusion: "/v1/log/proof/inclusion",
    consistency: "/v1/log/proof/consistency",
    anchors: "/v1/log/anchors",
  },
};

const pinnedDir: LogKeyDirectory = {
  version: 1,
  log_id: LOG_ID,
  keys: descriptor.keys!,
};

function sth(secret = kp.secretKey, size = entries.length, list = entries) {
  return signSth(
    {
      domain: STH_DOMAIN_V2,
      log_id: LOG_ID,
      key_id: KEY_ID,
      tree_size: size,
      timestamp_unix: 1755072000,
      root: bytesToHex(merkleRoot(list.slice(0, size))),
    },
    secret,
  );
}

/** Fake log server. `signer` lets a test serve heads signed by the wrong key. */
function mockServer(opts: { signer?: Uint8Array; leafIndex?: number; noDescriptor?: boolean } = {}): FetchLike {
  const signer = opts.signer ?? kp.secretKey;
  const idx = opts.leafIndex ?? 12;
  return async (url: string) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith("/.well-known/twzrd-log")) {
      return opts.noDescriptor
        ? { ok: false, status: 404, json: async () => ({}) }
        : ok(descriptor);
    }
    if (url.includes("/v1/log/sth")) return ok(sth(signer));
    if (url.includes("/v1/log/proof/inclusion")) {
      return ok({
        leaf_index: idx,
        tree_size: entries.length,
        audit_path: inclusionProof(entries, idx).map((b) => "0x" + bytesToHex(b)),
        sth: sth(signer),
      });
    }
    if (url.includes("/v1/log/proof/consistency")) {
      return ok({ path: [] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("resolveTrust: a caller-supplied pin always wins over the descriptor", () => {
  const res = resolveTrust({ trusted: pinnedDir, descriptor, trustDescriptorKeys: true });
  assert.equal(res.trusted, pinnedDir);
  assert.equal(res.tofu, false, "an explicit pin is never TOFU");
});

test("resolveTrust: no pin and no opt-in is refused rather than silently TOFU", () => {
  assert.throws(() => resolveTrust({ descriptor }), /no pinned key/);
});

test("resolveTrust: descriptor keys are TOFU and say so", () => {
  const res = resolveTrust({ descriptor, trustDescriptorKeys: true });
  assert.equal(res.tofu, true);
  assert.deepEqual((res.trusted as LogKeyDirectory).keys, descriptor.keys);
});

test("resolveTrust: falls back to a v0.1 single-key descriptor", () => {
  const legacy: LogDescriptor = { version: 1, log_id: LOG_ID, sth_pubkey: b58encode(kp.publicKey) };
  const res = resolveTrust({ descriptor: legacy, trustDescriptorKeys: true });
  assert.equal(res.trusted, legacy.sth_pubkey);
  assert.equal(res.tofu, true);
});

test("keyDirectoryFromDescriptor rejects an invalid advertised directory", () => {
  assert.throws(
    () =>
      keyDirectoryFromDescriptor({
        ...descriptor,
        keys: [{ ...descriptor.keys![0], public_key: "nope!!" }],
      }),
    /invalid/,
  );
  assert.throws(() => keyDirectoryFromDescriptor({ version: 1, log_id: LOG_ID }), /no key directory/);
});

test("extractReceiptLeaf handles bare receipts and API envelopes", () => {
  const leaf = "ab".repeat(32);
  assert.equal(extractReceiptLeaf({ leaf: "0x" + leaf }), leaf);
  assert.equal(extractReceiptLeaf({ twzrd_receipt: { leaf } }), leaf);
  assert.throws(() => extractReceiptLeaf({ nope: 1 }), /no 64-hex-char/);
});

test("fetchLogDescriptor validates the document", async () => {
  const doc = await fetchLogDescriptor(BASE, mockServer());
  assert.equal(doc.log_id, LOG_ID);
  await assert.rejects(
    fetchLogDescriptor(BASE, async () => ({ ok: true, status: 200, json: async () => ({}) })),
    /no log_id/,
  );
});

test("fetchConsistencyProof accepts both a bare array and a { path } object", async () => {
  const asObject = await fetchConsistencyProof(BASE, 1, 2, { fetchImpl: mockServer() });
  assert.deepEqual(asObject, []);
  const asArray = await fetchConsistencyProof(BASE, 1, 2, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ["0xaa"] }),
  });
  assert.deepEqual(asArray, ["0xaa"]);
});

test("verifyReceiptInLog: happy path with an explicit pin", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: mockServer(),
  });
  assert.deepEqual(res.errors, []);
  assert.ok(res.valid);
  assert.ok(res.sth_valid);
  assert.ok(res.inclusion_valid);
  assert.equal(res.tofu, false);
  assert.equal(res.key_id, KEY_ID);
  assert.equal(res.leaf_index, 12);
});

test("verifyReceiptInLog: accepts a receipt object", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    receipt: { twzrd_receipt: { leaf: "0x" + bytesToHex(entries[12]) } },
    trusted: pinnedDir,
    fetchImpl: mockServer(),
  });
  assert.ok(res.valid);
});

test("verifyReceiptInLog: a head signed by the wrong key fails", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: mockServer({ signer: evilKp.secretKey }),
  });
  assert.ok(!res.valid);
  assert.ok(!res.sth_valid);
  assert.match(res.errors.join(" "), /sth:/);
});

test("verifyReceiptInLog: a proof for the wrong leaf index fails", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: mockServer({ leafIndex: 13 }),
  });
  assert.ok(!res.valid);
  assert.ok(!res.inclusion_valid);
});

test("verifyReceiptInLog: a leaf that is not in the log fails", async () => {
  const absent = new Uint8Array(32).fill(0xcd);
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(absent),
    trusted: pinnedDir,
    fetchImpl: mockServer(),
  });
  assert.ok(!res.valid);
  assert.equal(res.not_yet_merged, undefined, "a bad proof is a failure, not a pending merge");
});

test("verifyReceiptInLog: a not-yet-merged leaf reports the 404, not misbehavior", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: async (url: string) => {
      if (url.endsWith("/.well-known/twzrd-log")) {
        return { ok: true, status: 200, json: async () => descriptor };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /inclusion proof:.*404/);
  assert.equal(res.not_yet_merged, true, "a 404 is reported as a structured pending state");
});

test("verifyReceiptInLog: a non-404 fetch failure is not reported as pending", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: async (url: string) => {
      if (url.endsWith("/.well-known/twzrd-log")) {
        return { ok: true, status: 200, json: async () => descriptor };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });
  assert.ok(!res.valid);
  assert.equal(res.not_yet_merged, undefined, "503 is an outage, not a merge delay");
  assert.match(res.errors.join(" "), /HTTP 503/);
});

test("verifyReceiptInLog: refuses to run with no pin and no TOFU opt-in", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    fetchImpl: mockServer(),
  });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /no pinned key/);
});

test("verifyReceiptInLog: works without a descriptor when keys are pinned", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: mockServer({ noDescriptor: true }),
  });
  assert.ok(res.valid, res.errors.join("; "));
});

test("verifyReceiptInLog: a proof targeting a different head than the signed one fails", async () => {
  const res = await verifyReceiptInLog({
    baseUrl: BASE,
    leaf: bytesToHex(entries[12]),
    trusted: pinnedDir,
    fetchImpl: async (url: string) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.endsWith("/.well-known/twzrd-log")) return ok(descriptor);
      if (url.includes("/v1/log/proof/inclusion")) {
        return ok({
          leaf_index: 12,
          tree_size: 39, // proof claims a smaller tree than the head it ships
          audit_path: inclusionProof(entries, 12).map((b) => "0x" + bytesToHex(b)),
          sth: sth(),
        });
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  assert.ok(!res.valid);
  assert.match(res.errors.join(" "), /proof targets tree_size 39/);
});
