/**
 * Bound a free intel call. The callback gets an AbortSignal to pass to fetch,
 * so a real request is cancelled; the race also covers a fetch that ignores
 * the signal. A miss rejects, and the caller treats it as an outage (failOpen
 * decides it). Paid hops are deliberately not wrapped: aborting a payment in
 * flight is ambiguous about whether money moved.
 */
export async function withDeadline<T>(
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
