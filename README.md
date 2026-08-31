# @harpd/observe

The x402 V2 observability + budget-control extension for **Harpd** — the neutral
observability & control layer for agent payments, sitting *above* any Facilitator.

Zero runtime dependencies. Runs in Node and the browser.

## What it does

Registers the 4 x402 V2 lifecycle hooks and forwards every payment event to a
Harpd collector. Harpd **never** touches funds or signing keys; it only observes
and, when `budgetControl` is on, makes a pre-payment allow/deny decision.

| Hook | Purpose |
|------|----------|
| `before-payment` | Records intent; if `budgetControl`, returns the collector's atomic budget decision |
| `after-payment` | Records the payment event (amount, endpoint, agent, txHash, facilitator) |
| `before-settlement` | Records settlement intent |
| `after-settlement` | Records settlement result + triggers read-only on-chain verification |

## Usage

```js
import { harpdPlugin, simulatePayment } from '@harpd/observe'

const plugin = harpdPlugin({
  apiKey: 'harpd_live_xxx',
  endpoint: 'https://collector.harpd.workers.dev',
  budgetControl: true, // Phase 1 — block at the pre-payment hook
})

// In a real x402 V2 client, register `plugin` with your SDK:
//   const client = new x402.Client({ facilitator: 'coinbase', plugins: [plugin] })
//   await client.fetch('https://api.example.com/premium-data')

// Without a live Facilitator, drive the hooks in payment order:
await simulatePayment(plugin, {
  agentId: 'agent-1',
  url: 'https://api.example.com/premium-data',
  amount: 1_000_000, // USDC 6dp → $1.00
  asset: 'eip155:8453/erc20:0xusdc',
  chain: 'eip155:8453',
  txHash: '0xconfirmed_abc',
  facilitator: 'coinbase',
  settlementStatus: 'confirmed',
})
```

## Server side

```js
import { harpdServerPlugin } from '@harpd/observe'

const serverPlugin = harpdServerPlugin({
  apiKey: 'harpd_live_xxx',
  endpoint: 'https://collector.harpd.workers.dev',
})
// Register with your x402 V2 server middleware (e.g. @x402/paywall plugins).
```

## Strict control-plane settlement

Use `settlePayment` when every settlement must pass through Harpd policy,
budget, idempotency, facilitator verification and the commercial ledger:

```js
import { settlePayment } from '@harpd/observe'

await settlePayment({ apiKey: 'harpd_live_xxx', endpoint: 'https://api.harpd.com' }, {
  agentId: 'agent-1', url: 'https://api.example.com/premium-data',
  amount: 1_000_000, asset: 'eip155:8453/erc20:0xusdc', chain: 'eip155:8453',
  idempotencyKey: 'order-123',
})
```

Direct `after-settlement` ingest is rejected in production; use this method or
`POST /v1/gateway/settle` instead.

## Contract

- Events POST to `{endpoint}/v1/events` as a JSON array, authenticated by the
  `X-Harpd-Key` header.
- The pre-payment budget decision comes from `GET {endpoint}/v1/budget/check`.
- After settlement, `POST {endpoint}/v1/verify-onchain` triggers read-only
  `eth_getTransactionReceipt` verification + reconciliation.

See `harpd/v2` for the collector (Cloudflare Worker + D1 + Drizzle).

---

## About Harpd

[Harpd](https://harpd.com) is the AI Cost Intelligence platform for the agent era — measure, optimize and control production AI spend, from **[cost per successful task](https://harpd.com/cost-per-successful-task/)** to agent-payment budgets ([x402](https://github.com/harpd-dev/observe) / USDC).

- Website: <https://harpd.com>
- GitHub org: <https://github.com/harpd-dev>
- Contact: <mailto:harpdsupport@gmail.com>

