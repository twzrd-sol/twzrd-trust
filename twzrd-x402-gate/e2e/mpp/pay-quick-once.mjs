// One real MPP payment: 0.001 USDC from the proof payer to intel /quick, once.
//   node pay-quick-once.mjs <path to proof-payer.json>
// Refuses unless the key derives to the pinned proof payer (settle_gate.py:
// "facilitator dogfood payer") and the challenge is exactly 1000 base units of
// USDC to GFpLvoc via solana/charge. No retries. Prints public values only.
import { readFileSync } from 'node:fs'
import { Mppx } from 'mppx/client'
import { charge } from '@solana/mpp/client'
import { createKeyPairSignerFromBytes } from '@solana/kit'

const PAYER = '64NsKhbNGZCEj6sgTtjzscfuXSZSEpD1GoBXbT45yv4J'
const RECIPIENT = 'GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
// Dry run: LOOPBACK=http://127.0.0.1:<port> (see loopback-check.mjs). Loopback
// cannot settle anything, so only there is the payer pin skipped.
const LOOPBACK = process.env.LOOPBACK
if (LOOPBACK && !/^http:\/\/127\.0\.0\.1:\d+$/.test(LOOPBACK)) { console.error('REFUSE: LOOPBACK must be http://127.0.0.1:<port>'); process.exit(2) }
const URL_ = `${LOOPBACK || 'https://intel.twzrd.xyz'}/v1/intel/quick/${RECIPIENT}`

const keyPath = process.argv[2]
if (!keyPath) { console.error('usage: node pay-quick-once.mjs <proof-payer.json>'); process.exit(2) }
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
console.log('payer', signer.address, LOOPBACK ? '(loopback dry run)' : '')
if (!LOOPBACK && signer.address !== PAYER) { console.error(`REFUSE: key is not the proof payer ${PAYER}`); process.exit(3) }

let approved = null
const mppx = Mppx.create({
  polyfill: false,
  // mppx loops `retry < maxPaymentRetries`: 0 never sends the paid request.
  // 1 sends it once; the `approved` guard refuses any second challenge.
  maxPaymentRetries: 1,
  methods: [charge({ signer, rpcUrl: 'https://api.mainnet-beta.solana.com' })],
  onChallenge: async (c, { createCredential }) => {
    const r = c.request ?? {}
    const ok = c.method === 'solana' && c.intent === 'charge' && r.amount === '1000'
      && r.currency === USDC && r.recipient === RECIPIENT && r.methodDetails?.network === 'mainnet'
    console.log('challenge', JSON.stringify({ id: c.id, method: c.method, intent: c.intent, amount: r.amount, currency: r.currency, recipient: r.recipient, network: r.methodDetails?.network, feePayerKey: r.methodDetails?.feePayerKey }))
    if (!ok) throw new Error('REFUSE: challenge is not exactly 0.001 USDC to GFpLvoc on solana/charge')
    if (approved) throw new Error('REFUSE: second challenge; paying once only')
    approved = c.id
    return createCredential()
  },
})

const res = await mppx.fetch(URL_, { headers: { 'user-agent': 'twzrd-mpp-settle-test/1 (house proof payer)' } })
console.log('status', res.status)
for (const h of ['payment-receipt', 'x-payment-response', 'payment-response']) {
  const v = res.headers.get(h); if (v) console.log(h, v.slice(0, 400))
}
// Intel sets Payment-Receipt only on a 2xx with a settled signature (_MppReceiptMiddleware):
// b64url JSON {method, reference, status, timestamp, challengeId}; reference = the tx signature.
const receipt = res.headers.get('payment-receipt')
if (receipt) console.log('receipt', Buffer.from(receipt, 'base64url').toString('utf8'))
console.log('body', (await res.text()).slice(0, 400))
