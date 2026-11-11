// House attribution for repo scripts that call live intel (quickstart proof, release drift, mirror sync).
//
// Off by default. A clone, a fork, or anyone running these scripts sends no caller tag, so their
// traffic stays countable as outside traffic. Only TWZRD's own runners set TWZRD_INTERNAL_CALLER:
// this repo's GitHub workflows (guarded on github.repository) and the house local-ci/gate runner.
// The published packages never read this variable.
const INTERNAL_CALLER = /^twzrd:internal:[a-z0-9][a-z0-9-]{0,47}$/;

export function houseCallerHeaders(env = process.env) {
  const raw = env.TWZRD_INTERNAL_CALLER;
  if (raw === undefined || raw === '') return {};
  if (!INTERNAL_CALLER.test(raw)) {
    throw new Error(`TWZRD_INTERNAL_CALLER must look like twzrd:internal:<subsystem>, got ${JSON.stringify(raw)}`);
  }
  return { 'x-twzrd-caller': raw };
}
