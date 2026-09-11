# ElizaOS × Agent Commerce Kit

One copy-paste example that discovers two merchants, calls TWZRD preflight, refuses TWZRD's deliberate unsafe fixture before signing, permits a clean-control seller, simulates settlement and delivery, verifies the Ed25519 receipt, and exports its evidence bundle.

```bash
git clone https://github.com/twzrd-sol/twzrd-trust.git
cd twzrd-trust/agent-commerce-kit/examples/elizaos
npm install
npm start
```

`npm start` uses the public TWZRD preflight API and never broadcasts a transaction. For a deterministic no-network run:

```bash
npm run demo:offline
```

The live unsafe leg fails closed if its published fixture ever stops returning `block`; the example will not silently present a stale seller label as current trust evidence. The clean-control leg may return `warn` with `can_spend=true`, which remains an allowed policy path.

The exported `createAgentCommercePlugin()` is a standard ElizaOS plugin with one action, `TWZRD_AGENT_COMMERCE_JOURNEY`, so it can also be added directly to an agent's `plugins` array.

## Measurement

Every run emits four typed metrics to stderr: `kit_install`, `preflight_call`, `simulator_run`, and `verified_journey`. Each event must carry one non-overlapping activity class: `external` (default), `house`, or `sponsored`.

```bash
TWZRD_ACTIVITY=external TWZRD_RUN_ID=my-agent-001 npm start
TWZRD_ACTIVITY=house npm run demo:offline
```

Set `TWZRD_METRICS_URL` to send the same JSON events to an opt-in collector. `kit_install` is an explicit example-start acknowledgement rather than a hidden npm install beacon; registry downloads should be reported separately and never presented as verified journeys.
