import { cfg } from './config.js'

export class TtlCache {
  constructor (defaultTtl = cfg.metaTtl) {
    this.defaultTtl = defaultTtl
    this.store = new Map()
    this.pending = new Map()
  }

  peek (key) {
    const item = this.store.get(key)
    if (!item) return null
    if (Date.now() > item.expireAt) return null
    return item.value
  }

  stale (key) {
    const item = this.store.get(key)
    return item ? item.value : null
  }

  set (key, value, ttl = this.defaultTtl) {
    this.store.set(key, { value, expireAt: Date.now() + ttl })
    return value
  }

  async load (key, loader, ttl = this.defaultTtl) {
    const fresh = this.peek(key)
    if (fresh !== null) return fresh

    if (this.pending.has(key)) {
      try {
        return await this.pending.get(key)
      } catch {
        const fallback = this.stale(key)
        if (fallback !== null) return fallback
        throw new Error(`load failed for ${key}`)
      }
    }

    const task = (async () => {
      const value = await loader()
      this.set(key, value, ttl)
      return value
    })()

    this.pending.set(key, task)
    try {
      return await task
    } catch (err) {
      const fallback = this.stale(key)
      if (fallback !== null) {
        console.warn(`[cache] ${key} load failed, serving stale: ${err.message}`)
        return fallback
      }
      throw err
    } finally {
      this.pending.delete(key)
    }
  }

  invalidate (key) {
    this.store.delete(key)
    return true
  }

  keys () {
    return [...this.store.keys()]
  }

  size () {
    return this.store.size
  }
}

export const jsonCache = new TtlCache(cfg.metaTtl)