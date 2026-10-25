import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { x402Version } from "@x402/core";
import type { PaymentRequired, SchemeNetworkClient } from "@x402/core/types";
import { x402Client } from "@x402/fetch";
import {
  createGuardedX402Fetch,
  decideHeldVaultSpend,
  SETTLEMENT_USDC_MINT,
  VAULT_PROGRAM_ID,
  type HeldVaultSpendCopy,
} from "../src/guarded-x402-fetch.js";
import { PAYMENT_DECISION_SCHEMA } from "../src/payment-decision.js";

const SELLER = "sLJ4uneGcD1mg6hKtkLYsY5HCw1nJ8GpNAmbzBWPBgk";
const OTHER = "4Gndn4YtDfh3UBG8yVJeD8vU9ugG3X1n4vS4xbx7sNqG";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function challenge(amount: string, payTo = SELLER, asset = USDC): PaymentRequired {
  return {
    x402Version,
    resource: { url: "https://merchant.example/paid" },
    accepts: [{ scheme: "exact", network: NETWORK, asset, amount, payTo, maxTimeoutSeconds: 60, extra: {} }],
  };
}

function clientFor(onSign: () => void) {
  // Keep this compatible with x402/core releases whose public config type
  // predates spendControls while disabling the newer default in local tests.
  const config = { schemes: [], spendControls: false as const };
  const client = x402Client.fromConfig(config);
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    async createPaymentPayload() {
      onSign();
      throw new Error("fake-signer-stop");
    },
  };
  client.register(NETWORK, scheme);
  return client;
}

async function fire(client: x402Client, payment: PaymentRequired) {
  return client.createPaymentPayload(payment);
}

