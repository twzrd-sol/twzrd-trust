// A loopback-only guard on net.Socket.prototype.connect for the length of a
// run. http, https and fetch all connect through that method. The guard allows
// TCP to 127.0.0.1 and ::1 only and counts those connections. It refuses every
// other connect (another address, any hostname including localhost, a local
// socket path) before a DNS lookup or a packet. UDP and other processes are
// outside it; the run uses neither. It is demo instrumentation: it is what
// lets the transcript count the connections a run made.
import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

function connectTarget(args) {
  // net.connect() hands Socket#connect its normalized [options, callback] pair.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    if (first.path != null) return { allowed: false, where: `local socket ${first.path}` };
    const host = String(first.host ?? "localhost");
    return { allowed: LOOPBACK.has(host), where: `${host}:${first.port}` };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { allowed: false, where: `local socket ${first}` };
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { allowed: LOOPBACK.has(host), where: `${host}:${first}` };
}

export function installNetGuard() {
  const original = net.Socket.prototype.connect;
  const stats = { connections: 0, refused: 0, refused_targets: [] };
  net.Socket.prototype.connect = function loopbackOnlyConnect(...args) {
    const target = connectTarget(args);
    if (target.allowed) {
      stats.connections += 1;
      return original.apply(this, args);
    }
    stats.refused += 1;
    stats.refused_targets.push(target.where);
    const error = new Error(`loopback-only guard refused a connection to ${target.where}`);
    error.code = "ERR_SHOWCASE_LOOPBACK_ONLY";
    process.nextTick(() => this.destroy(error));
    return this;
  };
  return {
    stats,
    uninstall() {
      net.Socket.prototype.connect = original;
    },
  };
}
