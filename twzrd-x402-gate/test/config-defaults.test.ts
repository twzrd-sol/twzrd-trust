/**
 * Lock 0.5.x seatbelt defaults: absent env vars must fail-closed / decision-only.
 * Run: npx tsx test/config-defaults.test.ts
 */
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    fn();
  } finally {
    for (const [key, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
}

function run() {
  withEnv(
    {
      TWZRD_FAIL_OPEN: undefined,
      TWZRD_GATE_ON_CAN_SPEND: undefined,
    },
    () => {
      const cfg = resolveConfig();
      assert.equal(cfg.failOpen, false, "absent TWZRD_FAIL_OPEN → failOpen=false");
      assert.equal(
        cfg.gateOnCanSpend,
        false,
        "absent TWZRD_GATE_ON_CAN_SPEND → gateOnCanSpend=false",
      );
    },
  );

  withEnv({ TWZRD_FAIL_OPEN: "true" }, () => {
    assert.equal(resolveConfig().failOpen, true, "TWZRD_FAIL_OPEN=true opts in");
  });

  withEnv({ TWZRD_GATE_ON_CAN_SPEND: "1" }, () => {
    assert.equal(
      resolveConfig().gateOnCanSpend,
      true,
      "TWZRD_GATE_ON_CAN_SPEND=1 opts in",
    );
  });

  assert.equal(
    resolveConfig({ failOpen: true }).failOpen,
    true,
    "explicit override failOpen:true",
  );
  assert.equal(
    resolveConfig({ gateOnCanSpend: true }).gateOnCanSpend,
    true,
    "explicit override gateOnCanSpend:true",
  );

  console.log("config-defaults.test.ts: ALL PASSED");
}

run();