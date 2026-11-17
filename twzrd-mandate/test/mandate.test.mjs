// The mandate document: issue, verify, and every way it must fail closed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  generateKeyFile,
  issueMandate,
  keyFromSeed,
  loadKeyFile,
  loadMandateFile,
  mandateLimitsMicro,
  parseMandate,
  signMandateBody,
  usdToMicro,
  microToUsd,
  verifyMandate,
  writeMandateFile,
} from "../dist/index.js";
import { tempDir } from "./helpers.mjs";

const operator = keyFromSeed(crypto.createHash("sha256").update("operator").digest());
const agent = keyFromSeed(crypto.createHash("sha256").update("agent").digest());
const NOW = Date.parse("2026-11-17T08:00:00Z");

function base(extra = {}) {
  return {
    issuerMode: "human-operator",
    issuerKey: operator,
    agent: agent.publicKey,
    maxPerCallUsd: "0.10",
    dailyCeilingUsd: "5.00",
    allowedChains: ["solana"],
    minTrustScore: 75,
    allowedTools: ["http:intel.twzrd.xyz"],
    killswitchDir: ".twzrd-mandate",
    lifetimeMs: 30 * 86_400_000,
    now: NOW,
    ...extra,
  };
}
const trusted = { trustedIssuers: [operator.publicKey], now: NOW };

test("an operator-signed mandate verifies under its pinned issuer", () => {
  const mandate = issueMandate(base());
  const result = verifyMandate(mandate, trusted);
  assert.equal(result.ok, true);
  assert.equal(result.mandate.issuer, operator.publicKey);
  assert.equal(result.expiresAtMs, NOW + 30 * 86_400_000);
  assert.match(mandate.mandateId, /^mnd_[0-9a-f]{32}$/);
});

test("a mandate survives a JSON round trip with reordered keys", () => {
  const mandate = issueMandate(base());
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(mandate))).reverse());
  assert.equal(verifyMandate(reordered, trusted).ok, true);
});

test("an issuer the runtime was not told to trust is refused", () => {
  const mandate = issueMandate(base());
  const none = verifyMandate(mandate, { now: NOW });
  assert.deepEqual([none.ok, none.code], [false, "mandate_issuer_untrusted"]);
  const other = verifyMandate(mandate, { trustedIssuers: [agent.publicKey], now: NOW });
  assert.deepEqual([other.ok, other.code], [false, "mandate_issuer_untrusted"]);
});

test("a self-signed mandate needs the runtime to hold the agent key", () => {
  const mandate = issueMandate(base({ issuerMode: "self-mandated", issuerKey: agent, agent: undefined }));
  assert.equal(mandate.issuer, mandate.agent);
  assert.equal(verifyMandate(mandate, { heldAgentKey: agent.publicKey, now: NOW }).ok, true);
  const notHeld = verifyMandate(mandate, { now: NOW });
  assert.deepEqual([notHeld.ok, notHeld.code], [false, "mandate_issuer_untrusted"]);
  // Listing the agent's own key as a trusted issuer is not the same as holding it.
  const wrongKey = verifyMandate(mandate, { heldAgentKey: operator.publicKey, now: NOW });
  assert.deepEqual([wrongKey.ok, wrongKey.code], [false, "mandate_issuer_untrusted"]);
});

test("every edit to a signed mandate breaks its signature", () => {
  const mandate = issueMandate(base({ blockedCounterparties: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] }));
  const edits = [
    (m) => (m.limits.dailyCeilingUsd = "500.00"),
    (m) => (m.limits.maxPerCallUsd = "0.11"),
    (m) => (m.minTrustScore = 0),
    (m) => m.allowedTools.push("http:evil.example"),
    (m) => m.allowedChains.push("base"),
    (m) => delete m.blockedCounterparties,
    (m) => (m.expiresAt = "2027-06-01T00:00:00Z"),
    (m) => (m.requireV7Receipt = !m.requireV7Receipt),
    (m) => (m.killswitchDir = "/tmp/elsewhere"),
    (m) => (m.agent = operator.publicKey),
  ];
  for (const edit of edits) {
    const copy = JSON.parse(JSON.stringify(mandate));
    edit(copy);
    const result = verifyMandate(copy, trusted);
    assert.equal(result.ok, false, `edit accepted: ${edit}`);
    // An edit that also breaks a structural rule is caught there first; either way it is refused.
    assert.ok(["mandate_signature_invalid", "mandate_malformed"].includes(result.code), `${edit}: ${result.code}`);
  }
});

