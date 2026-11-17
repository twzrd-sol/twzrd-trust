// Child process for the crash test in security-review.test.mjs: one paid call,
// and the process dies (SIGKILL) as soon as the seller has taken the payment,
// before the runtime reads the answer. Nothing here leaves 127.0.0.1.
import fs from "node:fs";
import { keyFromSeed } from "../../dist/index.js";
import { makeRig } from "../helpers.mjs";

const [stateDir, seedHex, mandateId, nowMs] = process.argv.slice(2);
const rig = await makeRig({
  stateDir,
  agentKey: keyFromSeed(Buffer.from(seedHex, "hex")),
  now: Number(nowMs),
  mandate: { mandateId, maxPerCallUsd: "0.05", hourlyCeilingUsd: "0.05", dailyCeilingUsd: "1.00" },
});
rig.world.product("x").priceMicro = 50_000;
rig.world.hook = (event) => {
  if (event !== "payment:x") return;
  // The seller counts the payment after this hook returns: die on the next turn.
  setImmediate(() => {
    fs.writeSync(1, `${JSON.stringify({ paidCount: rig.world.paidCount, receivedMicro: rig.world.receivedMicro })}\n`);
    process.kill(process.pid, "SIGKILL");
  });
};
await rig.buy("x");
fs.writeSync(1, `${JSON.stringify({ survived: true })}\n`);
await rig.close();
