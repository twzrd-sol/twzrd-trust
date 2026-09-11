export const merchants = Object.freeze([
  {
    id: "twzrd-refuse-fixture",
    name: "Deliberately unsafe seller",
    seller: "CnTmHDXVEafkc8sFSzNky9w5zwk63Bk2mHZZodorjhvR",
    resource: "https://intel.twzrd.xyz/v1/intel/refuse-fixture",
    expected: "block"
  },
  {
    id: "twzrd-clean-control",
    name: "Clean control seller",
    seller: "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs",
    resource: "https://intel.twzrd.xyz/v1/intel/quick/8EgACpZ16XWEt7YjJPsh1ZheVRZUGmmwQ8nJdmA1o5w4",
    expected: "pass"
  }
]);

export async function discoverMerchants() {
  return merchants.map(merchant => ({ ...merchant }));
}
