/**
 * Cross-platform persistent storage for the event queue.
 * - Browser: IndexedDB
 * - Node.js: File system (JSON lines)
 */

const STORE_NAME = 'harpd_event_queue'
const DB_NAME = 'harpd-observe'
const DB_VERSION = 1

/**
 * @typedef {Object} QueuedEvent
 * @property {string} id
 * @property {Record<string, unknown>} payload
 * @property {number} attempts
 * @property {number} lastAttempt
 * @property {string} createdAt
 */

const MAX_RETRIES = 10
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60000

/** @type {IDBDatabase | null} */
let idbCache = null
/** @type {Promise<IDBDatabase> | null} */
let idbPromise = null

/**
 * Get IndexedDB instance (browser only).
 */
async function getIDB() {
  if (idbCache) return idbCache
  if (!idbPromise) {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB not available')
    }
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  idbCache = await idbPromise
  return idbCache
}

/**
 * Node.js file-based fallback storage.
 */
const fs = typeof require !== 'undefined' ? require('fs') : null
const path = typeof require !== 'undefined' ? require('path') : null
const FILE_PATH = path ? path.join(process.cwd(), '.harpd-queue.json') : null

function readFileQueue() {
  if (!fs || !FILE_PATH) return []
  try {
    const data = fs.readFileSync(FILE_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

function writeFileQueue(queue) {
  if (!fs || !FILE_PATH) return
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(queue), 'utf-8')
  } catch {
    // ignore write errors in read-only environments
  }
}

/**
 * Unified storage interface.
 */
export const QueueStorage = {
  async getAll() {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await getIDB()
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const store = tx.objectStore(STORE_NAME)
          const req = store.getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      } catch {
        // fall through to file
      }
    }
    return readFileQueue()
  },

  async put(event) {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await getIDB()
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          const req = store.put(event)
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } catch {
        // fall through
      }
    }
    const queue = readFileQueue()
    const idx = queue.findIndex(e => e.id === event.id)
    if (idx >= 0) queue[idx] = event
    else queue.push(event)
    writeFileQueue(queue)
  },

  async delete(id) {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await getIDB()
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          const req = store.delete(id)
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } catch {
        // fall through
      }
    }
    const queue = readFileQueue().filter(e => e.id !== id)
    writeFileQueue(queue)
  },

  async clear() {
    if (typeof indexedDB !== 'undefined') {
      try {
        const db = await getIDB()
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          const req = store.clear()
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } catch {
        // fall through
      }
    }
    writeFileQueue([])
  },
}

/**
 * Calculate exponential backoff delay with jitter.
 * @param {number} attempt - Current attempt number (0-indexed)
 * @returns {number} Delay in milliseconds
 */
export function backoffDelay(attempt) {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS)
  const jitter = delay * 0.2 * (Math.random() * 2 - 1)
  return Math.floor(delay + jitter)
}

export { MAX_RETRIES, BASE_DELAY_MS, MAX_DELAY_MS }