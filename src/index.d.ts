export const EXTENSION_NAME: string
export const EXTENSION_VERSION: string

export interface PaymentContext {
  agentId: string
  url: string
  amount: string | number
  asset: string
  chain?: string
  txHash?: string
  facilitator?: string
  settlementStatus?: 'pending' | 'confirmed' | 'failed'
}

export interface HarpdConfig {
  apiKey: string
  endpoint: string
  budgetControl?: boolean
  /** Maximum retry attempts for failed deliveries (default: 10) */
  maxRetries?: number
  /** Maximum events per batch POST (default: 10) */
  batchSize?: number
  /** Callback when queue encounters an error */
  onQueueError?: (error: Error, event: QueuedEvent) => void
  /** Callback when queue successfully delivers an event */
  onQueueSuccess?: (event: QueuedEvent) => void
}

export interface BudgetDecision {
  allowed: boolean
  reason?: string
  remaining?: number
  spent?: number
  budgetLimit?: number
  pct?: number
}

export interface HarpdExtension {
  name: string
  version: string
  hooks: {
    'before-payment': (ctx: PaymentContext) => Promise<BudgetDecision | { allowed: true }>
    'after-payment': (ctx: PaymentContext) => Promise<void>
    'before-settlement': (ctx: PaymentContext) => Promise<void>
    'after-settlement': (ctx: PaymentContext) => Promise<void>
  }
}

export interface QueuedEvent {
  id: string
  payload: Record<string, unknown>
  attempts: number
  lastAttempt: number
  createdAt: string
}

export interface EventQueueOptions {
  batchSize?: number
  maxConcurrent?: number
}

export interface EventQueueStats {
  pending: number
  processing: number
}

export class EventQueue {
  constructor(collectorEndpoint: string, apiKey: string, options?: EventQueueOptions)
  enqueue(payload: Record<string, unknown>): Promise<string>
  start(): void
  stop(): void
  stats(): Promise<EventQueueStats>
}

/** Create a queue, enqueue events, and wait for all to be delivered or exhausted. */
export function flushQueue(
  collectorEndpoint: string,
  apiKey: string,
  events: Record<string, unknown>[]
): Promise<void>

export function harpdPlugin(config: HarpdConfig): HarpdExtension
export function harpdServerPlugin(config: HarpdConfig): HarpdExtension
export function simulatePayment(
  plugin: HarpdExtension,
  ctx: PaymentContext
): Promise<{ blocked: boolean; decision: any }>