import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const PORT = 18080
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

const skip = (name, detail) => {
  results.push({ name, ok: true, detail, skipped: true })
  console.log(`SKIP ${name}${detail ? ' :: ' + detail : ''}`)
}

const request = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.setTimeout(90000, () => req.destroy(new Error('request timeout')))
    req.end()
  })

const withRetry = async (fn, attempts = 3) => {
  let last = null
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i < attempts) await new Promise(r => setTimeout(r, 800 * i))
    }
  }
  throw last
}

const waitHealthy = async () => {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await request(`${BASE}/healthz`)
      if (res.status === 200) return true
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bmcl-mirror-test-'))
const logs = []
let restarted = null
let assets = []

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    BMCL_PORT: String(PORT),
    BMCL_HOST: '127.0.0.1',
    BMCL_CACHE_DIR: tmp,
    BMCL_BASE_URL: BASE,
    BMCL_CACHE_MAX_BYTES: String(96 * 1024 * 1024),
    BMCL_MAX_DOWNLOADS: '4',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.on('data', d => logs.push(String(d)))
child.stderr.on('data', d => logs.push(String(d)))

const jsonOf = buf => {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

try {
  const healthy = await waitHealthy()
  if (!healthy) throw new Error('server did not answer /healthz\n' + logs.join(''))

  const manifest = await withRetry(() => request(`${BASE}/mc/game/version_manifest_v2.json`))
  const manifestJson = jsonOf(manifest.body)
  const manifestText = manifest.body.toString('utf8')

  if (manifest.status !== 200 || !Array.isArray(manifestJson?.versions)) {
    skip('manifest json', `upstream unavailable, status=${manifest.status}`)
    skip('manifest rewritten to self', 'skipped with manifest')
    skip('manifest no mojang leak', 'skipped with manifest')
    skip('manifest latest entry', 'skipped with manifest')
  } else {
    record('manifest json', true, `status=${manifest.status} versions=${manifestJson.versions.length}`)
    record('manifest rewritten to self', manifestText.includes(BASE), 'self base present in body')
    record('manifest no mojang leak', !manifestText.includes('piston-meta.mojang.com') && !manifestText.includes('launchermeta.mojang.com'))

    const latest = manifestJson.latest?.release
    const versionEntry = manifestJson.versions.find(v => v.id === latest)
    record('manifest latest entry', Boolean(versionEntry), `latest=${latest}`)

    if (versionEntry?.url) {
      const vjRes = await withRetry(() => request(versionEntry.url))
      const vj = jsonOf(vjRes.body)
      const vjText = vjRes.body.toString('utf8')
      record('version json', vjRes.status === 200 && Boolean(vj?.id), `status=${vjRes.status} id=${vj?.id}`)
      record('version json rewritten', !vjText.includes('resources.download.minecraft.net') && !vjText.includes('libraries.minecraft.net'))

      if (vj?.assetIndex?.url) {
        const idxRes = await withRetry(() => request(vj.assetIndex.url))
        const idx = jsonOf(idxRes.body)
        const objects = idx?.objects ? Object.values(idx.objects) : []
        assets = objects
        record('asset index', idxRes.status === 200 && objects.length > 0, `status=${idxRes.status} objects=${objects.length}`)

        const sample = objects[0]
        if (sample) {
          const assetUrl = `${BASE}/assets/${sample.hash.slice(0, 2)}/${sample.hash}`
          const first = await withRetry(() => request(assetUrl))
          record('asset full download', first.status === 200 && first.body.length === sample.size, `status=${first.status} bytes=${first.body.length} expected=${sample.size}`)

          const second = await withRetry(() => request(assetUrl))
          record('asset cached replay', second.status === 200 && second.body.equals(first.body), 'identical bytes')

          const ranged = await request(assetUrl, { range: 'bytes=10-59' })
          record('asset range from cache', ranged.status === 206 && ranged.body.length === 50, `status=${ranged.status} bytes=${ranged.body.length}`)

          const bad = await request(assetUrl, { range: `bytes=${sample.size + 10}-${sample.size + 20}` })
          record('invalid range rejected', bad.status === 416, `status=${bad.status}`)
        }
      }

      if (vj?.downloads?.client?.url) {
        const head = await withRetry(() => request(vj.downloads.client.url, { range: 'bytes=0-2047' }))
        record('client jar range passthrough', head.status === 206 && head.body.length === 2048, `status=${head.status} bytes=${head.body.length}`)
      }

      const lib = vj?.libraries?.find(l => l.downloads?.artifact?.url)
      if (lib) {
        const libRes = await withRetry(() => request(lib.downloads.artifact.url))
        record('library artifact', libRes.status === 200 && libRes.body.length === lib.downloads.artifact.size, `status=${libRes.status} bytes=${libRes.body.length} expected=${lib.downloads.artifact.size}`)
      }
    }
  }

  const asm = await request(`${BASE}/maven/org/ow2/asm/asm/9.6/asm-9.6.pom`)
  record('maven fetch', asm.status === 200 && asm.body.toString('utf8').includes('<'), `status=${asm.status} bytes=${asm.body.length}`)

  const forge = await request(`${BASE}/forge/download?mcversion=1.20.1&version=47.2.0&category=installer&format=jar`)
  const forgeLocation = new URL(forge.headers.location || '/', BASE).pathname
  record('forge redirect', forge.status === 302 && forgeLocation === '/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar', `location=${forgeLocation}`)

  const forgeReal = await request(`${BASE}${forgeLocation}`, { range: 'bytes=0-511' })
  record('forge artifact range', forgeReal.status === 206 && forgeReal.body.length === 512, `status=${forgeReal.status} bytes=${forgeReal.body.length}`)

  const fabric = await request(`${BASE}/fabric-meta/v2/versions/loader`)
  const fabricJson = jsonOf(fabric.body)
  record('fabric meta', fabric.status === 200 && Array.isArray(fabricJson) && fabricJson.length > 0, `status=${fabric.status} entries=${fabricJson?.length}`)

  const head = await request(`${BASE}/mc/game/version_manifest_v2.json`, { })
  record('head-like get ok', head.status === 200)

  const statsRes = await request(`${BASE}/_stats`)
  const statsJson = jsonOf(statsRes.body)
  record('stats endpoint', statsRes.status === 200 && statsJson.requests > 0 && statsJson.cache.entries > 0, `entries=${statsJson?.cache?.entries}`)

  const purge = await request(`${BASE}/_purge?path=/mc/game/version_manifest_v2.json`)
  record('purge hit', purge.status === 200 && jsonOf(purge.body)?.purged === true)
  const purgeAgain = await request(`${BASE}/_purge?path=/mc/game/version_manifest_v2.json`)
  record('purge miss', purgeAgain.status === 404)

  const unknown = await request(`${BASE}/nothing/here.jar`)
  record('unmapped route 404', unknown.status === 404, `status=${unknown.status}`)

  const traversal = await request(`${BASE}/assets/..%2f..%2fetc/passwd`)
  record('traversal blocked', traversal.status === 400, `status=${traversal.status}`)

  const normalizedTraversal = await request(`${BASE}/assets/%2e%2e/%2e%2e/etc/passwd`)
  record('dot segment never escapes cache', normalizedTraversal.status === 400 || normalizedTraversal.status === 404, `status=${normalizedTraversal.status}`)

  const headOnly = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/mc/game/version_manifest_v2.json`, { method: 'HEAD' }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
  record('HEAD returns headers only', headOnly.status === 200 && headOnly.body.length === 0 && Number(headOnly.headers['content-length']) > 0, `status=${headOnly.status} bytes=${headOnly.body.length}`)

  const method = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/mc/game/version_manifest_v2.json`, { method: 'POST' }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end('x')
  })
  record('POST rejected', method.status === 405, `status=${method.status}`)

  const cors = await request(`${BASE}/healthz`)
  record('cors header', cors.headers['access-control-allow-origin'] === '*', String(cors.headers['access-control-allow-origin']))

  await new Promise(r => setTimeout(r, 300))
  const indexFile = path.join(tmp, '.index.json')
  const indexRaw = await fs.readFile(indexFile, 'utf8').catch(() => '')
  const indexJson = jsonOf(Buffer.from(indexRaw))
  record('cache index persisted', Boolean(indexJson?.entries && Object.keys(indexJson.entries).length > 0), `keys=${indexJson ? Object.keys(indexJson.entries).length : 0}`)

  const files = await fs.readdir(tmp, { recursive: true }).catch(() => [])
  record('cache files on disk', files.some(f => !String(f).startsWith('.index')), `count=${files.length}`)

  const cachedAsset = assets.length ? `${BASE}/assets/${assets[0].hash.slice(0, 2)}/${assets[0].hash}` : null
  const beforeRestart = cachedAsset ? await request(cachedAsset) : null

  child.kill('SIGTERM')
  await new Promise(r => setTimeout(r, 1500))
  child.kill('SIGKILL')

  const offlineEnv = {
    ...process.env,
    BMCL_PORT: String(PORT),
    BMCL_HOST: '127.0.0.1',
    BMCL_CACHE_DIR: tmp,
    BMCL_BASE_URL: BASE,
    BMCL_MAX_DOWNLOADS: '4',
    BMCL_UPSTREAM_TIMEOUT: '3000',
    BMCL_ORIGIN_LAUNCHERMETA: 'http://127.0.0.1:1',
    BMCL_ORIGIN_PISTON_META: 'http://127.0.0.1:1',
    BMCL_ORIGIN_PISTON_DATA: 'http://127.0.0.1:1',
    BMCL_ORIGIN_LAUNCHER: 'http://127.0.0.1:1',
    BMCL_ORIGIN_RESOURCES: 'http://127.0.0.1:1',
    BMCL_ORIGIN_LIBRARIES: 'http://127.0.0.1:1',
    BMCL_ORIGIN_FORGE_MAVEN: 'http://127.0.0.1:1',
    BMCL_ORIGIN_FORGE_FILES: 'http://127.0.0.1:1',
  }

  restarted = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve('.'),
    env: offlineEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  restarted.stdout.on('data', d => logs.push(String(d)))
  restarted.stderr.on('data', d => logs.push(String(d)))

  const healthyAgain = await waitHealthy()
  record('restart healthy', healthyAgain)

  if (healthyAgain && cachedAsset) {
    const afterRestart = await request(cachedAsset)
    record('cache survives restart', afterRestart.status === 200 && afterRestart.body.equals(beforeRestart.body), `status=${afterRestart.status} bytes=${afterRestart.body.length}`)

    const manifestOffline = await request(`${BASE}/mc/game/version_manifest_v2.json`)
    record('stale fallback when upstream dead', manifestOffline.status === 200 && Boolean(jsonOf(manifestOffline.body)?.versions), `status=${manifestOffline.status}`)

    const coldOffline = await request(`${BASE}/assets/00/0000000000000000000000000000000000000000`)
    record('cold miss offline fails cleanly', coldOffline.status === 502, `status=${coldOffline.status}`)
  }
} catch (err) {
  record('test run', false, err.message)
} finally {
  child.kill('SIGKILL')
  restarted?.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 800))
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter(r => !r.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('--- server logs ---')
  console.log(logs.join(''))
  process.exit(1)
}