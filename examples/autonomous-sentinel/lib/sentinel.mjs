// twzrd-sentinel: an autonomous buyer that runs under a signed spend mandate.
//
// One cycle is: discover paid tasks from the catalog, send each through the
// mandate runtime (which screens the seller, takes a budget hold, lets one
// payment leave, checks the receipt and its log inclusion, and records the
// amount actually charged), verify the decision ledger, and sign a heartbeat.
//
// The sentinel decides nothing about money. Every limit lives in the
// mandate, and every refusal comes from the runtime in @twzrd1111/mandate.
import fs from "node:fs";
import path from "node:path";
import {
  LOOPBACK_WASH_SELLER,
  VERSION,
  createLoopbackPayer,
  createMandateRuntime,
  emitHeartbeat,
  findReceipt,
  httpToolName,
  issueMandate,
  loadKeyFile,
  loadMandateFile,
  loadOrCreateKeyFile,
  loopbackOnlyFetch,
  startLoopbackWorld,
  verifyHeartbeat,
  writeMandateFile,
} from "@twzrd1111/mandate";

export const SESSION_SCHEMA = "twzrd.mandate.session.v1";
export const CATALOG_PATH = "/v1/intel/bazaar/offers";
export const LIVE_INTEL_BASE = "https://intel.twzrd.xyz";
/** The one first-party route documented to answer with a signed V7 receipt. */
export const LIVE_DEFAULT_TASKS = ["twzrd_trust"];
export const DEFAULT_LOOPBACK_PORT = 4039;

const HOUSE_CALLER = /^twzrd:internal:[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * TWZRD's own runners tag their traffic so it is not counted as outside
 * traffic. Off unless TWZRD_INTERNAL_CALLER is set; nobody else should set it.
 */
function taggedFetch(intelBase, env) {
  const raw = env.TWZRD_INTERNAL_CALLER;
  if (raw === undefined || raw === "") return undefined;
  if (!HOUSE_CALLER.test(raw)) throw new Error("TWZRD_INTERNAL_CALLER must look like twzrd:internal:<subsystem>");
  const intelHost = new URL(intelBase).host;
  return (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== intelHost) return fetch(request);
    const headers = new Headers(request.headers);
    headers.set("x-twzrd-caller", raw);
    return fetch(new Request(request, { headers }));
  };
}

async function loadPayModule(file) {
  const mod = await import(new URL(`file://${path.resolve(file)}`).href);
  const wrapPay = typeof mod.wrapPay === "function" ? mod.wrapPay : typeof mod.default === "function" ? mod.default : undefined;
  if (wrapPay === undefined) throw new Error(`${file} must export wrapPay(guardedFetch), the function that pays a 402`);
  return wrapPay;
}

/** The loopback catalog: two honest tasks and one of each kind the mandate must refuse. */
function stockLoopbackWorld(world) {
  world.product("lookup").priceMicro = 10_000;
  world.product("wash-seller").payTo = LOOPBACK_WASH_SELLER;
  world.product("over-cap").priceMicro = 500_000;
  world.product("bad-header").challenge = "noncanonical-header";
  const report = world.product("report");
  report.priceMicro = 20_000;
  report.challenge = "header";
}

/**
 * Open a sentinel.
 *
 * Loopback (the default) starts a seller, a trust service and a receipt log
 * on 127.0.0.1 and pays them with a throwaway key: no wallet, no network, no
 * money. With no mandate file it issues itself one for that loopback seller.
 *
 * Live reads the real catalog and trust service. Without a pay module it is
 * a dry run: tasks are discovered and screened, and every 402 is refused
 * with no_payer_configured.
 */
