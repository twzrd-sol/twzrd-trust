#!/usr/bin/env node
/**
 * TWZRD MCP drop-in demo.
 *
 * Default path is free and read-only:
 *   npm run build
 *   npm run demo
 *
 * Operator-authorized paid proof (spends exactly one capped x402 call):
 *   TWZRD_DEMO_PAID=quick \
 *   TWZRD_WALLET_SECRET_KEY=<base58-solana-secret> \
 *   TWZRD_RPC_URL=<mainnet-rpc> \
 *   TWZRD_MAX_USDC_PER_CALL=0.001 \
 *   TWZRD_MAX_USDC_TOTAL=0.001 \
 *   node examples/agent-drop-in.mjs
 *
 * Full receipt path (costs 0.05 USDC, verifies receipt if one is returned):
 *   TWZRD_DEMO_PAID=full TWZRD_MAX_USDC_PER_CALL=0.05 TWZRD_MAX_USDC_TOTAL=0.05 ...
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.env.TWZRD_MCP_SERVER_PATH || path.resolve(__dirname, "../dist/index.js");
const demoWallet =
  process.env.TWZRD_DEMO_WALLET || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const paidMode = (process.env.TWZRD_DEMO_PAID || "off").toLowerCase();

if (!["off", "quick", "full"].includes(paidMode)) {
  throw new Error("TWZRD_DEMO_PAID must be one of: off, quick, full");
}

const childEnv = { ...process.env };
if (paidMode === "off" && childEnv.TWZRD_MCP_PAYMENTS_ENABLED === undefined) {
  // Free demo should stay free even if the shell happens to have a wallet secret.
  childEnv.TWZRD_MCP_PAYMENTS_ENABLED = "0";
}
if (paidMode !== "off") {
  if (!childEnv.TWZRD_WALLET_SECRET_KEY) {
    throw new Error("Paid demo requires TWZRD_WALLET_SECRET_KEY (base58 Solana secret)");
  }
  childEnv.TWZRD_MAX_USDC_PER_CALL ||= paidMode === "quick" ? "0.001" : "0.05";
  childEnv.TWZRD_MAX_USDC_TOTAL ||= childEnv.TWZRD_MAX_USDC_PER_CALL;
}

const child = spawn(process.execPath, [serverPath], {
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdoutBuffer = "";
const pending = new Map();

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[twzrd-mcp] ${chunk}`);
});

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  parseFrames();
});

child.on("exit", (code, signal) => {
  const err = new Error(`MCP server exited code=${code} signal=${signal}`);
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
});

function parseFrames() {
  for (;;) {
    const lineEnd = stdoutBuffer.indexOf("\n");
    if (lineEnd < 0) return;

    const line = stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
    if (!line.trim()) continue;

    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
}

function send(message) {
  const body = JSON.stringify(message);
  child.stdin.write(`${body}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
  });
}

function notify(method, params = {}) {
  send({ jsonrpc: "2.0", method, params });
}

function textFromTool(result) {
  return result?.content?.find((part) => part.type === "text")?.text || "";
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function printSection(title, value) {
  console.log(`\n== ${title} ==`);
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "twzrd-agent-drop-in", version: "0.1.0" },
  });
  notify("notifications/initialized");
  printSection("server", init.serverInfo);

  const tools = await request("tools/list", {});
  printSection(
    "tools",
    tools.tools.map((tool) => `${tool.name}: ${tool.description}`),
  );

  const preflight = await request("tools/call", {
    name: "preflight",
    arguments: {
      seller_wallet: demoWallet,
      resource_name: "agent-drop-in-demo",
      price_usdc: paidMode === "quick" ? 0.001 : 0.05,
    },
  });
  printSection("free preflight", parseJsonText(textFromTool(preflight)) || textFromTool(preflight));

  if (paidMode === "quick") {
    const quick = await request("tools/call", {
      name: "quick_trust",
      arguments: { wallet: demoWallet },
    });
    printSection("paid quick_trust", parseJsonText(textFromTool(quick)) || textFromTool(quick));
  }

  if (paidMode === "full") {
    const full = await request("tools/call", {
      name: "full_trust",
      arguments: { wallet: demoWallet },
    });
    const body = parseJsonText(textFromTool(full)) || {};
    printSection("paid full_trust", body || textFromTool(full));

    const receipt = body.twzrd_receipt || body.receipt;
    if (receipt?.leaf) {
      printSection("receipt", {
        leaf: receipt.leaf,
        signature: receipt.signature,
        signing_pubkey: receipt.signing_pubkey,
        settlement_tx: receipt.preimage?.settlement_tx || body.settlement_tx,
      });
      const verified = await request("tools/call", {
        name: "verify_receipt",
        arguments: {
          leaf: receipt.leaf,
          signature: receipt.signature,
          signing_pubkey: receipt.signing_pubkey,
        },
      });
      printSection("receipt verification", parseJsonText(textFromTool(verified)) || textFromTool(verified));

      if (process.env.TWZRD_DEMO_RUN_VERIFIER_SELF_TEST === "1") {
        console.log("\n== receipt-verifier self-test ==");
        const verifier = spawnSync(
          "npx",
          ["-y", "twzrd-receipt-verifier@1.2.0", "-", "--self-test"],
          { input: JSON.stringify(receipt), stdio: ["pipe", "inherit", "inherit"] },
        );
        if (verifier.status !== 0) {
          throw new Error(`twzrd-receipt-verifier self-test exited ${verifier.status}`);
        }
      }
    } else {
      console.log("\nNo receipt object returned, so receipt verification was skipped.");
    }
  }

  console.log(`\nDemo complete. paid_mode=${paidMode}`);
}

main()
  .catch((err) => {
    console.error(`\nDemo failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
  });
