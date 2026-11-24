// Types for the untyped test-only devDependency (outbid-receipt-verify ships index.mjs only).
declare module "outbid-receipt-verify" {
  import type { KeyObject } from "node:crypto";
  export function sha256Hex(bytes: Uint8Array | string): string;
  export function signReceipt(fields: Record<string, unknown>, privateKey: KeyObject): { ok: boolean; token: string; reason?: string };
  export function verifyReceipt(token: string, opts: Record<string, unknown>): { ok: boolean; reason?: string; receipt?: Record<string, unknown> };
  export function splitSseReceipt(stream: Uint8Array): { ok: boolean; body?: Uint8Array; token?: string; reason?: string };
  export function sseTrailer(body: Uint8Array, token: string): string;
}
