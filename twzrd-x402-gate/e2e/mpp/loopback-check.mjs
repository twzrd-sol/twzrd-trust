// No-spend check of pay-quick-once.mjs's payment path. Replays intel's live
// unpaid /quick 402 on 127.0.0.1, runs the script against it with a throwaway
// key, and reports whether exactly one MPP credential came back.
//   node loopback-check.mjs <throwaway-key.json>
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const live = await fetch('https://intel.twzrd.xyz/v1/intel/quick/GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs', { headers: { 'user-agent': 'twzrd-mpp-settle-test/1 loopback-check' } })
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' }
for (const h of ['www-authenticate', 'payment-required']) { const v = live.headers.get(h); if (v) headers[h] = v }
const body = await live.text()
console.log('live', live.status, 'www-authenticate starts', JSON.stringify((headers['www-authenticate'] || '').slice(0, 24)))

const auths = []
const srv = createServer((req, res) => {
  if (req.headers.authorization) {
    auths.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"loopback":"paid request received, nothing settled"}')
    return
  }
  res.writeHead(402, headers).end(body)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const child = spawn(process.execPath, [new URL('./pay-quick-once.mjs', import.meta.url).pathname, process.argv[2]], {
  env: { ...process.env, LOOPBACK: `http://127.0.0.1:${srv.address().port}` }, stdio: 'inherit',
})
const code = await new Promise((r) => child.on('exit', r))
srv.close()
console.log(`script exit ${code}; credentials received ${auths.length}; scheme ${auths[0]?.split(' ')[0] ?? 'none'}`)
process.exit(code === 0 && auths.length === 1 && auths[0].startsWith('Payment ') ? 0 : 1)
