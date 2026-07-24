// @harpd/observe — the x402 V2 observability + budget-control extension.
//
// Registers the 4 lifecycle hooks (before/after-payment,
// before/after-settlement) on an x402 V2 client/server plugin and
// forwards every payment event to a Harpd collector. Zero runtime
// dependencies — runs in Node and the browser.
//
// Harpd NEVER touches funds or keys; it only observes and, when
// budgetControl is enabled, makes a pre-payment allow/deny decision.
//
// Includes local event queue with persistence + exponential backoff retry
// for reliable delivery in unreliable network conditions.

export const EXTENSION_NAME = 'x-harpd-observe'
export const EXTENSION_VERSION = '1.0.0'

import { EventQueue, createQueueFromConfig } from './queue.js'

/**
 * @typedef {Object} PaymentContext
 * @property {string} agentId
 * @property {string} url               target x402 endpoint
 * @property {string|number} amount   smallest unit (USDC 6dp)
 * @property {string} asset             CAIP-19 token id
 * @property {string} [chain]         CAIP-2 chain id
 * @property {string} [txHash]
 * @property {string} [facilitator]
 * @property {'pending'|'confirmed'|'failed'} [settlementStatus]
 *
 * @typedef {Object} HarpdConfig
 * @property {string} apiKey
 * @property {string} endpoint         collector base URL
 * @property {boolean} [budgetControl]
 */

/** @param {HarpdConfig} config */
export function harpdPlugin(config) {
  const endpoint = String(config.endpoint).replace(/\/$/, '')
  const apiKey = config.apiKey

  // Create persistent queue for reliable delivery
  const queue = createQueueFromConfig({
    endpoint,
    apiKey,
    maxRetries: config.maxRetries ?? 10,
    batchSize: config.batchSize ?? 10,
    onQueueError: config.onQueueError,
    onQueueSuccess: config.onQueueSuccess,
  })
  
  // Start the queue processor
  queue.start()

  const enqueue = (events) => {
    events.forEach(e => queue.enqueue(e).catch(() => {}))
  }

  return {
    name: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    hooks: {
      /** @param {PaymentContext} ctx */
      'before-payment': async (ctx) => {
        // Best-effort record of payment intent (observability).
        enqueue([
          {
            hookType: 'before-payment',
            agentId: ctx.agentId,
            endpoint: ctx.url,
            amount: num(ctx.amount),
            token: ctx.asset,
            chain: ctx.chain || '',
            createdAt: nowIso(),
          },
        ])

        // If budget control is off, never block.
        if (!config.budgetControl) return { allowed: true }

        // Synchronous pre-payment decision from the collector's
        // atomic budget engine. The collector deducts on success.
        const url = `${endpoint}/v1/budget/check?agentId=${encodeURIComponent(
          ctx.agentId,
        )}&amount=${num(ctx.amount)}`
        const res = await fetch(url, { headers: { 'X-Harpd-Key': apiKey } })
        const decision = await res.json()
        return decision // { allowed, reason?, remaining?, spent?, budgetLimit?, pct? }
      },

      /** @param {PaymentContext} ctx */
      'after-payment': async (ctx) => {
        enqueue([
          {
            hookType: 'after-payment',
            agentId: ctx.agentId,
            endpoint: ctx.url,
            amount: num(ctx.amount),
            token: ctx.asset,
            chain: ctx.chain || '',
            txHash: ctx.txHash,
            facilitator: ctx.facilitator,
            createdAt: nowIso(),
          },
        ])
      },

      /** @param {PaymentContext} ctx */
      'before-settlement': async (ctx) => {
        enqueue([
          {
            hookType: 'before-settlement',
            agentId: ctx.agentId,
            endpoint: ctx.url,
            amount: num(ctx.amount),
            token: ctx.asset,
            chain: ctx.chain || '',
            txHash: ctx.txHash,
            facilitator: ctx.facilitator,
            createdAt: nowIso(),
          },
        ])
      },

      /** @param {PaymentContext} ctx */
      'after-settlement': async (ctx) => {
        enqueue([
          {
            hookType: 'after-settlement',
            agentId: ctx.agentId,
            endpoint: ctx.url,
            amount: num(ctx.amount),
            token: ctx.asset,
            chain: ctx.chain || '',
            txHash: ctx.txHash,
            facilitator: ctx.facilitator,
            settlementStatus: ctx.settlementStatus || 'pending',
            createdAt: nowIso(),
          },
        ])

        // Kick off read-only on-chain verification + reconciliation.
        if (ctx.txHash) {
          fetch(`${endpoint}/v1/verify-onchain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harpd-Key': apiKey },
            body: JSON.stringify({ txHash: ctx.txHash, chain: ctx.chain || '' }),
          }).catch(() => {})
        }
      },
    },
  }
}

/** Server-side variant (seller / API provider). Mirrors the same hooks. */
export function harpdServerPlugin(config) {
  return harpdPlugin(config)
}

/**
 * Drive the 4 hooks in payment order — a stand-in for a real x402 V2
 * runtime, used by demos, tests, and the e2e harness. It exercises the
 * exact same hook contract a real Facilitator would trigger.
 *
 * @param {{hooks: Record<string, Function>}} plugin
 * @param {PaymentContext} ctx
 */
export async function simulatePayment(plugin, ctx) {
  const h = plugin.hooks
  const before = await h['before-payment']?.(ctx)
  if (before && before.allowed === false) return { blocked: true, decision: before }
  await h['after-payment']?.(ctx)
  await h['before-settlement']?.(ctx)
  await h['after-settlement']?.(ctx)
  return { blocked: false, decision: before }
}

// --- internal helpers -------------------------------------------------------
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function nowIso() {
  return new Date().toISOString()
}
let _seq = 0
function withId(e) {
  _seq += 1
  return { id: `ev_${Date.now().toString(36)}_${_seq}`, ...e }
}
