#!/usr/bin/env node
/**
 * The `mandate` command.
 *
 *   mandate init --daily 5.00 --min-trust 75        an operator-signed mandate
 *   mandate self-issue --agent-key ./agent.json --daily 2.00
 *   mandate session --agent-key ./agent.json --task "..." --daily 0.50
 *   mandate verify [mandate.json]
 *   mandate serve                                    the sidecar on 127.0.0.1:4029
 *   mandate mcp-stdio                                the MCP proxy over stdio
 *   mandate status | kill | resume | ledger
 *   mandate verify-breakers
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatBreakerReport, verifyBreakers } from "./breakers.js";
import { type MandateKey, loadKeyFile, loadOrCreateKeyFile } from "./keys.js";
import { verifyDecisionLedger } from "./ledger.js";
import { type IssueMandateInput, issueMandate, loadMandateFile, mandateStateDir, writeMandateFile } from "./mandate.js";
import { type McpGateway, createHttpUpstream, createMcpGateway, createStdioUpstream, runMcpStdio } from "./mcp-proxy.js";
import { type MandateRuntime, STATE_FILES, type WrapPay, createMandateRuntime } from "./runtime.js";
import { type IssuerMode, MANDATE_CHAINS, type MandateChain, MAX_LIFETIME_MS, MAX_SESSION_LIFETIME_MS, usdToMicro, microToUsd } from "./schema.js";
import { CONTROL_TOKEN_FILE, DEFAULT_HOST, DEFAULT_PORT, INFERENCE_TOOL, type InferenceMeter, startInferenceMeter, startSidecar } from "./server.js";
import { VERSION } from "./version.js";

/** What a mandate may call when --tools is not given: TWZRD's paid HTTP routes and its trust tools over MCP. */
const DEFAULT_TOOLS = [
  "http:intel.twzrd.xyz",
  "mcp:evaluate_x402_resource",
  "mcp:get_merchant_card",
  "mcp:get_readiness_card_tool",
  "mcp:verify_receipt",
] as const;

