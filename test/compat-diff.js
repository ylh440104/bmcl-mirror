import http from 'node:http'
import https from 'node:https'

const LOCAL = process.env.LOCAL || 'http://127.0.0.1:18081'
const REAL = process.env.REAL || 'https://bmclapi2.bangbang93.com'

const get = (url, timeout = 180000) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { 'user-agent': 'compat-probe/1.0' } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
    req.end()
  })

const getHttps = async (url, timeout = 180000, depth = 0, attempt = 1) => {
  try {
    return await getHttpsOnce(url, timeout, depth)
  } catch (err) {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, 600 * attempt))
      return getHttps(url, timeout, depth, attempt + 1)
    }
    throw err
  }
}

const getHttpsOnce = (url, timeout, depth) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'user-agent': 'compat-probe/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(getHttps(next, timeout, depth + 1))
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
    req.end()
  })

const getLocal = (url, timeout = 180000, depth = 0) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { 'user-agent': 'compat-probe/1.0' }, method: 'GET' }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(getLocal(next, timeout, depth + 1))
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
    req.end()
  })

const json = buf => {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

const cases = [
  { path: '/mc/game/version_manifest_v2.json' },
  { path: '/forge/minecraft' },
  { path: '/forge/minecraft/1.20.1' },
  { path: '/forge/list/0/3', min: 0.6 },
  { path: '/forge/last' },
  { path: '/forge/promos', min: 0.9 },
  { path: '/liteloader/list' },
  { path: '/liteloader/list?mcversion=1.12.2' },
  { path: '/neoforge/list/1.20.1' },
  { path: '/neoforge/list/1.21.1' },
  { path: '/neoforge/version/47.1.5' },
  { path: '/neoforge/version/20.2.3-beta' },
  { path: '/optifine/versionList', min: 0.4 },
  { path: '/optifine/1.20.1', min: 0.1 },
  { path: '/openbmclapi/sponsor' },
]

const redirects = [
  '/forge/download?mcversion=1.20.1&version=47.2.0&category=installer&format=jar',
  '/forge/download/47020000',
  '/forge/download/1614',
  '/liteloader/download?version=1.12.2',
  '/liteloader/download?version=1.7.10_04',
  '/neoforge/version/47.1.5/download/installer.jar',
  '/neoforge/version/20.2.3-beta/download/installer.jar',
  '/optifine/1.20.1/HD_U/I5',
  '/version/1.20.1/client',
  '/version/1.20.1/server',
  '/version/1.20.1/json',
]

const fmt = v => (v === undefined || v === null ? '-' : String(v))

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

const compareBodies = (label, mine, theirs, min = 0.98) => {
  const a = json(mine)
  const b = json(theirs)
  if (!a || !b) return record(label, false, 'not json')

  if (Array.isArray(a) && Array.isArray(b)) {
    const keyOf = item => {
      if (typeof item === 'string') return `s:${item}`
      if (item?.filename) return `file:${item.filename}`
      if (item?.rawVersion) return `raw:${item.rawVersion}`
      if (item?.name) return `promo:${item.name}`
      if (item?.build !== undefined && item?.version) return `v:${item.mcversion}:${item.version}`
      if (item?.mcversion !== undefined && item?.patch !== undefined) return `of:${item.mcversion}:${item.type}:${item.patch}`
      return JSON.stringify(item)
    }
    const mineKeys = new Set(a.map(keyOf))
    const realKeys = new Set(b.map(keyOf))
    const covered = [...realKeys].filter(k => mineKeys.has(k)).length
    const missing = [...realKeys].filter(k => !mineKeys.has(k))
    const ratio = realKeys.size ? covered / realKeys.size : 1
    const detail = `real=${realKeys.size} covered=${covered} (${(ratio * 100).toFixed(1)}%) missing=${missing.length}`
    record(label, ratio >= min, detail + (missing.length && missing.length <= 5 ? ` [${missing.join(' ')}]` : ''))
    return
  }

  const mineKeys = Object.keys(a).sort().join(',')
  const realKeys = Object.keys(b).sort().join(',')
  record(label, mineKeys === realKeys, `mine=[${mineKeys}] real=[${realKeys}]`)
}

const main = async () => {
  for (const c of cases) {
    try {
      const mine = await getLocal(`${LOCAL}${c.path}`)
      const theirs = await getHttps(`${REAL}${c.path}`)
      if (mine.status !== 200) {
        record(c.path, false, `status ${mine.status}`)
        continue
      }
      compareBodies(c.path, mine.body, theirs.body, c.min ?? 0.98)
    } catch (err) {
      record(c.path, false, err.message)
    }
  }

  for (const path of redirects) {
    try {
      const mine = await getLocal(`${LOCAL}${path}`)
      const theirs = await getHttps(`${REAL}${path}`)
      const norm = value => {
        if (!value) return null
        try {
          return new URL(value, 'http://x').pathname
        } catch {
          return value
        }
      }
      const a = norm(mine.headers.location)
      const b = norm(theirs.headers.location)

      if (theirs.status === 404) {
        const same = mine.status === 404
        record(`redirect ${path}`, same, `mine=${mine.status} | real=404 (both absent)`)
        continue
      }

      const same = (mine.status === 302 || mine.status === 200) && a === b
      record(`redirect ${path}`, same, `mine=${mine.status} ${a} | real=${theirs.status} ${b}`)
    } catch (err) {
      record(`redirect ${path}`, false, err.message)
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log(`${results.length - failed.length}/${results.length} matched`)
  if (failed.length) process.exitCode = 1
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})