export async function openSentinel(options = {}) {
  const env = options.env ?? process.env;
  const live = options.live === true;
  const dir = path.resolve(options.dir ?? ".");
  const log = options.log ?? (() => {});
  let world = null;
  let wrapPay;
  let intelBase;
  let fetchImpl;

  if (live) {
    if (options.mandate === undefined) throw new Error("live mode needs --mandate: a sentinel does not issue its own mandate for real money");
    intelBase = options.intelBase ?? LIVE_INTEL_BASE;
    wrapPay = options.payModule !== undefined ? await loadPayModule(options.payModule) : undefined;
    fetchImpl = taggedFetch(intelBase, env);
  } else {
    if (options.payModule !== undefined) throw new Error("--pay-module is for live mode; loopback pays with its own throwaway key");
    const payer = createLoopbackPayer();
    world = await startLoopbackWorld(payer.publicKey, { port: options.loopbackPort ?? DEFAULT_LOOPBACK_PORT });
    stockLoopbackWorld(world);
    wrapPay = payer.wrapPay;
    intelBase = world.intelBase;
    world.payer = payer;
    // Loopback means loopback: a request to anywhere but 127.0.0.1 is refused and counted.
    const guard = loopbackOnlyFetch();
    fetchImpl = guard.fetch;
    world.strays = guard.strays;
  }

  try {
    const agentKeyPath = path.resolve(dir, options.agentKey ?? "agent.json");
    let mandatePath = options.mandate !== undefined ? path.resolve(dir, options.mandate) : path.join(dir, "mandate.json");
    let agentKey;
    if (!live && options.mandate === undefined && !fs.existsSync(mandatePath)) {
      // Self-mandated: the agent signs its own limits with its own key.
      agentKey = loadOrCreateKeyFile(agentKeyPath).key;
      const mandate = issueMandate({
        issuerMode: "self-mandated",
        issuerKey: agentKey,
        maxPerCallUsd: "0.05",
        hourlyCeilingUsd: "0.50",
        dailyCeilingUsd: "2.00",
        allowedChains: ["solana"],
        minTrustScore: 75,
        allowedTools: [httpToolName(new URL(world.base))],
        requireV7Receipt: true,
        requireMerkleInclusion: true,
        killswitchDir: ".twzrd-mandate",
        lifetimeMs: 30 * 24 * 3_600_000,
      });
      writeMandateFile(mandatePath, mandate);
      log(`issued a self-signed loopback mandate: ${mandatePath}`);
    } else {
      agentKey = fs.existsSync(agentKeyPath) ? loadKeyFile(agentKeyPath) : undefined;
    }
    const trusted = [...(options.trustIssuers ?? []), ...String(env.TWZRD_MANDATE_TRUSTED_ISSUERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
    const loaded = loadMandateFile(mandatePath, { trustedIssuers: trusted, ...(agentKey ? { heldAgentKey: agentKey.publicKey } : {}) });
    if (!loaded.ok) {
      const err = new Error(`refusing to start: ${loaded.code}: ${loaded.detail}`);
      err.code = loaded.code;
      throw err;
    }
    if (!agentKey || agentKey.publicKey !== loaded.mandate.agent) {
      throw new Error("refusing to start: the sentinel needs the key of the agent this mandate names (--agent-key), to sign its heartbeat");
    }
    const runtime = createMandateRuntime({
      mandate: loaded.mandate,
      expiresAtMs: loaded.expiresAtMs,
      stateDir: loaded.stateDir,
      agentKey,
      intelBase,
      ...(wrapPay ? { wrapPay } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      // The loopback seller serves one fixed, signed fixture receipt on every
      // paid call, so its age and repeat checks are off there. Live keeps both.
      ...(live ? {} : { receiptMaxAgeSeconds: null, refuseReceiptReplay: false }),
    });
    if (!live) log("loopback: receipt age and replay checks are off (one fixed fixture receipt); live mode keeps both on");
    const tasks = options.tasks ?? (live ? LIVE_DEFAULT_TASKS : null);
    return {
      live,
      mode: live ? (wrapPay ? "live" : "live-dry-run") : "loopback",
      runtime,
      world,
      intelBase,
      mandate: loaded.mandate,
      expiresAtMs: loaded.expiresAtMs,
      mandatePath,
      tasks,
      maxTasks: options.maxTasks ?? 8,
      async close() {
        runtime.close();
        if (world) await world.close();
      },
    };
  } catch (err) {
    if (world) await world.close();
    throw err;
  }
}

/** Read the catalog's offers into tasks. Anything that is not a plain GET with an http(s) URL is left out. */
export function tasksFromCatalog(doc, wanted) {
  const offers = doc !== null && typeof doc === "object" && Array.isArray(doc.offers) ? doc.offers : [];
  const tasks = [];
  for (const offer of offers) {
    if (offer === null || typeof offer !== "object") continue;
    const { id, title, resource, method } = offer;
    if (typeof id !== "string" || typeof resource !== "string") continue;
    if (wanted && !wanted.includes(id)) continue;
    if (method !== undefined && String(method).toUpperCase() !== "GET") continue;
    let url;
    try {
      url = new URL(resource);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    tasks.push({ id, title: typeof title === "string" && title !== "" ? title : id, url: url.href, tool: httpToolName(url) });
  }
  return tasks;
}

function bodyJson(result) {
  try {
    return JSON.parse(Buffer.from(result.body).toString("utf8"));
  } catch {
    return null;
  }
}

/** One step of a session: what the runtime decided, in the shape `twzrd.mandate.session.v1` records. */
function stepOf(sentinel, n, title, kind, tool, result) {
  const status = sentinel.runtime.status();
  const outcome = result.outcome;
  const document = result.delivered && (outcome === "settled" || outcome === "violation") ? (findReceipt(bodyJson(result)) ?? null) : null;
  const receipt = result.receipt;
  const inclusion = result.inclusion;
  let detail;
  if (outcome === "settled") {
    detail = `paid ${result.settledUsd} USDC to ${result.payTo} (quoted ${result.quotedUsd}); receipt ${receipt?.status ?? "not required"}; inclusion ${inclusion?.status ?? "not required"}`;
  } else if (outcome === "free") {
    detail = "answered without asking for payment";
  } else {
    detail = result.refusal?.detail ?? outcome;
  }
  // A step names the state directory the way the mandate does, not by this machine's path.
  detail = detail.split(sentinel.runtime.stateDir).join(sentinel.mandate.killswitchDir);
  return {
    n,
    title,
    tool,
    kind,
    outcome,
    layer: outcome === "refused" ? (result.refusal?.layer ?? null) : null,
    code: result.refusal?.code ?? null,
    detail,
    quotedUsd: result.quotedUsd,
    settledUsd: outcome === "refused" ? null : result.settledUsd,
    signatures: result.signatures,
    receipt: {
      status: receipt?.status ?? "absent",
      version: receipt?.version ?? null,
      keyId: document !== null && typeof document === "object" && typeof document.key_id === "string" ? document.key_id : null,
      leaf: receipt?.leaf ?? null,
      document: receipt && receipt.status !== "absent" ? document : null,
    },
    inclusion: {
      status: inclusion?.status ?? "not_checked",
      leafIndex: inclusion?.leafIndex ?? null,
      treeSize: inclusion?.treeSize ?? null,
    },
    remainingHourUsd: status.spend.remainingHourUsd,
    remainingDayUsd: status.spend.remainingDayUsd,
    ledgerHead: sentinel.runtime.ledger.head(),
  };
}

/**
 * Run one cycle. Returns the steps taken, the ledger check and the signed
 * heartbeat. A cycle never throws for a refusal: a refusal is a result.
 */
export async function runCycle(sentinel, opts = {}) {
  const { runtime } = sentinel;
  const steps = opts.steps ?? [];
  const add = (title, kind, tool, result) => {
    const step = stepOf(sentinel, steps.length + 1, title, kind, tool, result);
    steps.push(step);
    opts.onStep?.(step);
    return step;
  };

  // Nothing is asked of anyone while the mandate is expired or halted.
  const stopped = runtime.precheck();
  let tasks = [];
  if (stopped === null) {
    // 1. Discover. The catalog read goes through the runtime like any other call, so it is on the ledger too.
    const catalogUrl = new URL(CATALOG_PATH, sentinel.intelBase);
    const catalogTool = httpToolName(catalogUrl);
    const found = await runtime.call({ tool: catalogTool, url: catalogUrl.href });
    add("Discover paid tasks from the catalog", "discover", catalogTool, found);
    if (found.outcome === "free") tasks = tasksFromCatalog(bodyJson(found), sentinel.tasks).slice(0, sentinel.maxTasks);

    // 2. Each task: screen, hold, pay once, verify, reconcile. All of it is the runtime's.
    for (const task of tasks) {
      if (runtime.precheck() !== null) break;
      const result = await runtime.call({ tool: task.tool, url: task.url });
      add(task.title, "paid-task", task.tool, result);
    }
  }

  // 3. Reconcile: the ledger must still chain, and its sums are what the heartbeat states.
  const ledger = runtime.ledger.verify();
  const heartbeat = emitHeartbeat(runtime);
  const signed = verifyHeartbeat(heartbeat, { agent: sentinel.mandate.agent });
  return {
    stopped,
    discovered: tasks.length,
    steps,
    ledger,
    heartbeat,
    ok: ledger.ok && signed.ok && heartbeat.ledgerHeadHash === runtime.ledger.head(),
  };
}

/**
 * Record one loopback session: a cycle over the stock catalog, then two more
 * refusals a catalog cannot stage (a seller the mandate does not name, and
 * the kill file), then the heartbeat. Loopback only.
 */
export async function recordSession(sentinel, opts) {
  if (sentinel.mode !== "loopback") throw new Error("a session is recorded in loopback mode only");
  if (!/^[0-9a-f]{40}$/.test(String(opts.commit))) throw new Error("--source-commit must be the 40-character commit the recording was made from");
  const { runtime, world } = sentinel;
  const steps = [];
  await runCycle(sentinel, { steps, onStep: opts.onStep });
  const add = (title, kind, tool, result) => {
    const step = stepOf(sentinel, steps.length + 1, title, kind, tool, result);
    steps.push(step);
    opts.onStep?.(step);
  };

  const stranger = new URL("http://unlisted-seller.invalid/paid/lookup");
  add("A seller the mandate does not name", "paid-task", httpToolName(stranger), await runtime.call({ tool: httpToolName(stranger), url: stranger.href }));

  // An operator stops the agent the way the documentation says: by creating the kill file.
  fs.writeFileSync(path.join(runtime.stateDir, ".kill"), "recorded session: operator stop\n");
  const lookup = new URL(world.url("lookup"));
  add("The same lookup after the kill file is written", "paid-task", httpToolName(lookup), await runtime.call({ tool: httpToolName(lookup), url: lookup.href }));

  const heartbeat = emitHeartbeat(runtime);
  const counters = runtime.status().counters;
  const session = {
    schema: SESSION_SCHEMA,
    recordedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    environment: "loopback",
    source: { package: "@twzrd1111/mandate", version: VERSION, commit: opts.commit },
    mandate: sentinel.mandate,
    steps,
    totals: {
      decisions: counters.decisions,
      settled: counters.settled,
      refusals: counters.refusals,
      settledUsd: counters.settledUsd,
      signatures: counters.signatures,
    },
    heartbeat,
    payerSignatures: world.payer.signatures,
    sellerPayments: world.paidCount,
    strayRequests: world.strays.length,
  };
  return session;
}

/** Run cycles until told to stop, the mandate expires, or `cycles` have run. */
export async function runLoop(sentinel, opts = {}) {
  const intervalMs = opts.intervalMs ?? 60_000;
  const limit = opts.cycles ?? Infinity;
  let ran = 0;
  let stop = false;
  let wake = () => {};
  const halt = () => {
    stop = true;
    wake();
  };
  opts.onStopper?.(halt);
  while (!stop && ran < limit) {
    const cycle = await runCycle(sentinel, { onStep: opts.onStep });
    ran += 1;
    opts.onCycle?.(cycle, ran);
    if (!cycle.ok) return { cycles: ran, reason: "ledger_or_heartbeat_failed", exitCode: 1 };
    if (cycle.stopped?.code === "mandate_expired") return { cycles: ran, reason: "mandate_expired", exitCode: 3 };
    if (stop || ran >= limit) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  return { cycles: ran, reason: stop ? "stopped" : "cycles_done", exitCode: 0 };
}
