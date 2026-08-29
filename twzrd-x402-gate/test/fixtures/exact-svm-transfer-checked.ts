/**
 * Frozen exact-SVM TransferChecked wire transaction.
 *
 * Built once with @solana/kit + @solana-program/token (v0 message, USDC mint
 * account meta, fee-payer signed). Offline-only — not for broadcast.
 *
 * Consumed by seller-hook tests via shipped extractSvmPayerFromTransaction /
 * defaultExtractPayer (optional peer @x402/svm).
 */
export const EXACT_SVM_TRANSFER_CHECKED_FIXTURE = {
  scheme: "exact-svm" as const,
  instruction: "TransferChecked" as const,
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  expectedTokenPayer: "Cswv9ZWHwzv3rypAeW99HBqksKJMmbZdV4FxFYRwymAQ",
  feePayer: "7U1AChqBBzhXDShbNnKPCU3fCn9UymTqioWJfENDkatp",
  transactionBase64:
    "Ae5zs/64rWCGJNNJTM+9z6nBJiBTFHJoIBkO+Ez5cgwuVx/VbZLtuoQ43tIi3ks0Xg3Q9Fm9ROzspimesG9LVwaAAQADBmAQ+5gyIsq/PHLJ2EX28csY0nFoDI1qZ05Bem3i+Sg5T6wqL+MZMaDU1QpIFV/UQFrZlWPqk+V4/fWe94M/4W/0LeQrHyO8tQTTz34WToEDZ6szIfCGni2o6GImKbYiLbB9sNSmE7gFSG9ZDOQ6KIGoFMR0tiARVfCnZ8Qzx8kxxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWEG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8AqQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQUEAQQCAwoMUMMAAAAAAAAGAA==",
} as const;
