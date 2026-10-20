import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { cfg } from './config.js'
import { jsonCache } from './ttl-cache.js'
import * as forge from './forge-build.js'
import * as neo from './neoforge.js'
import * as lite from './liteloader.js'
import * as of from './optifine.js'
import { buildJavaList } from './java-list.js'

const forgeMaven = () => (process.env.BMCL_ORIGIN_FORGE_MAVEN || 'https://maven.minecraftforge.net').replace(/\/+$/, '')
const neoMavenRoot = () => {
  const base = (process.env.BMCL_ORIGIN_NEOFORGE_MAVEN || 'https://maven.neoforged.net/releases').replace(/\/+$/, '')
  const idx = base.indexOf('/releases')
  return idx === -1 ? base : base.slice(0, idx)
}

const stableId = value => createHash('sha1').update(String(value)).digest('hex').slice(0, 24)

export const createCompat = deps => {
  const { sendJson, fail, redirect, fetchText, cache } = deps

  const storeFile = () => path.join(cfg.cacheDir, 'compat', 'forge-builds.json')
  let forgeStore = null
  let forgeStoreDirty = false
  let flushTimer = null

  const loadStore = async () => {
    if (forgeStore) return forgeStore
    try {
      const raw = await fs.readFile(storeFile(), 'utf8')
      forgeStore = JSON.parse(raw)
    } catch {
      forgeStore = { version: 1, builds: {} }
    }
    if (!forgeStore.builds) forgeStore.builds = {}
    return forgeStore
  }

  const scheduleFlush = () => {
    forgeStoreDirty = true
    if (flushTimer) return
    flushTimer = setTimeout(async () => {
      flushTimer = null
      if (!forgeStoreDirty) return
      forgeStoreDirty = false
      try {
        const file = storeFile()
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(`${file}.tmp`, JSON.stringify(forgeStore))
        await fs.rename(`${file}.tmp`, file)
      } catch (err) {
        console.error('[compat] forge store flush failed:', err.message)
      }
    }, 4000)
    flushTimer.unref?.()
  }

  const persistBuild = async record => {
    const store = await loadStore()
    const key = String(record.build)
    if (store.builds[key]) return store.builds[key]
    store.builds[key] = record
    scheduleFlush()
    return record
  }

  const forgeMetadata = () =>
    cache.load('forge:metadata', async () => {
      const xml = await fetchText(`${forgeMaven()}/net/minecraftforge/forge/maven-metadata.xml`)
      const versions = forge.xmlVersions(xml)
      if (!versions.length) throw new Error('forge metadata empty')
      const { byBuild, byMc } = forge.buildIndex(versions)
      return { versions, latest: forge.xmlLatest(xml), byBuild, byMc }
    }, 6 * 3600 * 1000)

  let warmRunning = false

  const warmForge = async () => {
    if (warmRunning) return
    warmRunning = true
    const ttl = process.env.BMCL_FORGE_WARM_TTL === '0' ? 0 : Number.parseInt(process.env.BMCL_FORGE_WARM_TTL ?? '21600', 10) * 1000
    try {
      const meta = await forgeMetadata()
      const store = await loadStore()
      const missing = [...meta.byBuild.values()].filter(r => !store.builds[String(r.build)])
      if (!missing.length) return
      missing.sort((a, b) => b.build - a.build)
      console.log(`[warm] forge builds to fetch: ${missing.length}`)
      const started = Date.now()
      const budget = Number.parseInt(process.env.BMCL_FORGE_WARM_BUDGET ?? '600000', 10)
      const concurrency = Number.parseInt(process.env.BMCL_FORGE_WARM_CONCURRENCY ?? '4', 10)
      const pause = Number.parseInt(process.env.BMCL_FORGE_WARM_PAUSE ?? '50', 10)
      const queue = [...missing]
      const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length) {
          if (Date.now() - started > budget) return
          const record = queue.shift()
          try {
            await forgeHasher(record)
          } catch {}
          if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause))
        }
      })
      await Promise.all(workers)
      const after = await loadStore()
      console.log(`[warm] forge builds cached: ${Object.keys(after.builds).length} in ${Math.round((Date.now() - started) / 1000)}s`)
      if (queue.length) {
        const retry = setTimeout(() => warmForge().catch(() => {}), 5000)
        retry.unref?.()
        return
      }
      if (ttl > 0) {
        const timer = setTimeout(() => {
          warmForge().catch(err => console.error('[warm] failed', err.message))
        }, ttl)
        timer.unref?.()
      }
    } catch (err) {
      console.error('[warm] forge warmup failed:', err.message)
    } finally {
      warmRunning = false
    }
  }

  const startWarmers = () => {
    if (process.env.BMCL_WARMUP === '0') return
    const timer = setTimeout(() => {
      warmForge().catch(err => console.error('[warm] failed', err.message))
    }, 2000)
    timer.unref?.()
  }

  const forgeHasher = async record => {
    const store = await loadStore()
    const key = String(record.build)
    if (store.builds[key]) return store.builds[key]

    const artifact = forge.artifactOf(record)
    const legacy = forge.isLegacyBuild(record.version)
    const categories = forge.fileCategories(legacy)
    const base = `${artifact.dir}/${artifact.prefix}`

    const files = await Promise.all(categories.map(async ({ category, format }) => {
      const url = `${forgeMaven()}/${base}-${category}.${format}.sha1`
      try {
        const sha1 = (await fetchText(url)).trim().split(/\s+/)[0]
        if (/^[a-f0-9]{40}$/i.test(sha1)) return { format, category, hash: sha1.toLowerCase() }
      } catch {}
      return null
    }))

    const present = files.filter(Boolean)
    const order = { changelog: 0, installer: 1, mdk: 2, universal: 3, src: 4, javadoc: 5, 'installer-win': 6, userdev: 7 }
    present.sort((a, b) => (order[a.category] ?? 99) - (order[b.category] ?? 99))

    const payload = {
      _id: stableId(`forge-${record.full}`),
      build: record.build,
      mcversion: record.mcversion,
      version: record.version,
      branch: record.branch,
      modified: null,
      files: present,
    }
    return persistBuild(payload)
  }

  const forgeBuildObjects = async (records, budgetMs, concurrency = 32) => {
    const started = Date.now()
    const out = new Map()
    const queue = [...records]
    const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
      while (queue.length) {
        if (Date.now() - started > budgetMs) return
        const record = queue.shift()
        try {
          out.set(record.build, await forgeHasher(record))
        } catch {
          out.set(record.build, {
            _id: stableId(`forge-${record.full}`),
            build: record.build,
            mcversion: record.mcversion,
            version: record.version,
            branch: record.branch,
            modified: null,
            files: [],
          })
        }
      }
    })
    await Promise.all(workers)
    return [...out.values()].sort((a, b) => a.build - b.build)
  }

  const manifest = () =>
    cache.load('mojang:manifest', async () => {
      const raw = await fetchText('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
      return JSON.parse(raw)
    }, 300 * 1000)

  const versionJson = version =>
    cache.load(`mojang:version:${version}`, async () => {
      const list = await manifest()
      const entry = list.versions.find(v => v.id === version)
      if (!entry) throw new Error(`version ${version} not found`)
      const raw = await fetchText(entry.url)
      return JSON.parse(raw)
    }, 1800 * 1000)

  const liteloaderRecords = () =>
    cache.load('liteloader:records', async () => {
      const raw = await fetchText(lite.versionsUrl())
      const records = lite.parseLiteloader(JSON.parse(raw))
      if (!records.length) throw new Error('liteloader list empty')
      return records
    }, 6 * 3600 * 1000)

  const neoforgeRecords = async artifactId =>
    cache.load(`neoforge:records:${artifactId}`, async () => {
      const raw = await fetchText(neo.listEndpoint(artifactId))
      return neo.listRecords(artifactId, JSON.parse(raw))
    }, 6 * 3600 * 1000)

  const allNeoforge = async () => {
    const [a, b] = await Promise.all([neoforgeRecords('neoforge'), neoforgeRecords('forge')])
    const merged = [...a, ...b]
    for (const record of merged) neo.artifactRegistry.set(record.rawVersion, record.artifactId)
    return merged
  }

  const optifineList = () =>
    cache.load('optifine:list', async () => of.fetchOptifineList(), 3600 * 1000)

  const sponsors = () => {
    const raw = process.env.BMCL_SPONSORS || ''
    const items = raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .map((item, index) => {
        const [name, link] = item.split('|')
        return { _id: stableId(`sponsor-${index}-${name}`), name: name ?? item, link: link ?? '' }
      })
    if (!items.length) {
      return [{ _id: stableId('sponsor-self'), name: 'bmcl-mirror', link: '' }]
    }
    return items
  }

  const absolute = (req, target) => {
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim()
    const host = req.headers['x-forwarded-host'] || req.headers.host || ''
    if (!host) return target
    return `${cfg.baseUrl || `${proto === 'https' ? 'https' : 'http'}://${host}`}${target}`
  }

  const handleForge = async (req, res, url, pathname) => {
    if (pathname === '/forge/minecraft') {
      const meta = await forgeMetadata()
      const list = [...meta.byMc.keys()].sort()
      await sendJson(res, 200, list)
      return true
    }

    const byMc = /^\/forge\/minecraft\/(.+)$/.exec(pathname)
    if (byMc) {
      const meta = await forgeMetadata()
      const mcversion = decodeURIComponent(byMc[1])
      const records = meta.byMc.get(mcversion)
      if (!records) {
        await sendJson(res, 200, [])
        return true
      }
      const store = await loadStore()
      const cached = records.map(r => store.builds[String(r.build)]).filter(Boolean)
      if (cached.length === records.length) {
        await sendJson(res, 200, cached.sort((a, b) => a.build - b.build))
        return true
      }
      const objects = await forgeBuildObjects(records, 25000, 32)
      await sendJson(res, 200, objects)
      return true
    }

    const byList = /^\/forge\/list(?:\/(\d+))?(?:\/(\d+))?$/.exec(pathname)
    if (byList) {
      const meta = await forgeMetadata()
      const first = byList[1] ? Number.parseInt(byList[1], 10) : null
      const second = byList[2] ? Number.parseInt(byList[2], 10) : null
      let offset = 0
      let limit = 50
      if (second === null) {
        limit = Number.isFinite(first) && first > 0 ? Math.min(first, 500) : 50
      } else {
        offset = Number.isFinite(first) && first > 0 ? first : 0
        limit = Math.min(Number.isFinite(second) && second > 0 ? second : 50, 500)
      }
      const all = [...meta.byBuild.values()].sort((a, b) => a.build - b.build)
      const slice = all.slice(offset, offset + limit)
      const objects = await forgeBuildObjects(slice, 8000, 6)
      await sendJson(res, 200, objects)
      return true
    }

    if (pathname === '/forge/last' || pathname === '/forge/latest') {
      const meta = await forgeMetadata()
      const newest = [...meta.byBuild.values()].sort((a, b) => b.build - a.build)[0]
      if (!newest) {
        await fail(res, 404, 'no forge build')
        return true
      }
      const build = await forgeHasher(newest)
      await sendJson(res, 200, { _id: stableId('forge-latest'), name: 'latest', build, __v: 0 })
      return true
    }

    if (pathname === '/forge/promos') {
      const promotions = await cache.load('forge:promos', async () => {
        const raw = await fetchText('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')
        return forge.parsePromotions(JSON.parse(raw))
      }, 3600 * 1000)
      const meta = await forgeMetadata()
      const targets = []
      for (const promo of promotions) {
        const records = meta.byMc.get(promo.mcversion)
        if (!records) continue
        const record = records.find(r => r.version === promo.version)
        if (!record) continue
        targets.push({ name: `${promo.mcversion}-${promo.tag}`, record })
      }
      const out = []
      const queue = [...targets]
      const workers = Array.from({ length: Math.min(8, queue.length || 1) }, async () => {
        while (queue.length) {
          const item = queue.shift()
          try {
            out.push({ name: item.name, build: await forgeHasher(item.record) })
          } catch {}
        }
      })
      await Promise.all(workers)
      const order = new Map(targets.map((t, i) => [t.name, i]))
      out.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
      await sendJson(res, 200, out)
      return true
    }

    if (pathname === '/forge/download') {
      const mc = url.searchParams.get('mcversion')
      const version = url.searchParams.get('version')
      const category = url.searchParams.get('category')
      const format = url.searchParams.get('format')
      if (!mc || !version || !category || !format) {
        await fail(res, 400, 'missing query')
        return true
      }
      const branch = url.searchParams.get('branch')
      const base = forge.downloadBase(mc, version, branch)
      await redirect(res, absolute(req, `/maven/net/minecraftforge/forge/${base}/forge-${base}-${category}.${format}`))
      return true
    }

    const byBuild = /^\/forge\/download\/(\d+)$/.exec(pathname)
    if (byBuild) {
      const meta = await forgeMetadata()
      const record = meta.byBuild.get(Number.parseInt(byBuild[1], 10))
      if (!record) {
        await fail(res, 404, 'no such forge build')
        return true
      }
      const artifact = forge.artifactOf(record)
      const category = url.searchParams.get('category') ?? 'installer'
      const format = url.searchParams.get('format') ?? 'jar'
      await redirect(res, absolute(req, `/maven/net/minecraftforge/forge/${artifact.base}/${artifact.prefix}-${category}.${format}`))
      return true
    }

    return null
  }

  const handleLiteloader = async (req, res, url, pathname) => {
    if (pathname === '/liteloader/list') {
      const records = await liteloaderRecords()
      const mc = url.searchParams.get('mcversion')
      const shape = record => ({
        _id: stableId(`liteloader-${record.mcversion}-${record.version}`),
        ...lite.stripUndefined(lite.toApiShape(record)),
        __v: 0,
      })
      if (mc) {
        const record = records.find(r => r.mcversion === mc)
        if (!record) {
          await fail(res, 404, 'no such liteloader version')
          return true
        }
        await sendJson(res, 200, shape(record))
        return true
      }
      await sendJson(res, 200, records.map(shape))
      return true
    }

    if (pathname === '/liteloader/download') {
      const version = url.searchParams.get('version')
      if (!version) {
        await fail(res, 400, 'missing version')
        return true
      }
      const records = await liteloaderRecords()
      const record = lite.findLiteloader(records, version)
      if (!record) {
        await fail(res, 404, 'no such liteloader version')
        return true
      }
      await redirect(res, absolute(req, `/maven/${lite.jarPathFor(record)}`))
      return true
    }

    return null
  }

  const handleNeoforge = async (req, res, url, pathname) => {
    if (pathname === '/neoforge/meta' || pathname.startsWith('/neoforge/meta/')) {
      const rest = pathname.slice('/neoforge/meta'.length).replace(/^\/+/, '')
      if (!rest) {
        await fail(res, 400, 'missing meta path')
        return true
      }
      const body = await fetchText(`${neoMavenRoot()}/${rest}`)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return true
    }

    const byMc = /^\/neoforge\/list\/(.+)$/.exec(pathname)
    if (byMc) {
      const mcversion = decodeURIComponent(byMc[1])
      const all = await allNeoforge()
      const records = neo.filterByMc(all, mcversion)
      await sendJson(res, 200, records.map(record => ({
        _id: stableId(`neo-${record.rawVersion}`),
        ...neo.apiShape(record),
        __v: 0,
      })))
      return true
    }

    const byVersion = /^\/neoforge\/version\/([^/]+)$/.exec(pathname)
    if (byVersion) {
      const version = decodeURIComponent(byVersion[1])
      const all = await allNeoforge()
      const record = neo.findVersion(all, version)
      if (!record) {
        await fail(res, 404, 'no such neoforge version')
        return true
      }
      await sendJson(res, 200, {
        _id: stableId(`neo-${record.rawVersion}`),
        ...neo.apiShape(record),
        __v: 0,
      })
      return true
    }

    const byDownload = /^\/neoforge\/version\/([^/]+)\/download\/(.+)$/.exec(pathname)
    if (byDownload) {
      const version = decodeURIComponent(byDownload[1])
      const file = decodeURIComponent(byDownload[2])
      const all = await allNeoforge()
      const record = neo.findVersion(all, version)
      if (!record) {
        await fail(res, 404, 'no such neoforge version')
        return true
      }
      const resolved = neo.resolveNeoforgeFile(record, file)
      if (!resolved) {
        await fail(res, 400, 'unsupported file type')
        return true
      }
      await redirect(res, absolute(req, `/maven/${resolved.path}`))
      return true
    }

    return null
  }

  const optifineShape = entries =>
    entries.map(entry => ({
      _id: stableId(`optifine-${entry.filename}`),
      mcversion: entry.mcversion,
      patch: entry.patch,
      type: entry.type,
      __v: 0,
      filename: entry.filename,
      ...(entry.forge && entry.forge !== 'N/A' ? { forge: entry.forge } : {}),
    }))

  const handleOptifine = async (req, res, url, pathname) => {
    if (pathname === '/optifine/versionList') {
      const entries = await optifineList()
      await sendJson(res, 200, optifineShape(of.flattenOptifine(entries)))
      return true
    }

    const byMc = /^\/optifine\/([^/]+)$/.exec(pathname)
    if (byMc) {
      const mcversion = decodeURIComponent(byMc[1])
      const entries = await optifineList()
      const filtered = of.flattenOptifine(entries.filter(e => e.mcversion === mcversion))
      await sendJson(res, 200, optifineShape(filtered))
      return true
    }

    const byPatch = /^\/optifine\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (byPatch) {
      const mcversion = decodeURIComponent(byPatch[1])
      const type = decodeURIComponent(byPatch[2])
      const patch = decodeURIComponent(byPatch[3])
      const entries = await optifineList()
      const entry = of.resolveOptifineEntry(entries, mcversion, type, patch)
      if (!entry) {
        await fail(res, 404, 'no such optifine')
        return true
      }
      await redirect(res, absolute(req, `/maven/com/optifine/${mcversion}/${entry.filename}`))
      return true
    }

    return null
  }

  const handleVersion = async (req, res, url, pathname) => {
    const match = /^\/version\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (!match) return null
    const version = decodeURIComponent(match[1])
    const category = decodeURIComponent(match[2])

    if (category === 'json') {
      const list = await manifest()
      const entry = list.versions.find(v => v.id === version)
      if (!entry) {
        await fail(res, 404, 'no such version')
        return true
      }
      await redirect(res, absolute(req, new URL(entry.url).pathname))
      return true
    }

    if (category !== 'client' && category !== 'server') {
      await fail(res, 400, 'category must be client, server or json')
      return true
    }

    const json = await versionJson(version)
    const download = json?.downloads?.[category]
    if (!download?.url) {
      await fail(res, 404, `no ${category} download for ${version}`)
      return true
    }
    await redirect(res, absolute(req, new URL(download.url).pathname))
    return true
  }
  const handleCompat = async (req, res, url, pathname) => {
    try {
      return await routeCompat(req, res, url, pathname)
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502
      console.warn(`[compat] ${pathname} -> ${err.message}`)
      if (!res.headersSent && !res.writableEnded) {
        await fail(res, status, err.message)
      } else if (!res.writableEnded) {
        res.destroy()
      }
      return true
    }
  }

  const routeCompat = async (req, res, url, pathname) => {
    if (pathname === '/java/list') {
      const data = await cache.load('java:all', async () => {
        const raw = await fetchText('https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json')
        return JSON.parse(raw)
      }, 3600 * 1000)
      const list = buildJavaList(data)
      if (!list.length) {
        await fail(res, 503, 'java runtime index unavailable')
        return true
      }
      await sendJson(res, 200, list)
      return true
    }

    if (pathname === '/openbmclapi/sponsor') {
      const pool = sponsors()
      const picked = pool[Math.floor(Math.random() * pool.length)]
      await sendJson(res, 200, picked)
      return true
    }

    if (pathname === '/mirrors/authlib-injector') {
      await redirect(res, absolute(req, '/mirrors/authlib-injector/'))
      return true
    }

    const routes = [
      [pathname.startsWith('/forge/'), handleForge],
      [pathname.startsWith('/liteloader/'), handleLiteloader],
      [pathname.startsWith('/neoforge/'), handleNeoforge],
      [pathname.startsWith('/optifine/'), handleOptifine],
      [pathname.startsWith('/version/'), handleVersion],
    ]

    for (const [matches, handler] of routes) {
      if (!matches) continue
      const handled = await handler(req, res, url, pathname)
      if (handled === null) {
        await fail(res, 404, `unknown endpoint ${pathname}`)
      }
      return true
    }

    return false
  }

  return { handleCompat, startWarmers }
}

export const compatInternals = { stableId, forgeMaven, neoMavenRoot }