#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createLocalDecisionSigner } from "../src/decision-token.js";
import { TwzrdWashAbortError } from "../src/paying-fetch.js";
import { createTwzrdPolicyFetch, TwzrdPolicyAbortError } from "../src/policy-fetch.js";
import { createFileSpendLedger } from "../src/spend-ledger-file.js";
import {
  assertHttpsTarget,
  assertNotHousePayerKey,
  ForeignPayerInputError,
  HousePayerKeyError,
  requireForeignPayerInput,
} from "../src/foreign-key.js";

const die = (code: number, err: unknown) => {
  const m = err instanceof Error ? err.message : String(err);
  console.error(m.slice(0, 240));
  process.exit(code);
};

try {
  const input = requireForeignPayerInput(process.env, process.argv.slice(2));
  assertNotHousePayerKey(input.keyPath);
  const target = assertHttpsTarget(input.url);
  const client = new x402Client();
  client.register(
    "solana:*",
    new ExactSvmScheme(
      await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(input.keyPath, "utf8")))),
    ),
  );
  const fuse = createTwzrdPolicyFetch({
    signer: createLocalDecisionSigner({ keyId: "foreign-payer" }),
    ledger: createFileSpendLedger("./data/ledger.jsonl"),
    policy: { maxAmountUsd: input.maxUsd, dailyCeilingUsd: input.dailyUsd },
    wrapPay: (g) => wrapFetchWithPayment(g, client),
  });
  const r = await fuse(target.href, { redirect: "manual" });
  const text = await r.text();
  console.log(JSON.stringify({ ok: r.ok, status: r.status, n: text.length, head: text.slice(0, 240) }));
} catch (err) {
  if (err instanceof HousePayerKeyError || err instanceof ForeignPayerInputError) die(2, err);
  if (err instanceof TwzrdWashAbortError) {
    console.error("kind=wash");
    die(3, err);
  }
  if (err instanceof TwzrdPolicyAbortError) {
    console.error("kind=policy");
    die(3, err);
  }
  die(1, err);
}
