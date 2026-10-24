// Test-process guard, not a sandbox for untrusted code. Only literal loopback
// TCP and local IPC are permitted; loaded SDKs cannot fall back to public RPC.
const net = require('node:net');
const key = Symbol.for('twzrd.offline.network');
let denied = 0;
const allowed = host => host === '127.0.0.1' || host === '::1' || host === '[::1]';
function refuse(destination) {
  denied++;
  const error = new Error(`OFFLINE_EGRESS_DENIED: ${destination}`);
  error.code = 'OFFLINE_EGRESS_DENIED';
  throw error;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  if (first && typeof first === 'object') {
    if (!first.path && !allowed(first.host ?? first.hostname ?? 'localhost')) refuse(first.host ?? first.hostname ?? 'localhost');
  } else if (!(typeof first === 'string' && !/^\d+$/.test(first))) {
    if (!allowed(normalized[1])) refuse(normalized[1] ?? 'localhost');
  }
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowed(url.hostname)) refuse(url.origin);
  return fetch(input, init);
};
Object.defineProperty(globalThis, key, {
  value: Object.freeze({ enabled: true, deniedCount: () => denied }),
});