async function main() {
  const previousSwitch = process.env.TWZRD_GATE_ENABLED;
  process.env.TWZRD_GATE_ENABLED = "false";
  try {
    // Per-call ceiling blocks before the registered payment scheme is invoked.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, maxPricePerCall: "0.05" });
      await assert.rejects(fire(client, challenge("50001")), /price_cap_exceeded/);
      assert.equal(signs, 0);
    }

    // An explicit recipient allowlist is applied to the selected requirement.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, allowedRecipients: [SELLER] });
      await assert.rejects(fire(client, challenge("1000", OTHER)), /unauthorized_recipient/);
      assert.equal(signs, 0);
    }

    // The hourly reservation includes signer failures and prevents concurrent
    // calls from both passing against the same remaining balance.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, hourlyBudgetCap: "0.05" });
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      await assert.rejects(fire(client, challenge("30000")), /hourly_budget_exceeded/);
      assert.equal(signs, 1);
    }

    // Budget entries expire after 60 minutes.
    {
      let clock = 100_000;
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.03",
        now: () => clock,
      });
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      clock += 60 * 60 * 1000 + 1;
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      assert.equal(signs, 2);
    }

    // Concurrent calls reserve budget before the asynchronous TWZRD lookup.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      let releaseGate!: () => void;
      let announceGate!: () => void;
      const gateStarted = new Promise<void>((resolve) => { announceGate = resolve; });
      const gateHold = new Promise<void>((resolve) => { releaseGate = resolve; });
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.05",
        twzrd: {
          gateOnCanSpend: false,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            announceGate();
            await gateHold;
            return new Response(JSON.stringify({
              readiness_card: { decision: "allow", can_spend: true, trust_score: 90, seller_wallet: SELLER },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      const first = fire(client, challenge("30000")).catch((error: unknown) => error);
      await gateStarted;
      await assert.rejects(fire(client, challenge("30000")), /hourly_budget_exceeded/);
      releaseGate();
      const firstError = await first;
      assert.match(String((firstError as Error).message), /fake-signer-stop/);
      assert.equal(gateCalls, 1);
      assert.equal(signs, 1);
      process.env.TWZRD_GATE_ENABLED = "false";
    }

    // A TWZRD hook refusal releases its pending reservation and does not
    // commit the amount to the rolling spend ledger.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        hourlyBudgetCap: "0.03",
        twzrd: {
          gateOnCanSpend: true,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            const blocked = gateCalls === 1;
            return new Response(JSON.stringify({
              readiness_card: {
                decision: blocked ? "block" : "allow",
                can_spend: !blocked,
                trust_score: blocked ? 1 : 90,
                seller_wallet: SELLER,
              },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      await assert.rejects(fire(client, challenge("30000")), /twzrd_decision_block|twzrd_can_spend_false/);
      await assert.rejects(fire(client, challenge("30000")), /fake-signer-stop/);
      assert.equal(gateCalls, 2);
      assert.equal(signs, 1);
      process.env.TWZRD_GATE_ENABLED = "false";
    }

    // Caps refuse unknown token identities instead of treating every six-
    // decimal token as USDC.
    {
      let signs = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({ client, maxPricePerCall: "0.05" });
      await assert.rejects(fire(client, challenge("1000", SELLER, "not-usdc")), /unsupported_or_non_usdc_asset/);
      assert.equal(signs, 0);
    }

    // The existing TWZRD evaluator runs after local rules and before signing.
    {
      delete process.env.TWZRD_GATE_ENABLED;
      let signs = 0;
      let gateCalls = 0;
      const client = clientFor(() => signs++);
      createGuardedX402Fetch({
        client,
        twzrd: {
          gateOnCanSpend: true,
          refuseWashFlagged: false,
          fetch: (async () => {
            gateCalls++;
            return new Response(JSON.stringify({
              readiness_card: { decision: "block", can_spend: false, trust_score: 1, seller_wallet: SELLER },
            }), { status: 200, headers: { "content-type": "application/json" } });
          }) as typeof fetch,
        },
      });
      await assert.rejects(fire(client, challenge("1000")), /twzrd_decision_block|twzrd_can_spend_false/);
      assert.equal(gateCalls > 0, true);
      assert.equal(signs, 0);
    }
  } finally {
    if (previousSwitch === undefined) delete process.env.TWZRD_GATE_ENABLED;
    else process.env.TWZRD_GATE_ENABLED = previousSwitch;
  }

  await heldVaultSpendProof();

  console.log("guarded-x402-fetch: OK");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(text: string): Buffer {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = B58.indexOf(text[i]!);
    if (value < 0) throw new Error("base58");
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i]!;
  return out;
}

function b58encode(raw: Buffer): string {
  let zeros = 0;
  while (zeros < raw.length && raw[zeros] === 0) zeros += 1;
  const digits = [0];
  for (const byte of raw) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

function shortvec(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  return Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
}

function signedVaultSpend(privateKey: KeyObject, deskRaw: Buffer): { tx: Buffer; instruction: Buffer } {
  const disc = createHash("sha256").update("global:spend_with_policy").digest().subarray(0, 8);
  const instruction = Buffer.alloc(49);
  disc.copy(instruction, 0);
  instruction.writeBigUInt64LE(1_000n, 8);
  instruction[16] = 0;
  Buffer.alloc(32, 7).copy(instruction, 17);
  const keys = [
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    deskRaw,
    Buffer.alloc(32, 4),
    Buffer.alloc(32, 5),
    Buffer.alloc(32, 6),
    b58decode(SETTLEMENT_USDC_MINT),
    Buffer.alloc(32, 8),
    b58decode(VAULT_PROGRAM_ID),
  ];
  const message = Buffer.concat([
    Buffer.from([3, 2, 3]),
    shortvec(keys.length),
    Buffer.concat(keys),
    Buffer.alloc(32, 9),
    shortvec(1),
    Buffer.from([8]),
    shortvec(7),
    Buffer.from([3, 4, 5, 6, 1, 2, 7]),
    shortvec(instruction.length),
    instruction,
  ]);
  const deskSig = sign(null, message, privateKey);
  const tx = Buffer.concat([
    shortvec(3),
    Buffer.alloc(64),
    Buffer.alloc(64),
    deskSig,
    message,
  ]);
  return { tx, instruction };
}

async function heldVaultSpendProof() {
  assert.equal(PAYMENT_DECISION_SCHEMA, "twzrd.payment_decision.v1");
  const gateSrc = readFileSync(new URL("../src/guarded-x402-fetch.ts", import.meta.url), "utf8");
  const decisionSrc = readFileSync(new URL("../src/payment-decision.ts", import.meta.url), "utf8");
  assert.match(gateSrc, /not the exclusive signer/);
  assert.match(decisionSrc, /does not move\s+USDC/);
  assert.doesNotMatch(gateSrc, /exclusive signer of the vault/);
  assert.equal(decisionSrc.includes('export const PAYMENT_DECISION_SCHEMA = "twzrd.payment_decision.v1"'), true);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deskRaw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const { tx, instruction } = signedVaultSpend(privateKey, deskRaw);
  const nowTs = 1_800_000_000;
  const base = (): HeldVaultSpendCopy => ({
    serializedTransaction: tx.toString("base64"),
    demandDeskPubkey: b58encode(deskRaw),
    expiresAtTs: nowTs + 30,
    nowTs,
    boundInstructionHex: instruction.toString("hex"),
  });

  const original = net.Socket.prototype.connect;
  let rpc_sockets_opened = 0;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    rpc_sockets_opened += 1;
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  };

  const check = async (name: string, copy: HeldVaultSpendCopy, reason: string) => {
    const before = rpc_sockets_opened;
    const verdict = decideHeldVaultSpend(copy);
    assert.equal(verdict.refused, true, name);
    assert.equal(verdict.reason, reason, name);
    assert.equal(verdict.rpc_sockets_opened, 0, name);
    const client = clientFor(() => {});
    const guarded = createGuardedX402Fetch({
      client,
      heldVaultSpend: copy,
      fetch: async () => {
        throw new Error("transport opened");
      },
    });
    await assert.rejects(guarded("https://merchant.example/paid"), new RegExp(reason), name);
    assert.equal(rpc_sockets_opened, before, name);
    console.log(`HELD_VAULT\t${name}\t${reason}\trpc_sockets_opened=0`);
  };

  try {
    const missing = base();
    const missingTx = Buffer.from(missing.serializedTransaction, "base64");
    missingTx.fill(0, 1 + 128, 1 + 192);
    missing.serializedTransaction = missingTx.toString("base64");
    await check("missing_signature", missing, "missing_demand_desk_signature");

    const forged = base();
    const forgedTx = Buffer.from(forged.serializedTransaction, "base64");
    forgedTx.fill(0x11, 1 + 128, 1 + 192);
    forged.serializedTransaction = forgedTx.toString("base64");
    await check("forged_signature", forged, "forged_demand_desk_signature");

    const flipped = base();
    const flippedTx = Buffer.from(flipped.serializedTransaction, "base64");
    flippedTx[flippedTx.length - 1] ^= 0xff;
    flipped.serializedTransaction = flippedTx.toString("base64");
    await check("one_byte_instruction", flipped, "instruction_bytes_differ");

    const expired = base();
    expired.nowTs = expired.expiresAtTs;
    await check("expired_authorization", expired, "authorization_expired");

    const advisory = base();
    const advisoryTx = Buffer.from(advisory.serializedTransaction, "base64");
    advisoryTx.fill(0, 1 + 128, 1 + 192);
    advisory.serializedTransaction = advisoryTx.toString("base64");
    advisory.advisoryPaymentDecision = { schema: PAYMENT_DECISION_SCHEMA, decision: "allow" };
    await check("advisory_payment_decision", advisory, "advisory_payment_decision_does_not_move_usdc");

    const before = rpc_sockets_opened;
    const allowed = decideHeldVaultSpend(base());
    assert.equal(allowed.refused, false);
    assert.equal(allowed.rpc_sockets_opened, 0);
    assert.equal(rpc_sockets_opened, before);
    console.log("HELD_VAULT\tdesk_signature_present\trpc_sockets_opened=0");
  } finally {
    net.Socket.prototype.connect = original;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
