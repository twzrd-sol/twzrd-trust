// The seller check the gate runs before the signer (safeFetch's `preflight`
// hook). Live, this is TWZRD's free preflight; the README shows the adapter.
// Here it is a recorded table for the two demo sellers, so the run is offline
// and gives the same answer every time. A seller not in the table is blocked.
import { RAIL_IDS, RAILS } from "./rails.mjs";

export function createSellerCheck() {
  const cards = new Map();
  for (const id of RAIL_IDS) {
    cards.set(RAILS[id].sellers.good, { decision: "allow", reason_codes: [] });
    cards.set(RAILS[id].sellers.flagged, { decision: "block", reason_codes: ["WASH_FLAGGED"] });
  }
  const calls = [];
  const holds = [];

  async function check(payTo, priceUsdc) {
    calls.push({ payTo, priceUsdc });
    const hold = holds.shift();
    if (hold) {
      hold.reached();
      await hold.released;
    }
    return cards.get(payTo) ?? { decision: "block", reason_codes: ["UNKNOWN_SELLER"] };
  }

  /**
   * Hold the next `n` checks until release() is called: the in-flight beat of
   * act 3. `reached` settles once all `n` calls are waiting on their answer.
   */
  function hold(n) {
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const reached = [];
    for (let i = 0; i < n; i += 1) {
      reached.push(new Promise((resolve) => holds.push({ reached: resolve, released })));
    }
    return { reached: Promise.all(reached), release };
  }

  return { check, hold, calls };
}
