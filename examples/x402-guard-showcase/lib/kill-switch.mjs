// The showcase's own kill file, and the checks that keep a run away from
// anyone else's. The gate only asks whether .kill exists; the content written
// here is a token, so a run removes only the file it wrote.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The run did not start, and changed nothing, for the reason given. */
export class ShowcaseRefusal extends Error {}

/** Create the data dir. Refuse to start if a .kill or .pause is already there. */
export function prepareDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  for (const name of [".kill", ".pause"]) {
    const file = join(dataDir, name);
    if (existsSync(file)) {
      throw new ShowcaseRefusal(
        `${file} already exists. The showcase does not start over an existing sentinel and never deletes one it did not write. If an interrupted run left it, read it, then remove it by hand.`,
      );
    }
  }
}

export function createKillSwitch(dataDir) {
  const file = join(dataDir, ".kill");
  const token = randomUUID();
  const ours = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).token === token;
    } catch {
      return false;
    }
  };
  return {
    file,
    /** Write .kill. Flag `wx` fails rather than overwrite a file already there. */
    engage() {
      const note = { written_by: "x402-guard-showcase", token, at: new Date().toISOString() };
      writeFileSync(file, `${JSON.stringify(note)}\n`, { flag: "wx" });
    },
    /** Remove .kill if this run wrote it. A file anyone else wrote stays. */
    disengage() {
      if (!existsSync(file)) return false;
      if (!ours()) throw new ShowcaseRefusal(`${file} was not written by this run; leaving it in place`);
      unlinkSync(file);
      return true;
    },
    /** Cleanup after an error: remove the file only if this run wrote it. */
    disengageIfOurs() {
      if (ours()) unlinkSync(file);
    },
  };
}
