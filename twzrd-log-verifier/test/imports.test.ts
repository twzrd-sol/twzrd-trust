import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/*
 * Import-cycle guard.
 *
 * keydir.ts once took PUBKEY_LEN from sth.ts while sth.ts imported keydir.ts,
 * making a runtime constant's value depend on which module the process loaded
 * first. It happened not to break, which is exactly why it needed a test rather
 * than a fix alone.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function localImports(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  const out: string[] = [];
  // Matches `from "./x.js"` in both value and `import type` positions.
  for (const m of source.matchAll(/from\s+"\.\/([A-Za-z0-9_-]+)\.js"/g)) {
    out.push(`${m[1]}.ts`);
  }
  return out;
}

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    graph.set(file, localImports(file));
  }
  return graph;
}

/** Depth-first search returning the first cycle found, as a path. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "visiting") {
      return [...stack.slice(stack.indexOf(node)), node];
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

test("the source graph has no import cycles", () => {
  const cycle = findCycle(buildGraph());
  assert.equal(
    cycle,
    null,
    cycle ? `import cycle: ${cycle.join(" -> ")}` : "",
  );
});

test("keydir does not import from sth (sth imports keydir)", () => {
  // The specific edge Copilot flagged, pinned so a refactor can't reintroduce
  // it quietly even if some other cycle-free arrangement is found.
  assert.ok(
    !localImports("keydir.ts").includes("sth.ts"),
    "keydir.ts must not import sth.ts; take shared constants from util.ts",
  );
  assert.ok(
    localImports("sth.ts").includes("keydir.ts"),
    "sth.ts is expected to import keydir.ts — that is the direction of the dependency",
  );
});

test("util is a leaf module", () => {
  // util holds the shared primitives, so anything it imported would sit
  // underneath every other module and invite exactly this class of cycle.
  assert.deepEqual(localImports("util.ts"), []);
});
