const METRICS = new Set(["kit_install", "simulator_run", "preflight_call", "verified_journey"]);
const ACTIVITIES = new Set(["house", "sponsored", "external"]);

export function createMetrics({ activity = "external", runId, sink = consoleMetric } = {}) {
  if (!ACTIVITIES.has(activity)) throw new Error(`invalid activity: ${activity}`);
  if (!runId) throw new Error("runId is required");
  return async (metric, data = {}) => {
    if (!METRICS.has(metric)) throw new Error(`invalid metric: ${metric}`);
    const event = { schema: "twzrd.agent-commerce-metric/1.0", metric, activity, run_id: runId, at: new Date().toISOString(), ...data };
    await sink(event);
    return event;
  };
}

export async function consoleMetric(event) {
  process.stderr.write(`[metric] ${JSON.stringify(event)}\n`);
  const endpoint = process.env.TWZRD_METRICS_URL;
  if (endpoint) await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
}

export function summarizeMetrics(events) {
  const result = {};
  for (const event of events) {
    const key = `${event.activity}:${event.metric}`;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}
