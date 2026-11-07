import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

import {
  HOUSE_PAYER_PREFIXES,
  HousePayerKeyError,
  ForeignPayerInputError,
  assertNotHousePayerKey,
  requireForeignPayerInput,
  assertHttpsTarget,
} from "../src/foreign-key.js";

// The source resolves the house prefixes against the current home so no account
// name is baked into the package; the test must do the same, or it only passes
// when run as that one account (it failed on the isolated CI runner, 2026-10-22).
const HOME = homedir();
assert.deepEqual(HOUSE_PAYER_PREFIXES, [
  join(HOME, "security/wallets/x402-reader") + "/",
  join(HOME, "security/wallets/outbid") + "/",
  join(HOME, "security/wallets/outbid-token") + "/",
]);

assert.throws(
  () => assertNotHousePayerKey(join(HOME, "security/wallets/x402-reader/payer.svm.json")),
  HousePayerKeyError,
);
assert.throws(
  () => assertNotHousePayerKey(join(HOME, "security/wallets/outbid/anything.json")),
  HousePayerKeyError,
);
assert.throws(
  () => assertNotHousePayerKey(join(HOME, "security/wallets/outbid-token/payer.json")),
  HousePayerKeyError,
);

const dir = tempDir("twzrd-foreign-key-");
const ok = join(dir, "payer.json");
writeFileSync(ok, "[]");
assert.doesNotThrow(() => assertNotHousePayerKey(ok));
assert.doesNotThrow(() =>
  assertNotHousePayerKey(join(HOME, "security/wallets/x402-reader-not-house/payer.json")),
);

assert.throws(
  () => requireForeignPayerInput({}, []),
  ForeignPayerInputError,
);
assert.throws(
  () => requireForeignPayerInput({ PAYER_SVM_KEY: ok, MAX_USD: "0.01" }, ["https://example.com/"]),
  ForeignPayerInputError,
);
const got = requireForeignPayerInput(
  { PAYER_SVM_KEY: ok, MAX_USD: "0.01", DAILY_USD: "1" },
  ["https://example.com/paid"],
);
assert.equal(got.keyPath, ok);
assert.equal(got.maxUsd, "0.01");
assert.equal(got.dailyUsd, "1");
assert.equal(got.url, "https://example.com/paid");

assert.equal(assertHttpsTarget("https://example.com/x").href, "https://example.com/x");
assert.throws(() => assertHttpsTarget("http://example.com/x"), ForeignPayerInputError);
assert.throws(() => assertHttpsTarget("https://localhost/x"), ForeignPayerInputError);
assert.throws(() => assertHttpsTarget("https://127.0.0.1/x"), ForeignPayerInputError);
assert.throws(() => assertHttpsTarget("https://[::1]/x"), ForeignPayerInputError);

console.log("foreign-payer.test.ts: ok");