const HELP = `mandate ${VERSION}: a signed spend mandate for an agent, enforced before anything is signed

Issue
  mandate init --daily 5.00 --min-trust 75
      An operator-signed mandate. Creates ./operator.json and ./agent.json (keys, mode 0600)
      if they are missing, and writes ./mandate.json.
  mandate self-issue --agent-key ./agent.json --daily 2.00
      The agent signs its own mandate with its own key.
  mandate session --agent-key ./agent.json --task "what this session is for" --daily 0.50
      A short-lived mandate for one task (24 hours at most).

  Flags for all three:
    --daily <usd>            daily ceiling (required)
    --per-call <usd>         most one call may cost (default: the smaller of 0.10 and --daily)
    --hourly <usd>           hourly ceiling (default: the daily ceiling)
    --monthly <usd>          30-day ceiling (default: none)
    --min-trust <0-100>      lowest TWZRD trust score a seller may have (default 75)
    --chains solana,base     chains a payment may use (default solana)
    --tools a,b              tools the agent may call; no wildcard. Default: http:intel.twzrd.xyz and
                             the TWZRD trust tools over MCP (mcp:evaluate_x402_resource,
                             mcp:get_merchant_card, mcp:get_readiness_card_tool, mcp:verify_receipt)
    --allow-counterparty w   only these recipients may be paid (repeatable)
    --block-counterparty w   never pay these recipients (repeatable)
    --require-receipt        a paid answer must carry a V7 receipt that verifies under the pinned key
    --require-inclusion      and that receipt must be proven in the receipt log
    --expires 30d            lifetime: 45m, 12h, 30d (default 30d; a session 1h)
    --state-dir <dir>        where .kill, .pause and the ledgers live (default ./.twzrd-mandate)
    --out <file>             default ./mandate.json;  --force overwrites
    --agent-key <file>       the agent's key file    --operator-key <file>  the operator's key file
    --agent <pubkey>         (init) the agent's public key, when the operator does not hold its key

Check
  mandate verify [mandate.json] [--trust-issuer <pubkey>] [--agent-key <file>] [--allow-self-mandate]
  mandate verify-breakers [--json]
      Proves on this machine that each of the six pre-sign layers refuses with 0 signatures.

Run
  mandate serve [--mandate mandate.json] [--agent-key <file>] [--trust-issuer <pubkey>]
      --allow-self-mandate           accept a self-signed mandate even when issuers are pinned
      --receipt-max-age 900          oldest receipt accepted, in seconds ("off": loopback only)
      --allow-receipt-replay         accept a receipt already seen (loopback only)
      --port 4029                    loopback only
      --pay-module ./pay.mjs         a module exporting wrapPay(guardedFetch): the payer.
                                     Without one, every 402 is refused (no_payer_configured).
      --mcp-upstream <url>           the MCP server behind /mcp (Streamable HTTP)
      --mcp-upstream-cmd "<cmd>"     or a stdio MCP server to start and wrap
      --mcp-header "Name: value"     a header for the MCP upstream (repeatable)
      --upstream <base-url>          the OpenAI-compatible API behind /v1 (metered by agent-killswitch)
      --upstream-key-env <NAME>      the variable holding its API key (default OPENAI_API_KEY)
      --free-models a,b              models that cost nothing (a local model server)
      --model-rates <file.json>      per-model rates for the meter
      --intel-base <url>             the TWZRD trust service (default https://intel.twzrd.xyz)
      --heartbeat <seconds>          sign a heartbeat this often (needs --agent-key)
  mandate mcp-stdio --sidecar http://127.0.0.1:4029
      A stdio MCP server that bridges to a running sidecar's /mcp.
  mandate mcp-stdio [serve flags]
      Or the proxy itself over stdio, with no sidecar.

Operate
  mandate status | ledger [--limit 20] [--verify] | kill [--reason "..."] | resume
      --url http://127.0.0.1:4029    a running sidecar
      --mandate mandate.json         or the state directory of this mandate, read directly

Environment
  TWZRD_MANDATE_TRUSTED_ISSUERS   comma-separated issuer keys, as --trust-issuer
`;

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function parseLifetime(text: string, mode: IssuerMode): number {
  const match = /^([1-9][0-9]{0,4})(m|h|d)$/.exec(text);
  if (!match) fail(`--expires takes a lifetime such as 45m, 12h or 30d, not "${text}"`);
  const ms = Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  const max = mode === "ephemeral-session" ? MAX_SESSION_LIFETIME_MS : MAX_LIFETIME_MS;
  if (ms > max) fail(mode === "ephemeral-session" ? "a session mandate lasts 24 hours at most" : "a mandate lasts 366 days at most");
  return ms;
}

