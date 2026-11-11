import { createHash } from "node:crypto";

function H(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Binary Merkle root over leaf hashes (hex strings or Buffers).
 * Standard RFC 6962-style: leaf = sha256(data), node = sha256(left||right),
 * odd last node promoted. Used to batch-anchor chain slices.
 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex") as Buffer);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(createHash("sha256").update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

export function batchRoot(entries: { entry_hash: string }[]): string {
  return merkleRoot(entries.map((e) => e.entry_hash));
}

export function inclusionProof(leaves: string[], index: number): string[] {
  const proof: string[] = [];
  let level = leaves.map((h) => h);
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sib = level[isRight ? idx - 1 : idx + 1];
    if (sib !== undefined) proof.push(sib);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(H(Buffer.concat([Buffer.from(level[i]!, "hex"), Buffer.from(level[i + 1] ?? level[i]!, "hex")])).toString("hex"));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyInclusion(leafHash: string, index: number, proof: string[], root: string): boolean {
  let cur = Buffer.from(leafHash, "hex");
  let idx = index;
  for (const sibHex of proof) {
    const sib = Buffer.from(sibHex, "hex");
    cur = createHash("sha256").update(idx % 2 === 0 ? Buffer.concat([cur, sib]) : Buffer.concat([sib, cur])).digest();
    idx = Math.floor(idx / 2);
  }
  return cur.toString("hex") === root;
}
