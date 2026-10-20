import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const args = process.argv.slice(2)

const readFlag = (name, fallback) => {
  const index = args.findIndex(a => a === `--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) return true
  return value
}

const base = String(readFlag('mirror', process.env.BMCL_MIRROR || 'http://127.0.0.1:8080')).replace(/\/+$/, '')
const version = readFlag('version', null)
const outDir = path.resolve(String(readFlag('out', './minecraft')))
const concurrency = Number.parseInt(String(readFlag('jobs', '16')), 10) || 16
const skipAssets = readFlag('skip-assets', false) === true
const listOnly = readFlag('list', false) === true

if (!version && !listOnly) {
  console.error('usage: node bin/download.js --version 1.20.1 [--out ./minecraft] [--jobs 16] [--skip-assets] [--list]')
  process.exit(1)
}

const getJson = async url => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

const runPool = async (items, size, worker) => {
  let cursor = 0
  const runners = Array.from({ length: Math.min(size, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

const ensureDir = dir => fs.mkdir(dir, { recursive: true })

const hashFile = async (file, algorithm) => {
  const { createHash } = await import('node:crypto')
  const { createReadStream } = await import('node:fs')
  const digest = createHash(algorithm)
  await pipeline(createReadStream(file), digest)
  return digest.digest('hex')
}

const downloadFile = async (url, target, hash, size, tries = 3) => {
  const existing = await fs.stat(target).catch(() => null)
  if (existing && size && existing.size === size) return 'skipped'
  await ensureDir(path.dirname(target))

  let lastError = null
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      const tmp = `${target}.part`
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      const stat = await fs.stat(tmp)
      if (size && stat.size !== size) {
        await fs.rm(tmp, { force: true })
        throw new Error(`size mismatch ${stat.size} != ${size} for ${url}`)
      }
      if (hash) {
        const digest = await hashFile(tmp, 'sha1')
        if (digest !== hash) {
          await fs.rm(tmp, { force: true })
          throw new Error(`sha1 mismatch for ${url}: ${digest} != ${hash}`)
        }
      }
      await fs.rename(tmp, target)
      return 'downloaded'
    } catch (err) {
      lastError = err
      await fs.rm(`${target}.part`, { force: true }).catch(() => {})
      if (attempt < tries) await new Promise(resolve => setTimeout(resolve, 400 * attempt))
    }
  }
  throw lastError
}

const main = async () => {
  const manifest = await getJson(`${base}/mc/game/version_manifest_v2.json`)
  if (listOnly) {
    for (const v of manifest.versions) console.log(`${v.id}\t${v.type}\t${v.releaseTime}`)
    return
  }

  const entry = manifest.versions.find(v => v.id === version)
  if (!entry) throw new Error(`version ${version} not found in manifest`)

  const meta = await getJson(entry.url)
  const versionDir = path.join(outDir, 'versions', meta.id)
  await ensureDir(versionDir)
  await fs.writeFile(path.join(versionDir, `${meta.id}.json`), JSON.stringify(meta, null, 2))

  const counts = { downloaded: 0, skipped: 0, failed: 0 }

  if (meta.downloads?.client?.url) {
    const target = path.join(versionDir, `${meta.id}.jar`)
    const result = await downloadFile(meta.downloads.client.url, target, meta.downloads.client.sha1, meta.downloads.client.size)
    counts[result] += 1
    console.log(`client jar ${result}`)
  }

  const libraries = (meta.libraries ?? [])
    .map(lib => lib.downloads?.artifact)
    .filter(Boolean)

  await runPool(libraries, concurrency, async artifact => {
    const relative = artifact.path ?? artifact.url.split('/maven/')[1] ?? path.basename(new URL(artifact.url).pathname)
    const target = path.join(outDir, 'libraries', relative)
    try {
      const result = await downloadFile(artifact.url, target, artifact.sha1, artifact.size)
      counts[result] += 1
    } catch (err) {
      counts.failed += 1
      console.error(`library failed ${relative}: ${err.message}`)
    }
  })
  console.log(`libraries: ${libraries.length} -> ${counts.downloaded} downloaded, ${counts.skipped} skipped, ${counts.failed} failed`)

  if (!skipAssets && meta.assetIndex?.url) {
    const index = await getJson(meta.assetIndex.url)
    const indexPath = path.join(outDir, 'assets', 'indexes', `${meta.assetIndex.id}.json`)
    await ensureDir(path.dirname(indexPath))
    await fs.writeFile(indexPath, JSON.stringify(index))
    console.log(`asset index ${meta.assetIndex.id} with ${Object.keys(index.objects ?? {}).length} objects`)

    const objects = Object.entries(index.objects ?? {}).map(([name, info]) => ({ name, ...info }))
    const assetCounts = { downloaded: 0, skipped: 0, failed: 0 }
    let done = 0
    await runPool(objects, concurrency, async object => {
      const target = path.join(outDir, 'assets', 'objects', object.hash.slice(0, 2), object.hash)
      const url = `${base}/assets/${object.hash.slice(0, 2)}/${object.hash}`
      try {
        const result = await downloadFile(url, target, object.hash, object.size)
        assetCounts[result] += 1
      } catch (err) {
        assetCounts.failed += 1
        console.error(`asset failed ${object.name}: ${err.message}`)
      }
      done += 1
      if (done % 500 === 0) console.log(`assets ${done}/${objects.length}`)
    })
    console.log(`assets: ${objects.length} -> ${assetCounts.downloaded} downloaded, ${assetCounts.skipped} skipped, ${assetCounts.failed} failed`)
    counts.failed += assetCounts.failed
  }

  console.log(`done: ${meta.id} at ${outDir}`)
  if (counts.failed) process.exit(1)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})