function usd(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const micro = usdToMicro(value);
  if (micro === null) fail(`--${flag} takes a USD amount such as 5.00, not "${value}"`);
  return value;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const ISSUE_OPTIONS = {
  daily: { type: "string" },
  "per-call": { type: "string" },
  hourly: { type: "string" },
  monthly: { type: "string" },
  "min-trust": { type: "string" },
  chains: { type: "string" },
  tools: { type: "string" },
  "allow-counterparty": { type: "string", multiple: true },
  "block-counterparty": { type: "string", multiple: true },
  "require-receipt": { type: "boolean" },
  "require-inclusion": { type: "boolean" },
  expires: { type: "string" },
  "state-dir": { type: "string" },
  out: { type: "string" },
  force: { type: "boolean" },
  "agent-key": { type: "string" },
  "operator-key": { type: "string" },
  agent: { type: "string" },
  task: { type: "string" },
} as const;

function issue(mode: IssuerMode, argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: ISSUE_OPTIONS, strict: true });
  const daily = usd("daily", values.daily) ?? fail("--daily <usd> is required: the most this agent may spend in a day");
  const dailyMicro = usdToMicro(daily) as bigint;
  const perCall = usd("per-call", values["per-call"]) ?? microToUsd(dailyMicro < 100_000n ? dailyMicro : 100_000n);
  const minTrust = values["min-trust"] === undefined ? 75 : Number(values["min-trust"]);
  if (!Number.isInteger(minTrust) || minTrust < 0 || minTrust > 100) fail("--min-trust takes a whole number from 0 to 100");
  const chains = (list(values.chains) ?? ["solana"]) as MandateChain[];
  for (const chain of chains) if (!MANDATE_CHAINS.includes(chain)) fail(`--chains takes solana and base, not "${chain}"`);
  const created: string[] = [];
  const keyAt = (file: string): MandateKey => {
    const got = loadOrCreateKeyFile(file);
    if (got.created) created.push(path.resolve(file));
    return got.key;
  };

  let issuerKey: MandateKey;
  let agent: string | undefined;
  let serveHint: string;
  const out = path.resolve(values.out ?? "mandate.json");
  if (mode === "human-operator") {
    issuerKey = keyAt(values["operator-key"] ?? "operator.json");
    if (values.agent !== undefined) {
      agent = values.agent;
      serveHint = `--trust-issuer ${issuerKey.publicKey}`;
    } else {
      const agentFile = values["agent-key"] ?? "agent.json";
      agent = keyAt(agentFile).publicKey;
      serveHint = `--agent-key ${agentFile} --trust-issuer ${issuerKey.publicKey}`;
    }
    if (agent === issuerKey.publicKey) fail("the operator key and the agent key are the same key; use self-issue for a self-signed mandate");
  } else {
    const agentFile = values["agent-key"] ?? fail("--agent-key <file> is required: the agent's own key signs this mandate");
    if (mode === "ephemeral-session" && values["operator-key"] !== undefined) {
      issuerKey = keyAt(values["operator-key"]);
      agent = keyAt(agentFile).publicKey;
      serveHint = `--agent-key ${agentFile} --trust-issuer ${issuerKey.publicKey}`;
    } else {
      issuerKey = keyAt(agentFile);
      agent = issuerKey.publicKey;
      serveHint = `--agent-key ${agentFile}`;
    }
  }
  if (mode === "ephemeral-session" && !values.task) fail('--task "<what this session is for>" is required for a session mandate');

  const input: IssueMandateInput = {
    issuerMode: mode,
    issuerKey,
    agent,
    maxPerCallUsd: perCall,
    dailyCeilingUsd: daily,
    allowedChains: chains,
    minTrustScore: minTrust,
    allowedTools: list(values.tools) ?? [...DEFAULT_TOOLS],
    requireV7Receipt: values["require-receipt"] === true || values["require-inclusion"] === true,
    requireMerkleInclusion: values["require-inclusion"] === true,
    killswitchDir: values["state-dir"] ?? ".twzrd-mandate",
    lifetimeMs: parseLifetime(values.expires ?? (mode === "ephemeral-session" ? "1h" : "30d"), mode),
  };
  const hourly = usd("hourly", values.hourly);
  const monthly = usd("monthly", values.monthly);
  if (hourly !== undefined) input.hourlyCeilingUsd = hourly;
  if (monthly !== undefined) input.monthlyCeilingUsd = monthly;
  if (values["allow-counterparty"]?.length) input.allowedCounterparties = values["allow-counterparty"];
  if (values["block-counterparty"]?.length) input.blockedCounterparties = values["block-counterparty"];
  if (values.task !== undefined) input.task = values.task;

  const mandate = issueMandate(input);
  try {
    writeMandateFile(out, mandate, { overwrite: values.force === true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") fail(`${out} already exists; pass --force to replace it, or --out <file>`);
    throw err;
  }
  const lines = [
    `wrote ${out}`,
    `  mandate   ${mandate.mandateId} (${mandate.issuerMode})`,
    `  issuer    ${mandate.issuer}`,
    `  agent     ${mandate.agent}`,
    `  limits    ${mandate.limits.maxPerCallUsd} USD a call, ${mandate.limits.hourlyCeilingUsd ?? mandate.limits.dailyCeilingUsd} an hour, ${mandate.limits.dailyCeilingUsd} a day` +
      (mandate.limits.monthlyCeilingUsd ? `, ${mandate.limits.monthlyCeilingUsd} in 30 days` : ""),
    `  trust     sellers scoring ${mandate.minTrustScore} or more, on ${mandate.allowedChains.join(" and ")}`,
    `  tools     ${mandate.allowedTools.join(", ")}`,
    `  expires   ${mandate.expiresAt}`,
    ...created.map((file) => `  new key   ${file} (mode 0600; keep it out of version control)`),
    "",
    "next:",
    `  npx @twzrd1111/mandate serve --mandate ${path.relative(process.cwd(), out) || "mandate.json"} ${serveHint}`,
    `  claude mcp add --transport http twzrd-mandate http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

const RUNTIME_OPTIONS = {
  mandate: { type: "string" },
  "agent-key": { type: "string" },
  "trust-issuer": { type: "string", multiple: true },
  "allow-self-mandate": { type: "boolean" },
  "receipt-max-age": { type: "string" },
  "allow-receipt-replay": { type: "boolean" },
  "pay-module": { type: "string" },
  "intel-base": { type: "string" },
  "mcp-upstream": { type: "string" },
  "mcp-upstream-cmd": { type: "string" },
  "mcp-header": { type: "string", multiple: true },
} as const;

interface RuntimeFlags {
  mandate?: string;
  "agent-key"?: string;
  "trust-issuer"?: string[];
  "allow-self-mandate"?: boolean;
  "receipt-max-age"?: string;
  "allow-receipt-replay"?: boolean;
  "pay-module"?: string;
  "intel-base"?: string;
  "mcp-upstream"?: string;
  "mcp-upstream-cmd"?: string;
  "mcp-header"?: string[];
}

function trustedIssuers(flags: { "trust-issuer"?: string[] }): string[] {
  const fromEnv = (process.env.TWZRD_MANDATE_TRUSTED_ISSUERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...(flags["trust-issuer"] ?? []), ...fromEnv];
}

async function loadPayModule(file: string): Promise<WrapPay> {
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { wrapPay?: unknown; default?: unknown };
  const wrapPay = typeof mod.wrapPay === "function" ? mod.wrapPay : typeof mod.default === "function" ? mod.default : undefined;
  if (wrapPay === undefined) fail(`${file} must export wrapPay(guardedFetch), the function that pays a 402`);
  return wrapPay as WrapPay;
}

async function openRuntime(flags: RuntimeFlags): Promise<{ runtime: MandateRuntime; expiresAtMs: number }> {
  const agentKey = flags["agent-key"] !== undefined ? loadKeyFile(flags["agent-key"]) : undefined;
  const loaded = loadMandateFile(flags.mandate ?? "mandate.json", {
    trustedIssuers: trustedIssuers(flags),
    allowSelfMandate: flags["allow-self-mandate"] === true,
    ...(agentKey ? { heldAgentKey: agentKey.publicKey } : {}),
  });
  if (!loaded.ok) {
    const hint =
      loaded.code === "mandate_issuer_untrusted"
        ? " (pass --trust-issuer <the operator's public key>, or --agent-key for a self-signed mandate)"
        : "";
    fail(`refusing to start: ${loaded.code}: ${loaded.detail}${hint}`);
  }
  if (agentKey && agentKey.publicKey !== loaded.mandate.agent) fail("refusing to start: --agent-key is not the agent this mandate names");
  const wrapPay = flags["pay-module"] !== undefined ? await loadPayModule(flags["pay-module"]) : undefined;
  let receiptMaxAgeSeconds: number | null | undefined;
  const maxAge = flags["receipt-max-age"];
  if (maxAge !== undefined) {
    if (maxAge === "off") receiptMaxAgeSeconds = null;
    else if (/^[1-9][0-9]{0,8}$/.test(maxAge)) receiptMaxAgeSeconds = Number(maxAge);
    else fail('--receipt-max-age takes a whole number of seconds, or "off"');
  }
  if (receiptMaxAgeSeconds === null) process.stderr.write("warning: receipt age is not checked (--receipt-max-age off); use it only against a loopback seller\n");
  if (flags["allow-receipt-replay"] === true) process.stderr.write("warning: a receipt seen before is accepted again (--allow-receipt-replay); use it only against a loopback seller\n");
  const runtime = createMandateRuntime({
    mandate: loaded.mandate,
    expiresAtMs: loaded.expiresAtMs,
    stateDir: loaded.stateDir,
    ...(receiptMaxAgeSeconds !== undefined ? { receiptMaxAgeSeconds } : {}),
    ...(flags["allow-receipt-replay"] === true ? { refuseReceiptReplay: false } : {}),
    ...(wrapPay ? { wrapPay } : {}),
    ...(agentKey ? { agentKey } : {}),
    ...(flags["intel-base"] !== undefined ? { intelBase: flags["intel-base"] } : {}),
  });
  return { runtime, expiresAtMs: loaded.expiresAtMs };
}

function splitCommand(text: string): string[] {
  const parts = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((p) => (/^(".*"|'.*')$/.test(p) ? p.slice(1, -1) : p));
}

function mcpGateway(runtime: MandateRuntime | null, flags: RuntimeFlags): McpGateway | undefined {
  if (flags["mcp-upstream"] !== undefined && flags["mcp-upstream-cmd"] !== undefined) fail("give --mcp-upstream or --mcp-upstream-cmd, not both");
  if (flags["mcp-upstream"] !== undefined) {
    const headers: Record<string, string> = {};
    for (const line of flags["mcp-header"] ?? []) {
      const at = line.indexOf(":");
      if (at <= 0) fail(`--mcp-header takes "Name: value", not "${line}"`);
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return createMcpGateway(runtime, createHttpUpstream(flags["mcp-upstream"], { headers }));
  }
  if (flags["mcp-upstream-cmd"] !== undefined) {
    const [command, ...args] = splitCommand(flags["mcp-upstream-cmd"]);
    if (!command) fail("--mcp-upstream-cmd is empty");
    return createMcpGateway(runtime, createStdioUpstream(command, args));
  }
  return undefined;
}

async function serve(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...RUNTIME_OPTIONS,
      port: { type: "string" },
      host: { type: "string" },
      upstream: { type: "string" },
      "upstream-key-env": { type: "string" },
      "free-models": { type: "string" },
      "model-rates": { type: "string" },
      heartbeat: { type: "string" },
      quiet: { type: "boolean" },
    },
    strict: true,
  });
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port takes a port number");
  const heartbeat = values.heartbeat === undefined ? 0 : Number(values.heartbeat);
  if (!Number.isInteger(heartbeat) || heartbeat < 0) fail("--heartbeat takes a whole number of seconds");
  const { runtime, expiresAtMs } = await openRuntime(values);
  let inference: InferenceMeter | undefined;
  let mcp: McpGateway | undefined;
  try {
    mcp = mcpGateway(runtime, values);
    if (values.upstream !== undefined) {
      if (!runtime.mandate.allowedTools.includes(INFERENCE_TOOL)) {
        fail(`--upstream needs "${INFERENCE_TOOL}" in the mandate's allowedTools; this mandate does not allow the /v1 route`);
      }
      inference = await startInferenceMeter({
        runtime,
        expiresAtMs,
        upstreamBaseUrl: values.upstream,
        ...(values["upstream-key-env"] !== undefined ? { apiKeyEnv: values["upstream-key-env"] } : {}),
        ...(values["free-models"] !== undefined ? { freeModels: list(values["free-models"]) ?? [] } : {}),
        ...(values["model-rates"] !== undefined ? { modelRatesJson: fs.readFileSync(values["model-rates"], "utf8") } : {}),
      });
    }
    const sidecar = await startSidecar({
      runtime,
      version: VERSION,
      port,
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(mcp ? { mcp } : {}),
      ...(inference ? { inference } : {}),
      heartbeatSeconds: heartbeat,
      ...(values.quiet ? {} : { log: (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }),
    });
    const status = runtime.status();
    process.stderr.write(
      [
        `twzrd-mandate ${VERSION} listening on ${sidecar.url} (loopback only)`,
        `  mandate   ${status.mandate.mandateId} (${status.mandate.issuerMode}), expires ${status.mandate.expiresAt}`,
        `  limits    ${status.mandate.limits.maxPerCallUsd} USD a call, ${status.spend.remainingHourUsd} left this hour, ${status.spend.remainingDayUsd} left today`,
        `  payer     ${status.payer === "configured" ? "configured" : "none: every 402 is refused (pass --pay-module to settle)"}`,
        `  /mcp      ${mcp ? "proxying the configured MCP upstream" : "not configured (--mcp-upstream)"}`,
        `  /v1       ${inference ? `metered, upstream ${inference.upstreamBaseUrl}` : "not configured (--upstream)"}`,
        `  /pay/     ${sidecar.url}/pay/<absolute-url>`,
        `  state     ${runtime.stateDir} (control token in ${CONTROL_TOKEN_FILE})`,
        `  stop      touch ${path.join(runtime.stateDir, STATE_FILES.kill)}   or   curl -X POST ${sidecar.url}/mandate/kill`,
        "",
      ].join("\n"),
    );
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await sidecar.close();
    return 0;
  } catch (err) {
    inference?.close();
    mcp?.close();
    runtime.close();
    throw err;
  }
}

