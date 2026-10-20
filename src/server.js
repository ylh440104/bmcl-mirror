import http from 'node:http'
import process from 'node:process'
import { cfg } from './config.js'
import { Cache, normalizePath } from './storage.js'
import { Semaphore } from './semaphore.js'
import { fetchFirst, readAll, pipeTo, isTextual } from './fetcher.js'
import { resolveTargets, resolveRedirect, rewriteText, routeTable, origins, publicBase } from './upstream.js'
import { contentTypeOf } from './mime.js'
import { jsonCache } from './ttl-cache.js'
import { createCompat } from './compat.js'
import { fetchOptifineList, resolveOptifineEntry, fetchOptifineJar } from './optifine.js'

const cache = new Cache()
const limiter = new Semaphore(cfg.maxDownloads)
const inflight = new Map()

const stats = {
  started: Date.now(),
  requests: 0,
  hits: 0,
  misses: 0,
  stale: 0,
  errors: 0,
  bytesOut: 0,
}

const sendRaw = (res, status, headers, body) => {
  if (res.writableEnded || res.destroyed) return true
  res.writeHead(status, { 'access-control-allow-origin': cfg.cors, ...headers })
  res.end(body)
  return true
}

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2)
  return sendRaw(res, status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }, body)
}

const fail = (res, status, message) => sendJson(res, status, { error: message, status })

const redirect = (res, location) => {
  if (res.writableEnded || res.destroyed) return true
  res.writeHead(302, { location, 'access-control-allow-origin': cfg.cors })
  res.end()
  return true
}

const fetchTextBody = async url => {
  const attempts = 3
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': cfg.userAgent },
        signal: AbortSignal.timeout(cfg.upstreamTimeout),
      })
      if (res.status === 404 || res.status === 410) {
        const err = new Error(`${res.status} ${url}`)
        err.status = res.status
        throw err
      }
      if (!res.ok) {
        lastError = new Error(`${res.status} ${url}`)
        lastError.status = res.status
        await new Promise(resolve => setTimeout(resolve, 400 * attempt))
        continue
      }
      return res.text()
    } catch (err) {
      if (err.status === 404 || err.status === 410) throw err
      lastError = err
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 400 * attempt))
    }
  }
  throw lastError ?? new Error(`failed ${url}`)
}

const compat = createCompat({ sendJson, fail, redirect, fetchText: fetchTextBody, cache: jsonCache })
const handleCompat = compat.handleCompat

const parseRange = (header, size) => {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end >= size || start > end) return { invalid: true }
  return { start, end }
}

const isFresh = entry =>
  entry.kind === 'text' ? Date.now() - entry.createdAt < cfg.metaTtl : cfg.fileTtl <= 0 || Date.now() - entry.createdAt < cfg.fileTtl

