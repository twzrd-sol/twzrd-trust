import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import {
  KEY_MODE_SIGN,
  KEY_MODE_VERIFY_ONLY,
  validateLogKeyDirectory,
  keyCoversTimestamp,
  resolveLogKey,
  currentSigningKey,
  isLogKeyDirectory,
  type LogKeyDirectory,
} from "../src/keydir.js";
import { b58encode } from "../src/util.js";

const k1 = b58encode(nacl.sign.keyPair().publicKey);
const k2 = b58encode(nacl.sign.keyPair().publicKey);

const dir: LogKeyDirectory = {
  version: 1,
  log_id: "intel.twzrd.xyz/v6",
  keys: [
    {
      key_id: "twzrd-log-ed25519-v1",
      public_key: k1,
      mode: KEY_MODE_VERIFY_ONLY,
      not_before_unix: 1000,
      not_after_unix: 2000,
    },
    {
      key_id: "twzrd-log-ed25519-v2",
      public_key: k2,
      mode: KEY_MODE_SIGN,
      not_before_unix: 2000,
      not_after_unix: null,
    },
  ],
};

test("a well-formed directory validates", () => {
  assert.deepEqual(validateLogKeyDirectory(dir), []);
});

test("rejects structural problems", () => {
  assert.ok(validateLogKeyDirectory(null).length > 0);
  assert.ok(validateLogKeyDirectory({ log_id: "x", keys: [] }).length > 0);
  assert.ok(validateLogKeyDirectory({ log_id: "", keys: dir.keys }).length > 0);
  assert.ok(
    validateLogKeyDirectory({ ...dir, keys: [{ ...dir.keys[0], public_key: "not base58 !!" }] })
      .length > 0,
  );
  assert.ok(
    validateLogKeyDirectory({ ...dir, keys: [{ ...dir.keys[0], mode: "sometimes" }] }).length > 0,
  );
  assert.ok(
    validateLogKeyDirectory({ ...dir, keys: [{ ...dir.keys[0], key_id: "" }] }).length > 0,
  );
});

test("rejects a public_key that is base58 but the wrong length", () => {
  const short = b58encode(new Uint8Array(16));
  const errors = validateLogKeyDirectory({ ...dir, keys: [{ ...dir.keys[0], public_key: short }] });
  assert.ok(errors.some((e) => /32 bytes/.test(e)));
});

test("rejects duplicate key_ids", () => {
  const errors = validateLogKeyDirectory({
    ...dir,
    keys: [dir.keys[0], { ...dir.keys[1], key_id: dir.keys[0].key_id }],
  });
  assert.ok(errors.some((e) => /duplicate key_id/.test(e)));
});

test("rejects more than one signing key", () => {
  const errors = validateLogKeyDirectory({
    ...dir,
    keys: dir.keys.map((k) => ({ ...k, mode: KEY_MODE_SIGN })),
  });
  assert.ok(errors.some((e) => /at most one key/.test(e)));
});

test("rejects overlapping validity windows", () => {
  const errors = validateLogKeyDirectory({
    ...dir,
    keys: [{ ...dir.keys[0], not_after_unix: 2500 }, dir.keys[1]],
  });
  assert.ok(errors.some((e) => /overlapping validity windows/.test(e)));
});

test("rejects an inverted window", () => {
  const errors = validateLogKeyDirectory({
    ...dir,
    keys: [{ ...dir.keys[0], not_before_unix: 3000, not_after_unix: 2000 }],
  });
  assert.ok(errors.some((e) => /greater than not_before_unix/.test(e)));
});

test("windows are inclusive at the start and exclusive at the end", () => {
  const [v1, v2] = dir.keys;
  assert.ok(!keyCoversTimestamp(v1, 999));
  assert.ok(keyCoversTimestamp(v1, 1000));
  assert.ok(keyCoversTimestamp(v1, 1999));
  assert.ok(!keyCoversTimestamp(v1, 2000), "not_after is exclusive");
  assert.ok(keyCoversTimestamp(v2, 2000), "not_before is inclusive");
  assert.ok(keyCoversTimestamp(v2, 10 ** 12), "null not_after is open-ended");
});

test("resolution reports unknown key_id and out-of-window heads", () => {
  assert.deepEqual(resolveLogKey(dir, "twzrd-log-ed25519-v1", 1500).errors, []);
  const unknown = resolveLogKey(dir, "twzrd-log-ed25519-v9", 1500);
  assert.equal(unknown.entry, undefined);
  assert.match(unknown.errors[0], /not in the pinned key directory/);

  // A retired key cannot be used for a head dated after its retirement.
  const outOfWindow = resolveLogKey(dir, "twzrd-log-ed25519-v1", 5000);
  assert.ok(outOfWindow.entry, "entry still resolves");
  assert.match(outOfWindow.errors[0], /outside the validity window/);
});

test("currentSigningKey finds the one key allowed to sign", () => {
  assert.equal(currentSigningKey(dir)?.key_id, "twzrd-log-ed25519-v2");
  assert.equal(
    currentSigningKey({ ...dir, keys: [dir.keys[0]] }),
    undefined,
    "an all-retired directory has no signer",
  );
});

test("isLogKeyDirectory distinguishes a directory from a bare key string", () => {
  assert.ok(isLogKeyDirectory(dir));
  assert.ok(!isLogKeyDirectory("9V6Pn19kiUA5Rn6JpQfNduanvGt2aXGwsarosNfa2Ldf"));
  assert.ok(!isLogKeyDirectory(null));
});
