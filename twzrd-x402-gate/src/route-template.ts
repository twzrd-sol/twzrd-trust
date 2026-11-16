/**
 * A route template is not a URL anyone can call.
 *
 * x402 discovery can list a dynamic route by its template (`/quote/:ticker`,
 * `/item/{id}`, `/docs/[slug]`) instead of by a URL with the parameter filled
 * in. Requesting the template as written asks the seller about a resource that
 * does not exist, and paying for it buys nothing (x402-foundation/x402#4284).
 * The gate never probes or picks such a URL, and never hands one to a hook.
 */

/** In a path: `{name}`, `[name]` or `[...name]`, or a segment that starts `:name`. */
const PATH_PLACEHOLDER =
  /\{[^/{}]+\}|\[(?:\.\.\.)?[A-Za-z_][\w.-]*\]|(?:^|\/):[A-Za-z_]\w*/;

/**
 * In a query, only `{name}`. Brackets are ordinary query syntax
 * (`filter[status]=open`), and a JSON value is not an identifier in braces.
 */
const QUERY_PLACEHOLDER = /\{[A-Za-z_][\w.-]*\}/;

/** The value plus up to two rounds of percent-decoding (`%7Bid%7D`, `%257Bid%257D`). */
function decodings(value: string): string[] {
  const out = [value];
  let current = value;
  for (let round = 0; round < 2; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    out.push(next);
    current = next;
  }
  return out;
}

/**
 * True when `url` still carries a route placeholder. `url` is absolute or a
 * path such as `/v1/intel/quick/{pubkey}`. A placeholder is `{name}`, `:name`
 * or `[name]` in the path, raw or percent-encoded once or twice, or `{name}` in
 * the query.
 */
export function isRouteTemplateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://route-template.invalid");
  } catch {
    return false;
  }
  if (decodings(parsed.pathname).some((path) => PATH_PLACEHOLDER.test(path))) return true;
  return decodings(parsed.search).some((query) => QUERY_PLACEHOLDER.test(query));
}
