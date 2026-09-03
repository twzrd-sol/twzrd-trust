import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { createSthPinStore, type PinnedHead } from "../src/pinning.js";
import { STH_DOMAIN_V2, signSth, type SignedTreeHead } from "../src/sth.js";
import { KEY_MODE_SIGN, type LogKeyDirectory } from "../src/keydir.js";
import { merkleRoot, consistencyProof } from "../src/merkle.js";
import { b58encode, bytesToHex } from "../src/util.js";

const kp = nacl.sign.keyPair();
const LOG_ID = "intel.twzrd.xyz/v6";
const KEY_ID = "twzrd-log-ed25519-v2";

const dir: LogKeyDirectory = {
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
};

function makeEntries(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => {
    const e = new Uint8Array(32);
    for (let j = 0; j < 32; j++) e[j] = (i * 71 + j * 13 + 5) & 0xff;
    return e;
  });
}

const entries = makeEntries(120);
const forked = entries.map((e) => e.slice());
forked[7][0] ^= 0x01;

function head(size: number, ts: number, list = entries, logId = LOG_ID): SignedTreeHead {
  return signSth(
    {
      domain: STH_DOMAIN_V2,
      log_id: logId,
      key_id: KEY_ID,
      tree_size: size,
      timestamp_unix: ts,
      root: bytesToHex(merkleRoot(list.slice(0, size))),
    },
    kp.secretKey,
  );
}

const honestFetcher = async (oldSize: number, newSize: number) =>
  consistencyProof(entries.slice(0, newSize), oldSize).map(bytesToHex);

function store(initial?: PinnedHead | null, onPin?: (h: PinnedHead) => void) {
  return createSthPinStore({ trusted: dir, initial, onPin, now: () => 1234 });
}

test("first head pins, identical head is unchanged", async () => {
  const s = store();
  const first = await s.observe(head(50, 100));
  assert.equal(first.status, "pinned");
  assert.equal(s.get()?.tree_size, 50);

  const again = await s.observe(head(50, 100));
  assert.equal(again.status, "unchanged");
});

test("pin advances only on a proven append", async () => {
  const s = store();
  await s.observe(head(50, 100));

  const noProof = await s.observe(head(90, 200));
  assert.equal(noProof.status, "error");
  assert.equal(s.get()?.tree_size, 50, "pin must not advance without a proof");

  const proven = await s.observe(head(90, 200), { fetchConsistencyProof: honestFetcher });
  assert.equal(proven.status, "advanced");
  assert.equal(proven.previous?.tree_size, 50);
  assert.equal(s.get()?.tree_size, 90);
});

test("a fetch failure leaves the pin untouched", async () => {
  const s = store();
  await s.observe(head(50, 100));
  const res = await s.observe(head(90, 200), {
    fetchConsistencyProof: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(res.status, "error");
  assert.match(res.errors.join(" "), /network down/);
  assert.equal(s.get()?.tree_size, 50);
});

test("a bogus consistency proof never advances the pin", async () => {
  const s = store();
  await s.observe(head(50, 100));
  const res = await s.observe(head(90, 200), {
    fetchConsistencyProof: async () => [bytesToHex(new Uint8Array(32).fill(7))],
  });
  assert.equal(res.status, "equivocation");
  assert.equal(s.get()?.tree_size, 50);
});

test("a lagging replica is reported, not treated as an attack", async () => {
  const s = store();
  await s.observe(head(90, 200));
  const res = await s.observe(head(60, 150), { fetchConsistencyProof: honestFetcher });
  assert.equal(res.status, "lagging");
  assert.equal(s.get()?.tree_size, 90, "lag must not roll the pin back");
});

test("a rollback to an inconsistent smaller head is equivocation", async () => {
  const s = store();
  await s.observe(head(90, 200));
  const res = await s.observe(head(60, 150, forked), {
    // The log offers a proof against its real history; it cannot match the fork.
    fetchConsistencyProof: honestFetcher,
  });
  assert.equal(res.status, "equivocation");
  assert.ok(res.equivocation?.proof);
});

test("two roots at one tree size is equivocation with a publishable proof", async () => {
  const s = store();
  await s.observe(head(90, 200));
  const res = await s.observe(head(90, 210, forked));
  assert.equal(res.status, "equivocation");
  assert.ok(res.equivocation?.equivocation);
  assert.ok(res.equivocation?.proof?.sth_a);
  assert.ok(res.equivocation?.proof?.sth_b);
  assert.equal(s.get()?.tree_size, 90);
});

test("an unverifiable head is an error and never becomes the pin", async () => {
  const s = store();
  const tampered = { ...head(50, 100), tree_size: 51 };
  const res = await s.observe(tampered);
  assert.equal(res.status, "error");
  assert.equal(s.get(), null);
});

test("a head from a different log is rejected by the pinned directory", async () => {
  const s = store();
  await s.observe(head(50, 100));
  const res = await s.observe(head(50, 100, entries, "someone.else/v1"));
  assert.equal(res.status, "error");
  // A pinned directory names its log, so the foreign head fails signature
  // resolution before the pin is ever consulted.
  assert.match(res.errors.join(" "), /!= pinned directory log_id/);
  assert.equal(s.get()?.log_id, LOG_ID);
});

test("a head from a different log is rejected when only a bare key is pinned", async () => {
  // With a bare key there is no directory log_id to check, so the pin itself
  // has to refuse to adopt a head belonging to another log.
  const bare = createSthPinStore({ trusted: b58encode(kp.publicKey), now: () => 1234 });
  await bare.observe(head(50, 100));
  const res = await bare.observe(head(50, 100, entries, "someone.else/v1"));
  assert.equal(res.status, "error");
  assert.match(res.message, /a different log, not an update/);
  assert.equal(bare.get()?.log_id, LOG_ID);
});

test("onPin fires exactly on pin and advance, so state can be persisted", async () => {
  const saved: PinnedHead[] = [];
  const s = store(null, (h) => saved.push(h));
  await s.observe(head(50, 100));
  await s.observe(head(50, 100)); // unchanged
  await s.observe(head(90, 200), { fetchConsistencyProof: honestFetcher });
  await s.observe(head(60, 150), { fetchConsistencyProof: honestFetcher }); // lagging
  assert.deepEqual(
    saved.map((h) => h.tree_size),
    [50, 90],
  );
});

test("a restored pin carries over across runs", async () => {
  const first = store();
  await first.observe(head(50, 100));
  const persisted = first.get() as PinnedHead;

  const resumed = store(persisted);
  assert.equal(resumed.get()?.tree_size, 50);
  const res = await resumed.observe(head(90, 200), { fetchConsistencyProof: honestFetcher });
  assert.equal(res.status, "advanced");
});
