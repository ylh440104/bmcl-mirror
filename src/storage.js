import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { cfg } from './config.js'

const encodeSegment = seg =>
  encodeURIComponent(seg).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())

const decodeSegment = seg => {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

export const normalizePath = raw => {
  const clean = String(raw).split('?')[0]
  const segments = clean.split('/').filter(Boolean)
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || seg.includes('\0')) throw new Error('invalid path segment')
  }
  return segments.length ? '/' + segments.join('/') : '/'
}

export const keyOf = normalizePath

export const kindOf = key => (key.toLowerCase().endsWith('.json') ? 'text' : 'binary')

export class Cache {
  constructor () {
    this.entries = new Map()
    this.totalBytes = 0
    this.dirty = false
    this.timer = null
  }

  indexFile () {
    return path.join(cfg.cacheDir, '.index.json')
  }

  filePath (key) {
    const segments = key.split('/').filter(Boolean).map(encodeSegment)
    return path.join(cfg.cacheDir, ...segments)
  }

  async init () {
    await fs.mkdir(cfg.cacheDir, { recursive: true })
    let loaded = false
    try {
      const raw = await fs.readFile(this.indexFile(), 'utf8')
      const parsed = JSON.parse(raw)
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (!entry || typeof entry.size !== 'number') continue
        this.entries.set(key, entry)
        this.totalBytes += entry.size
      }
      loaded = true
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[cache] index unusable, rebuilding:', err.message)
    }
    if (!loaded) await this.rebuild()
    if (this.totalBytes > cfg.cacheMaxBytes) await this.evict()
    return this
  }

  async rebuild () {
    const found = new Map()
    let total = 0
    const walk = async (dir, prefix) => {
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        if (item.name.startsWith('.')) continue
        const full = path.join(dir, item.name)
        const key = `${prefix}/${decodeSegment(item.name)}`
        if (item.isDirectory()) {
          await walk(full, key)
          continue
        }
        if (item.name.endsWith('.tmp')) continue
        const stat = await fs.stat(full).catch(() => null)
        if (!stat) continue
        found.set(key, { size: stat.size, kind: kindOf(key), createdAt: stat.mtimeMs, at: stat.mtimeMs })
        total += stat.size
      }
    }
    await walk(cfg.cacheDir, '')
    this.entries = found
    this.totalBytes = total
    console.log(`[cache] rebuilt index: ${found.size} files, ${total} bytes`)
    await this.flush(true)
  }

  async ensureDir (key) {
    await fs.mkdir(path.dirname(this.filePath(key)), { recursive: true })
  }

  get (key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    entry.at = Date.now()
    return entry
  }

  async openStream (key, start, end) {
    if (!this.entries.has(key)) return null
    const file = this.filePath(key)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat) {
      this.drop(key)
      return null
    }
    const stream = start === undefined ? createReadStream(file) : createReadStream(file, { start, end })
    return stream
  }

  async createSink (key) {
    await this.ensureDir(key)
    const file = this.filePath(key)
    const tmp = `${file}.${process.pid}.tmp`
    const stream = createWriteStream(tmp)
    let settled = false
    return {
      write: chunk => stream.write(chunk),
      waitDrain: () => new Promise(resolve => stream.once('drain', resolve)),
      commit: async expected => {
        if (settled) return false
        settled = true
        await new Promise((resolve, reject) => {
          stream.once('error', reject)
          stream.end(resolve)
        })
        const stat = await fs.stat(tmp)
        const wanted = Number.parseInt(expected ?? '', 10)
        if (Number.isFinite(wanted) && wanted !== stat.size) {
          await fs.rm(tmp, { force: true }).catch(() => {})
          throw new Error(`size mismatch: got ${stat.size}, expected ${wanted}`)
        }
        await fs.rename(tmp, file)
        this.add(key, stat.size, kindOf(key))
        return true
      },
      abort: async () => {
        if (settled) return
        settled = true
        stream.destroy()
        await fs.rm(tmp, { force: true }).catch(() => {})
      },
    }
  }

  async writeFile (key, buffer) {
    await this.ensureDir(key)
    const file = this.filePath(key)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, buffer)
    await fs.rename(tmp, file)
    this.add(key, buffer.length, kindOf(key))
  }

  async readText (key) {
    return fs.readFile(this.filePath(key), 'utf8')
  }

  add (key, size, kind) {
    const prev = this.entries.get(key)
    if (prev) this.totalBytes -= prev.size
    const now = Date.now()
    this.entries.set(key, { size, kind, createdAt: now, at: now })
    this.totalBytes += size
    this.dirty = true
    this.scheduleFlush()
    if (this.totalBytes > cfg.cacheMaxBytes) {
      this.evict().catch(err => console.error('[cache] evict failed:', err.message))
    }
  }

  drop (key) {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.totalBytes -= entry.size
      this.dirty = true
      this.scheduleFlush()
    }
    fs.rm(this.filePath(key), { force: true }).catch(() => {})
  }

  async evict () {
    if (this.totalBytes <= cfg.cacheMaxBytes) return
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)
    let removed = 0
    for (const [key, entry] of sorted) {
      if (this.totalBytes <= cfg.cacheMaxBytes) break
      this.entries.delete(key)
      this.totalBytes -= entry.size
      removed += 1
      await fs.rm(this.filePath(key), { force: true }).catch(() => {})
    }
    this.dirty = true
    this.scheduleFlush()
    if (removed) console.log(`[cache] evicted ${removed} files, now ${this.totalBytes} bytes`)
  }

  scheduleFlush () {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(err => console.error('[cache] flush failed:', err.message))
    }, 2000)
    this.timer.unref?.()
  }

  async flush (force = false) {
    if (!force && !this.dirty) return
    this.dirty = false
    const payload = JSON.stringify({ version: 1, savedAt: Date.now(), entries: Object.fromEntries(this.entries) })
    const target = this.indexFile()
    const tmp = `${target}.${process.pid}.tmp`
    try {
      await fs.writeFile(tmp, payload)
      await fs.rename(tmp, target)
    } catch (err) {
      console.error('[cache] index write failed:', err.message)
    }
  }

  stats () {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: cfg.cacheMaxBytes,
      dir: path.resolve(cfg.cacheDir),
    }
  }
}