test("a signature from a different key over the same body is refused", () => {
  const mandate = issueMandate(base());
  const { signature, ...body } = mandate;
  // The library will not sign a body for an issuer whose key it does not hold.
  assert.throws(() => signMandateBody(body, agent), /not the mandate's issuer/);
  // Signed by hand with the agent key, naming the operator as signer: the signature does not verify.
  const other = signMandateBody({ ...body, issuer: agent.publicKey, issuerMode: "self-mandated" }, agent);
  const swapped = { ...mandate, signature: { ...signature, value: other.signature.value } };
  assert.equal(verifyMandate(swapped, trusted).code, "mandate_signature_invalid");
  // Naming the agent as the signer of an operator's body is refused before the signature is looked at.
  const renamed = { ...mandate, signature: { ...other.signature } };
  assert.equal(verifyMandate(renamed, { trustedIssuers: [operator.publicKey, agent.publicKey], now: NOW }).ok, false);
});

test("unsigned, malformed and non-canonical documents fail closed", () => {
  const mandate = issueMandate(base());
  const { signature, ...unsigned } = mandate;
  assert.equal(verifyMandate(unsigned, trusted).code, "mandate_unsigned");
  for (const bad of [null, undefined, 7, "mandate", [], {}, { schema: "twzrd.mandate.v1" }]) {
    const result = verifyMandate(bad, trusted);
    assert.equal(result.ok, false);
    assert.ok(["mandate_malformed", "mandate_unsigned"].includes(result.code), `${JSON.stringify(bad)}: ${result.code}`);
  }
  assert.equal(verifyMandate({ ...mandate, extra: 1 }, trusted).code, "mandate_malformed");
  assert.equal(verifyMandate({ ...mandate, schema: "twzrd.mandate.v2" }, trusted).code, "mandate_malformed");
  // base64 with the padding dropped decodes loosely to the same bytes; it is still refused.
  const loose = { ...mandate, signature: { ...signature, value: signature.value.replace(/=+$/, "") } };
  assert.equal(verifyMandate(loose, trusted).ok, false);
});

test("expired and not-yet-valid mandates are refused", () => {
  const mandate = issueMandate(base({ lifetimeMs: 3_600_000 }));
  assert.equal(verifyMandate(mandate, { ...trusted, now: NOW + 3_599_000 }).ok, true);
  assert.equal(verifyMandate(mandate, { ...trusted, now: NOW + 3_600_000 }).code, "mandate_expired");
  assert.equal(verifyMandate(mandate, { ...trusted, now: NOW - 301_000 }).code, "mandate_not_yet_valid");
  assert.equal(verifyMandate(mandate, { ...trusted, now: NOW - 299_000 }).ok, true);
});

test("the issuer cannot write a mandate the rules forbid", () => {
  const refused = [
    { maxPerCallUsd: "6.00" }, // per call over the daily ceiling
    { hourlyCeilingUsd: "6.00" }, // hourly over daily
    { hourlyCeilingUsd: "0.05" }, // hourly under per call
    { monthlyCeilingUsd: "1.00" }, // monthly under daily
    { dailyCeilingUsd: "0" },
    { dailyCeilingUsd: "5" + ".0000001" },
    { dailyCeilingUsd: "-1" },
    { dailyCeilingUsd: "1e3" },
    { allowedChains: [] },
    { allowedChains: ["tempo"] },
    { minTrustScore: 101 },
    { minTrustScore: 7.5 },
    { allowedTools: [] },
    { allowedTools: ["*"] },
    { allowedTools: ["has space"] },
    { requireMerkleInclusion: true }, // inclusion without a receipt
    { allowedCounterparties: ["not-an-address"] },
    { allowedCounterparties: ["GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs"], blockedCounterparties: ["GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs"] },
    { lifetimeMs: 367 * 86_400_000 },
    { issuerMode: "ephemeral-session", task: "x", lifetimeMs: 25 * 3_600_000 },
    { issuerMode: "ephemeral-session" }, // a session with no task
  ];
  for (const extra of refused) {
    assert.throws(() => issueMandate(base(extra)), /cannot issue|names the agent/, JSON.stringify(extra));
  }
  // And the same documents are refused when someone else signs them.
  const good = issueMandate(base());
  const { signature, ...body } = good;
  const overCap = signMandateBody({ ...body, limits: { maxPerCallUsd: "6.00", dailyCeilingUsd: "5.00" } }, operator);
  assert.equal(verifyMandate(overCap, trusted).code, "mandate_malformed");
});

test("a session mandate carries its task and a short life", () => {
  const mandate = issueMandate(base({ issuerMode: "ephemeral-session", issuerKey: agent, agent: undefined, task: "summarise one report", lifetimeMs: 3_600_000 }));
  const result = verifyMandate(mandate, { heldAgentKey: agent.publicKey, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.mandate.task, "summarise one report");
});

test("limits default the hourly ceiling to the daily one", () => {
  const limits = mandateLimitsMicro(issueMandate(base()));
  assert.deepEqual([limits.perCall, limits.hourly, limits.daily, limits.monthly], [100_000n, 5_000_000n, 5_000_000n, null]);
  assert.equal(usdToMicro("0.000001"), 1n);
  assert.equal(usdToMicro("01.00"), null);
  assert.equal(usdToMicro(5), null);
  assert.equal(microToUsd(1_234_500n), "1.2345");
});

test("mandate and key files: written once, read back, state dir resolved beside the mandate", () => {
  const dir = tempDir();
  const keyFile = path.join(dir, "agent.json");
  const key = generateKeyFile(keyFile);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(loadKeyFile(keyFile).publicKey, key.publicKey);
  assert.throws(() => generateKeyFile(keyFile));
  const mandate = issueMandate(base({ issuerMode: "self-mandated", issuerKey: key, agent: undefined }));
  const file = path.join(dir, "mandate.json");
  writeMandateFile(file, mandate);
  assert.throws(() => writeMandateFile(file, mandate));
  const loaded = loadMandateFile(file, { heldAgentKey: key.publicKey, now: NOW });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.stateDir, path.join(dir, ".twzrd-mandate"));
  fs.writeFileSync(file, "{not json");
  assert.equal(loadMandateFile(file, { heldAgentKey: key.publicKey }).code, "mandate_malformed");
  assert.equal(loadMandateFile(path.join(dir, "absent.json")).code, "mandate_malformed");
  // A key file whose public half does not match its secret half is refused.
  const bytes = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  bytes[40] = (bytes[40] + 1) % 256;
  fs.writeFileSync(keyFile, JSON.stringify(bytes));
  assert.throws(() => loadKeyFile(keyFile));
});

test("the published JSON Schema is well formed and matches a real mandate's shape", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schema/twzrd.mandate.v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id.includes("#"), false, "$id must not carry a fragment");
  assert.equal(schema.additionalProperties, false);
  const mandate = issueMandate(base({ monthlyCeilingUsd: "50.00", hourlyCeilingUsd: "1.00" }));
  for (const key of Object.keys(mandate)) assert.ok(key in schema.properties, `schema lacks ${key}`);
  for (const key of schema.required) assert.ok(key in mandate, `mandate lacks required ${key}`);
  assert.match(mandate.signature.value, new RegExp(schema.properties.signature.properties.value.pattern));
  assert.equal(parseMandate(mandate).ok, true);
});
