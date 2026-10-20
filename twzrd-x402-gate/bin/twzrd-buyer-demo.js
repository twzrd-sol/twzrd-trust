#!/usr/bin/env node
import { runBuyerDemo } from "../dist/buyer-demo.js";

try {
  console.log(JSON.stringify(await runBuyerDemo(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