async function mcpStdio(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { ...RUNTIME_OPTIONS, sidecar: { type: "string" } }, strict: true });
  if (values.sidecar !== undefined) {
    const gateway = createMcpGateway(null, createHttpUpstream(`${values.sidecar.replace(/\/+$/, "")}/mcp`));
    await runMcpStdio(gateway, { input: process.stdin, output: process.stdout });
    return 0;
  }
  const { runtime } = await openRuntime(values);
  try {
    const gateway = mcpGateway(runtime, values) ?? fail("mcp-stdio needs --sidecar <url>, --mcp-upstream <url> or --mcp-upstream-cmd \"<cmd>\"");
    await runMcpStdio(gateway, { input: process.stdin, output: process.stdout });
    gateway.close();
    return 0;
  } finally {
    runtime.close();
  }
}

const OPERATE_OPTIONS = {
  url: { type: "string" },
  mandate: { type: "string" },
  "state-dir": { type: "string" },
  limit: { type: "string" },
  verify: { type: "boolean" },
  reason: { type: "string" },
  json: { type: "boolean" },
} as const;

function stateDirOf(values: { mandate?: string; "state-dir"?: string }): string {
  if (values["state-dir"] !== undefined) return path.resolve(values["state-dir"]);
  const file = path.resolve(values.mandate ?? "mandate.json");
  const read = mandateStateDir(file);
  if (!read.ok) fail(`${read.detail}; pass --mandate <file>, --state-dir <dir> or --url <sidecar>`);
  return read.stateDir;
}

