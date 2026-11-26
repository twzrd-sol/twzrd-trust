// Shared rig for the mandate tests: a loopback world, a willing payer, and a
// runtime under a freshly issued mandate. Nothing here leaves 127.0.0.1.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLoopbackPayer,
  createMandateRuntime,
  issueMandate,
  keyFromSeed,
  loopbackOnlyFetch,
  startLoopbackWorld,
  verifyMandate,
} from "../dist/index.js";

/** The gate and the guard read these from the environment; a test must not inherit them. */
export function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^(TWZRD_|KILLSWITCH_)/.test(key) && key !== "TWZRD_INTERNAL_CALLER") delete process.env[key];
  }
}

export function tempDir(prefix = "twzrd-mandate-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a rig. `mandate` overrides the issued mandate's fields; `runtime`
 * overrides runtime options; `payer: false` starts the runtime with no payer.
 */
export async function makeRig(opts = {}) {
  cleanEnv();
  const payer = createLoopbackPayer();
  const world = await startLoopbackWorld(payer.publicKey);
  const stateDir = opts.stateDir ?? tempDir();
  const agentKey = opts.agentKey ?? keyFromSeed(crypto.randomBytes(32));
  const clock = { now: opts.now ?? Date.now() };
  const tool = `http:127.0.0.1:${new URL(world.base).port}`;
  try {
    return await build();
  } catch (err) {
    await world.close();
    throw err;
  }
  async function build() {
  const mandate = issueMandate({
    issuerMode: "self-mandated",
    issuerKey: agentKey,
    maxPerCallUsd: "0.05",
    dailyCeilingUsd: "1.00",
    allowedChains: ["solana"],
    minTrustScore: 75,
    allowedTools: [tool, "mcp:paid_lookup", "mcp:echo", "inference"],
    requireV7Receipt: true,
    requireMerkleInclusion: true,
    killswitchDir: stateDir,
    lifetimeMs: 3_600_000,
    now: clock.now,
    ...(opts.mandate ?? {}),
  });
  const verified = verifyMandate(mandate, { heldAgentKey: agentKey.publicKey, now: clock.now });
  if (!verified.ok) throw new Error(`rig: mandate did not verify: ${verified.code} ${verified.detail}`);
  const guard = loopbackOnlyFetch();
  const runtime = createMandateRuntime({
    mandate: verified.mandate,
    expiresAtMs: verified.expiresAtMs,
    stateDir,
    intelBase: world.intelBase,
    fetch: guard.fetch,
    agentKey,
    now: () => clock.now,
    // The loopback seller serves one fixed, signed fixture receipt on every paid call.
    receiptMaxAgeSeconds: null,
    refuseReceiptReplay: false,
    ...(opts.payer === false ? {} : { wrapPay: payer.wrapPay }),
    ...(opts.runtime ?? {}),
  });
  return {
    world,
    payer,
    runtime,
    stateDir,
    agentKey,
    clock,
    tool,
    guard,
    mandate: verified.mandate,
    expiresAtMs: verified.expiresAtMs,
    // Each buy is its own purchase (a fresh Idempotency-Key), so tests of other
    // layers are not refused as duplicates. Pass `headers` to choose the key.
    buy: (name, extra = {}) =>
      runtime.call({ tool, url: world.url(name), ...extra, headers: extra.headers ?? { "idempotency-key": crypto.randomUUID() } }),
    async close() {
      runtime.close();
      await world.close();
    },
  };
  }
}

export function bodyJson(result) {
  return JSON.parse(Buffer.from(result.body).toString("utf8"));
}
