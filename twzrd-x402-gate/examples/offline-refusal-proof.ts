/** Machine-readable proof over real installed clients and synthetic Solana state. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveInstalledPackageVersion } from "../src/block-proof.js";
import { CLIENT_VERSION } from "../src/version.js";
import {
  runForeignClientProof, verifyForeignClientProof, verifyNegativeControl, verifyPostApprovalTamper,
  MAINNET_ASSET, MAINNET_NETWORK,
  type ProofRun, type ProofClient, type Check,
} from "./foreign-client-proof.js";

export const SCHEMA = "twzrd.offline_refusal_proof.v1";
type Case = "block" | "clean_control" | "gate_absent" | "post_approval_tamper";
type NetworkGuard = { enabled: boolean; deniedCount(): number };
type Matrix = {
  gate_version: string;
  node_majors: number[];
  packages: Record<string, string>;
  clients: Record<ProofClient, string>;
};

export function verifyMainnetRun(run: ProofRun, checks: Check[]): Check[] {
  const sends = run.rpcMethods.filter(method => /^(sendTransaction|sendRawTransaction)$/.test(method));
  return [
    ...checks,
    { name: "fixture/mainnet_usdc", ok: run.requirement.network === MAINNET_NETWORK && run.requirement.asset === MAINNET_ASSET, detail: run.requirement.network },
    { name: "fixture/no_broadcast_rpc", ok: sends.length === 0, detail: `broadcastRequests=${sends.length}` },
    { name: "fixture/known_rpc_methods", ok: run.rpcMethods.every(method => ["getAccountInfo", "getLatestBlockhash"].includes(method)), detail: run.rpcMethods.join(",") },
  ];
}

function transcript(run: ProofRun, name: Case, matrix: Matrix) {
  const checks = verifyMainnetRun(run, name === "gate_absent" ? verifyNegativeControl(run)
    : name === "post_approval_tamper" ? verifyPostApprovalTamper(run) : verifyForeignClientProof(run));
  const decision = run.decisions.at(-1);
  if (name === "block") checks.push({
    name: "block/explicit_seller_policy", ok: decision?.verdict === "block" && /twzrd_decision_block/.test(decision.reason), detail: decision?.reason ?? "no gate decision",
  });
  return {
    client: run.client,
    hook: matrix.clients[run.client],
    case: name,
    selected_requirement: { ...run.requirement, resource: run.resource },
    decision: decision?.verdict ?? null,
    approved: decision?.approved ?? null,
    reason: decision?.reason ?? null,
    signer_invocation_count: run.signerInvocations,
    transaction_broadcast_count: run.rpcMethods.filter(method => /^(sendTransaction|sendRawTransaction)$/.test(method)).length,
    payment_retry_count: run.originSignedRequests,
    simulated_settlement_count: run.status === 200 ? run.originSignedRequests : 0,
    usdc_spent: 0,
    signer_calls: run.signerCalls,
    rpc_methods: run.rpcMethods,
    observed_error: run.error,
    checks,
    verified: checks.every(check => check.ok),
  };
}

export async function runOfflineRefusalProof() {
  const guard = (globalThis as Record<symbol, NetworkGuard | undefined>)[Symbol.for("twzrd.offline.network")];
  if (!guard?.enabled) throw new Error("Run with --require ./scripts/offline-network-guard.cjs; offline guard is required");
  const matrix = JSON.parse(readFileSync(new URL("../proof-compatibility.json", import.meta.url), "utf8")) as Matrix;
  if (!matrix.node_majors.includes(Number(process.versions.node.split(".")[0]))) {
    throw new Error(`Unsupported proof runtime: Node ${process.versions.node}; matrix supports ${matrix.node_majors.join(", ")}`);
  }
  if (matrix.gate_version !== CLIENT_VERSION) throw new Error(`Compatibility drift: gate ${CLIENT_VERSION} != matrix ${matrix.gate_version}`);
  const packages: Record<string, string> = {};
  for (const [name, expected] of Object.entries(matrix.packages)) {
    const actual = resolveInstalledPackageVersion(name, import.meta.url);
    if (actual !== expected) throw new Error(`Compatibility drift: ${name}@${actual} != tested ${expected}; rerun and update the matrix deliberately`);
    packages[name] = actual;
  }
  const runs = [];
  for (const client of ["official", "x402-solana"] as const) {
    for (const [kind, name] of [["refuse", "block"], ["allow", "clean_control"]] as const) {
      runs.push(transcript(await runForeignClientProof(kind, { client, fixtureProfile: "mainnet" }), name, matrix));
    }
    runs.push(transcript(await runForeignClientProof("refuse", { client, fixtureProfile: "mainnet", installGate: false }), "gate_absent", matrix));
  }
  runs.push(transcript(await runForeignClientProof("allow", { fixtureProfile: "mainnet", tamperAfterGate: true }), "post_approval_tamper", matrix));
  const denied = guard.deniedCount();
  return {
    schema: SCHEMA,
    mode: "offline_fixture",
    external_adoption: false,
    gate_version: CLIENT_VERSION,
    node_version: process.versions.node,
    packages,
    network_guard: { enabled: true, denied_egress_attempt_count: denied },
    settlement: "simulated_only",
    runs,
    verified: denied === 0 && runs.every(run => run.verified),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const report = await runOfflineRefusalProof();
    console.log(JSON.stringify(report, null, 2));
    if (!report.verified) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