async function sidecarFetch(base: string, route: string, init: RequestInit = {}): Promise<{ status: number; doc: unknown } | null> {
  try {
    const resp = await fetch(`${base.replace(/\/+$/, "")}${route}`, { ...init, signal: AbortSignal.timeout(5000) });
    return { status: resp.status, doc: await resp.json() };
  } catch {
    return null;
  }
}

async function operate(command: "status" | "kill" | "resume" | "ledger", argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: OPERATE_OPTIONS, strict: true });
  const base = values.url ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const print = (doc: unknown): void => {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  };
  if (command === "status") {
    const got = await sidecarFetch(base, "/mandate/status");
    if (got === null) fail(`no sidecar answered at ${base}; start one with "mandate serve"`);
    print(got.doc);
    return got.status === 200 ? 0 : 1;
  }
  if (command === "ledger") {
    if (values.verify || values.url === undefined) {
      const file = path.join(stateDirOf(values), STATE_FILES.decisionLedger);
      const report = verifyDecisionLedger(file);
      print({ path: file, ...report });
      return report.ok ? 0 : 1;
    }
    const got = await sidecarFetch(base, `/mandate/ledger?limit=${encodeURIComponent(values.limit ?? "20")}`);
    if (got === null) fail(`no sidecar answered at ${base}`);
    print(got.doc);
    return got.status === 200 ? 0 : 1;
  }
  if (command === "kill") {
    // Stopping must work whether or not a sidecar is up: write the file first, then tell the sidecar.
    let wrote: string | null = null;
    if (values.url === undefined) {
      const dir = stateDirOf(values);
      fs.mkdirSync(dir, { recursive: true });
      wrote = path.join(dir, STATE_FILES.kill);
      fs.writeFileSync(wrote, `${JSON.stringify({ at: new Date().toISOString(), reason: values.reason ?? "operator" })}\n`);
    }
    // Tell the sidecar as well, even after writing the file: it answers for the directory it actually holds.
    const got = await sidecarFetch(base, "/mandate/kill", { method: "POST", body: JSON.stringify({ reason: values.reason ?? "operator" }) });
    if (wrote === null && got === null) fail(`no sidecar answered at ${base}; pass --mandate <file> to write the kill file directly`);
    print({ killed: true, ...(wrote !== null ? { killFile: wrote } : {}), sidecar: got === null ? "no answer" : got.doc });
    return 0;
  }
  // resume
  const dir = stateDirOf(values);
  let token: string | null = null;
  try {
    token = fs.readFileSync(path.join(dir, CONTROL_TOKEN_FILE), "utf8").trim();
  } catch {
    token = null;
  }
  if (token !== null) {
    const got = await sidecarFetch(base, "/mandate/resume", { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (got !== null && got.status === 200) {
      print(got.doc);
      return 0;
    }
  }
  // No sidecar holds this state directory: clear the files directly.
  const removed: string[] = [];
  for (const name of [STATE_FILES.pause, STATE_FILES.kill]) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  print({ removed, stateDir: dir });
  return 0;
}

function verifyCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "trust-issuer": { type: "string", multiple: true },
      "allow-self-mandate": { type: "boolean" },
      "agent-key": { type: "string" },
      mandate: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const file = positionals[0] ?? values.mandate ?? "mandate.json";
  const agentKey = values["agent-key"] !== undefined ? loadKeyFile(values["agent-key"]) : undefined;
  const loaded = loadMandateFile(file, {
    trustedIssuers: trustedIssuers(values),
    allowSelfMandate: values["allow-self-mandate"] === true,
    ...(agentKey ? { heldAgentKey: agentKey.publicKey } : {}),
  });
  if (!loaded.ok) {
    process.stdout.write(`INVALID  ${loaded.code}: ${loaded.detail}\n`);
    return 1;
  }
  process.stdout.write(
    `VALID  ${loaded.mandate.mandateId} (${loaded.mandate.issuerMode}), issuer ${loaded.mandate.issuer}, expires ${loaded.mandate.expiresAt}\n`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "init":
      return issue("human-operator", rest);
    case "self-issue":
      return issue("self-mandated", rest);
    case "session":
      return issue("ephemeral-session", rest);
    case "verify":
      return verifyCommand(rest);
    case "serve":
      return serve(rest);
    case "mcp-stdio":
      return mcpStdio(rest);
    case "status":
    case "kill":
    case "resume":
    case "ledger":
      return operate(command, rest);
    case "verify-breakers": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } }, strict: true });
      const report = await verifyBreakers();
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatBreakerReport(report)}\n`);
      return report.ok ? 0 : 1;
    }
    default:
      fail(`unknown command "${command}"; run "mandate help"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error & { code?: string }) => {
    // A usage error or a refusal to start is one line, not a stack trace.
    const usage = err instanceof UsageError || (typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS"));
    process.stderr.write(`mandate: ${err.message}\n`);
    if (!usage && process.env.TWZRD_MANDATE_DEBUG === "1" && err.stack) process.stderr.write(`${err.stack}\n`);
    process.exitCode = usage ? 2 : 1;
  },
);
