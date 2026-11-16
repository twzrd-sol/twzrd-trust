import assert from "node:assert/strict";
import test from "node:test";

import { isRouteTemplateUrl } from "../src/route-template.js";

test("route placeholders are templates, raw or percent-encoded", () => {
  for (const url of [
    "https://seller.example/quote/:ticker",
    "https://seller.example/v1/item/{id}",
    "/v1/intel/quick/{pubkey}",
    "/v1/intel/quick/:pubkey",
    "https://seller.example/v1/item/%7Bid%7D",
    "https://seller.example/v1/item/%257Bid%257D",
    "https://seller.example/docs/[slug]",
    "https://seller.example/docs/[...slug]",
    "https://seller.example/docs/%5Bslug%5D",
    "https://seller.example/docs/%255Bslug%255D",
    "https://seller.example/quick/%3Apubkey",
    "https://seller.example/lookup?wallet={wallet}",
    "https://seller.example/lookup?wallet=%7Bwallet%7D",
  ]) {
    assert.equal(isRouteTemplateUrl(url), true, url);
  }
});

test("concrete URLs are not templates", () => {
  for (const url of [
    "https://seller.example/v1/intel/quick/Seller1111111111111111111111111111111111111",
    "/v1/intel/quick/Seller1111111111111111111111111111111111111",
    "https://seller.example:8443/time",
    // A colon inside a segment is a custom method, not a placeholder.
    "https://seller.example/v1/projects/p:batchGet",
    // Brackets in a query are ordinary query syntax.
    "https://seller.example/api?filter[status]=open&page[size]=10",
    // A JSON query value is not an identifier in braces.
    "https://seller.example/api?q=%7B%22a%22%3A1%7D",
    // A malformed escape stops decoding; it does not make a template.
    "https://seller.example/a%ZZ",
  ]) {
    assert.equal(isRouteTemplateUrl(url), false, url);
  }
});