async function serveFromCache (req, res, key, entry, pathname) {
  const textEntry = entry.kind === 'text'

  if (textEntry) {
    const raw = await cache.readText(key)
    const body = Buffer.from(rewriteText(raw, publicBase(req)), 'utf8')
    sendRaw(res, 200, {
      'content-type': contentTypeOf(pathname, 'application/json; charset=utf-8'),
      'content-length': body.length,
      'cache-control': `public, max-age=${Math.max(1, Math.floor(cfg.metaTtl / 1000))}`,
    }, req.method === 'HEAD' ? undefined : body)
    stats.bytesOut += body.length
    return
  }

  const baseHeaders = {
    'content-type': contentTypeOf(pathname, entry.contentType),
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag: `"${entry.size.toString(16)}-${Math.floor(entry.createdAt).toString(16)}"`,
  }

  const range = parseRange(req.headers.range, entry.size)
  if (range?.invalid) {
    res.writeHead(416, { 'content-range': `bytes */${entry.size}`, 'access-control-allow-origin': cfg.cors })
    res.end()
    return
  }

  if (range) {
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${range.start}-${range.end}/${entry.size}`,
      'content-length': range.end - range.start + 1,
    })
    stats.bytesOut += range.end - range.start + 1
    if (req.method === 'HEAD') return res.end()
    const stream = await cache.openStream(key, range.start, range.end)
    if (!stream) return res.destroy()
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...baseHeaders, 'content-length': entry.size })
  stats.bytesOut += entry.size
  if (req.method === 'HEAD') return res.end()
  const stream = await cache.openStream(key)
  if (!stream) return res.destroy()
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

async function fetchText (key, response, pathname) {
  const body = await readAll(response, cfg.jsonMaxBytes)
  await cache.writeFile(key, body)
  return body
}

async function fetchBinary (key, response, res, pathname) {
  const contentType = contentTypeOf(pathname, response.headers.get('content-type'))
  const sink = await cache.createSink(key)
  const declared = response.headers.get('content-length')
  const headers = {
    'content-type': contentType,
    'cache-control': 'public, max-age=31536000, immutable',
  }
  if (declared) headers['content-length'] = declared
  res.writeHead(200, { 'access-control-allow-origin': cfg.cors, ...headers })
  try {
    const { total, clientGone } = await pipeTo(response, res, sink)
    if (clientGone) {
      await sink.commit(undefined)
      return
    }
    await sink.commit(total)
    if (!res.writableEnded) res.end()
  } catch (err) {
    await sink.abort()
    throw err
  }
}

async function proxyRange (req, res, targets, pathname, range) {
  const { response, failures } = await limiter.run(() => fetchFirst(targets, { headers: { range } }))
  if (!response) throw Object.assign(new Error(`all upstreams failed: ${failures.join(' ; ')}`), { upstream: true })

  const headers = {
    'content-type': contentTypeOf(pathname, response.headers.get('content-type')),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
  }
  for (const name of ['content-length', 'content-range']) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(response.status, { 'access-control-allow-origin': cfg.cors, ...headers })
  if (req.method === 'HEAD') {
    await response.body?.cancel().catch(() => {})
    return res.end()
  }
  const { total, clientGone } = await pipeTo(response, res, null)
  stats.bytesOut += total
  if (!clientGone && !res.writableEnded) res.end()
}

async function serveOptifineJar (req, res, pathname) {
  const match = /^\/maven\/com\/optifine\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (!match) return fail(res, 404, 'no such optifine artifact')

  const filename = decodeURIComponent(match[2])

  const key = pathname
  const cached = cache.get(key)
  if (cached && isFresh(cached)) {
    stats.hits += 1
    return serveFromCache(req, res, key, cached, pathname)
  }

  const entries = await jsonCache.load('optifine:list', () => fetchOptifineList(), 3600 * 1000)
  const entry = entries.find(e => e.filename === filename)
  if (!entry) return fail(res, 404, 'no such optifine artifact')

  const sink = await cache.createSink(key)
  try {
    const jar = await fetchOptifineJar(entry)
    const headers = { 'content-type': 'application/java-archive', 'cache-control': 'public, max-age=31536000, immutable' }
    if (jar.size) headers['content-length'] = jar.size
    res.writeHead(200, { 'access-control-allow-origin': cfg.cors, ...headers })
    const { total, clientGone } = await pipeTo({ body: jar.stream }, res, sink)
    await sink.commit(total)
    stats.bytesOut += total
    if (!clientGone && !res.writableEnded) res.end()
    return true
  } catch (err) {
    await sink.abort()
    stats.errors += 1
    console.error(`[optifine] ${pathname}: ${err.message}`)
    if (!res.headersSent) return fail(res, 502, err.message)
    return res.destroy()
  }
}

async function handle (req, res, url, pathname) {
  if (pathname.startsWith('/maven/com/optifine/')) {
    return serveOptifineJar(req, res, pathname)
  }

  const compat = await handleCompat(req, res, url, pathname)
  if (compat) return

  const redirected = resolveRedirect(url)
  if (redirected) {
    res.writeHead(302, { location: redirected, 'access-control-allow-origin': cfg.cors })
    return res.end()
  }

  if (pathname === '/') {
    return sendJson(res, 200, {
      service: 'bmcl-mirror',
      uptime: Math.floor((Date.now() - stats.started) / 1000),
      base: publicBase(req),
      routes: routeTable(),
    })
  }
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true })
  if (pathname === '/_stats') return sendJson(res, 200, { ...stats, cache: cache.stats() })
  if (pathname === '/_routes') return sendJson(res, 200, routeTable())
  if (pathname === '/_origins') return sendJson(res, 200, origins)
  if (pathname === '/_purge') {
    const target = url.searchParams.get('path')
    if (!target) return fail(res, 400, 'path is required')
    let key
    try {
      key = normalizePath(target)
    } catch (err) {
      return fail(res, 400, err.message)
    }
    const existed = cache.entries.has(key)
    cache.drop(key)
    return sendJson(res, existed ? 200 : 404, { purged: existed, key })
  }

  const targets = resolveTargets(pathname)
  if (!targets.length) return fail(res, 404, `nothing mapped for ${pathname}`)

  const key = pathname
  const cached = cache.get(key)

  if (cached && isFresh(cached)) {
    stats.hits += 1
    return serveFromCache(req, res, key, cached, pathname)
  }

  if (inflight.has(key)) {
    await inflight.get(key).catch(() => {})
    const merged = cache.get(key)
    if (merged) {
      stats.hits += 1
      return serveFromCache(req, res, key, merged, pathname)
    }
  }

  if (req.headers.range && !cached) {
    try {
      return await proxyRange(req, res, targets, pathname, req.headers.range)
    } catch (err) {
      stats.errors += 1
      if (!res.headersSent) return fail(res, 502, err.message)
      return res.destroy()
    }
  }

  stats.misses += 1
  const task = limiter.run(async () => {
    const { response, failures, target } = await fetchFirst(targets)
    if (!response) {
      const err = new Error(`all upstreams failed: ${failures.join(' ; ')}`)
      err.upstreamFailures = failures
      throw err
    }
    return { response, target }
  })

  inflight.set(key, task)

  let response
  try {
    const result = await task
    response = result.response
  } catch (err) {
    inflight.delete(key)
    stats.errors += 1
    if (cached) {
      stats.stale += 1
      console.warn(`[stale] ${pathname} -> ${err.message}`)
      return serveFromCache(req, res, key, cached, pathname)
    }
    console.warn(`[upstream] ${pathname} -> ${err.message}`)
    return fail(res, 502, err.message)
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }

  const contentType = contentTypeOf(pathname, response.headers.get('content-type'))
  const textual = isTextual(contentType) || Boolean(targets.length && pathname.endsWith('.json'))

  try {
    if (textual) {
      const body = await fetchText(key, response, pathname)
      const entry = cache.get(key) ?? { kind: 'text', size: body.length, createdAt: Date.now() }
      return serveFromCache(req, res, key, entry, pathname)
    }
    return fetchBinary(key, response, res, pathname)
  } catch (err) {
    stats.errors += 1
    console.error(`[fetch] ${pathname}: ${err.message}`)
    if (cached && !res.headersSent) return serveFromCache(req, res, key, cached, pathname)
    if (!res.headersSent) return fail(res, 502, err.message)
    res.destroy()
  }
}

const server = http.createServer(async (req, res) => {
  stats.requests += 1

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': cfg.cors,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-max-age': '86400',
    })
    return res.end()
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'only GET and HEAD are supported')

  let url
  try {
    url = new URL(req.url, 'http://mirror.local')
  } catch {
    return fail(res, 400, 'malformed request url')
  }

  let pathname
  try {
    pathname = normalizePath(decodeURIComponent(url.pathname))
  } catch (err) {
    return fail(res, 400, err.message)
  }

  try {
    await handle(req, res, url, pathname)
  } catch (err) {
    stats.errors += 1
    console.error('[server]', err)
    if (!res.headersSent) fail(res, 500, err.message)
    else res.destroy()
  }
})

server.keepAliveTimeout = 65000
server.headersTimeout = 66000
server.requestTimeout = 0

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  else socket.destroy()
  if (err.code !== 'ECONNRESET') console.warn('[server] clientError', err.code)
})

process.on('uncaughtException', err => {
  console.error('[server] uncaught exception', err)
})

process.on('unhandledRejection', reason => {
  console.error('[server] unhandled rejection', reason)
})

const shutdown = async signal => {
  console.log(`[server] ${signal} received, flushing cache index`)
  await cache.flush(true).catch(() => {})
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

await cache.init()
server.listen(cfg.port, cfg.host, () => {
  const info = cache.stats()
  console.log(`[server] listening on ${cfg.host}:${cfg.port}`)
  console.log(`[server] cache ${info.entries} files / ${info.bytes} bytes @ ${info.dir}`)
  if (cfg.baseUrl) console.log(`[server] public base url ${cfg.baseUrl}`)
  compat.startWarmers()
})