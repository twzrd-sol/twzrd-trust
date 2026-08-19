/**
 * `npx twzrd-gate-doctor` — one command that turns "should I gate this?" into
 * "here are the exact lines for THIS project, and here is the gate refusing."
 *
 * Why a doctor and not a codemod: patching someone else's source is invasive,
 * hard to review, and the first thing an operator reverts. The adoption blocker
 * is not typing three lines — it is not knowing WHICH three lines apply to the
 * client you already use, and not believing the gate actually refuses anything.
 * So this does exactly two things:
 *
 *   1. DETECT the x402 / agent surface already in package.json and print the
 *      snippet for that specific host (not a generic README excerpt).
 *   2. PROVE a refusal, offline, spending nothing: a wash-flagged verdict is fed
 *      to the real hook and we assert the signer was never invoked.
 *
 * Exit codes: 0 = a seam was found and the refusal proof passed. 1 = proof
 * failed (a real problem — report it). 2 = no x402 surface detected (nothing to
 * gate here yet, not an error).
 *
 * No network by default: the refusal proof is deterministic and local, so it
 * works in CI and on a plane. Pass --live to additionally preflight a real
 * wash-flagged seller against intel.
 */
type Host = {
    id: string;
    label: string;
    /** Any of these dependency names present ⇒ this host applies. */
    deps: string[];
    install: string;
    snippet: string;
    note?: string;
};
export declare function detectHosts(pkg: Record<string, unknown> | null): Host[];
/**
 * Deterministic, offline refusal proof.
 *
 * Feeds a wash-flagged card straight to the policy layer and asserts the signer
 * never ran. This is the claim an operator needs to believe before adopting,
 * and it must be checkable without spending or reaching the network.
 */
export declare function proveRefusal(): Promise<{
    refused: boolean;
    signerInvocations: number;
    reason: string;
}>;
export declare function main(argv?: string[]): Promise<number>;
export {};
//# sourceMappingURL=doctor.d.ts.map