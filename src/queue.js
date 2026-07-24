/**
 * Local event queue with persistence and retry logic.
 * Usage:
 *   const queue = new EventQueue(collectorEndpoint, apiKey)
 *   queue.enqueue(eventPayload)
 *   queue.start() // begins processing loop
 */

import { QueueStorage, backoffDelay, MAX_RETRIES } from './storage.js'

/**
 * Main queue class - enqueue events and process with retry.
 */
export class EventQueue {
  /**
   * @param {string} collectorEndpoint - e.g., "https://collector.harpd.workers.dev"
   * @param {string} apiKey - Harpd API key
   * @param {Object} options
   * @param {number} [options.batchSize=10] - Max events per batch POST
   * @param {number} [options.maxConcurrent=3] - Parallel batch sends
   */
  constructor(collectorEndpoint, apiKey, options = {}) {
    this.endpoint = collectorEndpoint.replace(/\/$/, '')
    this.apiKey = apiKey
    this.batchSize = options.batchSize ?? 10
    this.maxConcurrent = options.maxConcurrent ?? 3
    this.running = false
    this.processing = new Set()
  }

  /**
   * Add an event to the queue.
   * @param {Record<string, unknown>} payload - Event payload (no id needed)
   * @returns {string} The assigned event ID
   */
  async enqueue(payload) {
    const event = {
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      payload,
      attempts: 0,
      lastAttempt: 0,
      createdAt: new Date().toISOString(),
    }
    await QueueStorage.put(event)
    return event.id
  }

  /**
   * Start the background processing loop.
   * Call once after constructing the queue.
   */
  start() {
    if (this.running) return
    this.running = true
    this._loop()
  }

  /**
   * Stop the processing loop gracefully.
   */
  stop() {
    this.running = false
  }

  /**
   * Get current queue stats.
   * @returns {Promise<{pending: number, processing: number}>}
   */
  async stats() {
    const all = await QueueStorage.getAll()
    const pending = all.filter(e => e.attempts < MAX_RETRIES && !this.processing.has(e.id)).length
    const processing = this.processing.size
    return { pending, processing }
  }

  /**
   * Main processing loop - runs continuously while queue is running.
   */
  async _loop() {
    while (this.running) {
      try {
        await this._processBatch()
      } catch (err) {
        console.error('[harpd queue] processing error:', err)
      }
      // Small delay between batches
      await new Promise(r => setTimeout(r, 500))
    }
  }

  /**
   * Process one batch of events.
   */
  async _processBatch() {
    const all = await QueueStorage.getAll()
    const pending = all
      .filter(e => e.attempts < MAX_RETRIES && !this.processing.has(e.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.batchSize)

    if (pending.length === 0) return

    // Process in parallel up to maxConcurrent
    const chunks = []
    for (let i = 0; i < pending.length; i += this.maxConcurrent) {
      chunks.push(pending.slice(i, i + this.maxConcurrent))
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(e => this._sendEvent(e)))
    }
  }

  /**
   * Send a single event to the collector.
   * @param {QueuedEvent} event
   */
  async _sendEvent(event) {
    this.processing.add(event.id)
    event.attempts += 1
    event.lastAttempt = Date.now()
    await QueueStorage.put(event)

    try {
      const res = await fetch(`${this.endpoint}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Harpd-Key': this.apiKey,
        },
        body: JSON.stringify([event.payload]),
      })

      if (res.ok) {
        // Success - remove from queue
        await QueueStorage.delete(event.id)
      } else if (res.status >= 400 && res.status < 500) {
        // Client error (4xx) - don't retry, log and remove
        console.error('[harpd queue] Client error, dropping event:', res.status, await res.text())
        await QueueStorage.delete(event.id)
      } else {
        // Server error (5xx) - will retry via backoff
        console.warn('[harpd queue] Server error, will retry:', res.status)
      }
    } catch (err) {
      // Network error - will retry
      console.warn('[harpd queue] Network error, will retry:', err.message)
    } finally {
      this.processing.delete(event.id)
    }
  }
}

/**
 * Convenience function: create queue, enqueue, and wait for drain.
 * Useful for one-off scripts or tests.
 */
export async function flushQueue(collectorEndpoint, apiKey, events) {
  const queue = new EventQueue(collectorEndpoint, apiKey)
  for (const e of events) {
    await queue.enqueue(e)
  }
  queue.start()
  
  // Wait until queue is empty or max retries exhausted
  while (true) {
    const { pending, processing } = await queue.stats()
    if (pending === 0 && processing === 0) break
    await new Promise(r => setTimeout(r, 1000))
  }
  queue.stop()
}

// Export storage utilities for direct access if needed
export { QueueStorage, backoffDelay, MAX_RETRIES } from './storage.js'

/**
 * Build an EventQueue from a high-level config object (used by harpdPlugin).
 *
 * @param {Object} cfg
 * @param {string} cfg.endpoint - collector base URL
 * @param {string} cfg.apiKey - Harpd API key
 * @param {number} [cfg.maxRetries]
 * @param {number} [cfg.batchSize]
 * @param {number} [cfg.maxConcurrent]
 * @param {(e: unknown) => void} [cfg.onQueueError]
 * @param {(e: unknown) => void} [cfg.onQueueSuccess]
 * @returns {EventQueue}
 */
export function createQueueFromConfig(cfg = {}) {
  const queue = new EventQueue(cfg.endpoint, cfg.apiKey, {
    batchSize: cfg.batchSize,
    maxConcurrent: cfg.maxConcurrent,
  })
  if (typeof cfg.onQueueError === 'function') queue.onQueueError = cfg.onQueueError
  if (typeof cfg.onQueueSuccess === 'function') queue.onQueueSuccess = cfg.onQueueSuccess
  return queue
}