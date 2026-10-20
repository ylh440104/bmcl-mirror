export const encodeBuild = version => {
  const parts = String(version).split('.').map(Number)
  if (!parts.length || parts.some(n => !Number.isInteger(n) || n < 0)) return null
  if (parts.length === 3) return parts[0] * 1000000 + parts[1] * 10000 + parts[2]
  if (parts.length === 4) return parts[3]
  if (parts.length === 2) return parts[0] * 1000000 + parts[1] * 10000
  if (parts.length === 1) return parts[0] * 1000000
  return null
}

export const branchSuffix = (mcversion, version) => {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) return ''
  const legacy = version.split('.').slice(0, 3).join('.')
  return mcversion === legacy ? '' : `-${legacy}`
}

export const findBranchLabel = (mcversion, version, candidates) => {
  const suffix = branchSuffix(mcversion, version)
  if (suffix) return suffix.replace(/^-/, '')
  if (candidates && candidates.length) return mcversion
  return null
}

export const splitFull = (full, mcversionHint) => {
  const raw = String(full)
  if (mcversionHint) {
    const prefix = `${mcversionHint}-`
    if (raw.startsWith(prefix)) return { mcversion: mcversionHint, version: raw.slice(prefix.length) }
  }
  const dash = raw.indexOf('-')
  if (dash === -1) return null
  return { mcversion: raw.slice(0, dash), version: raw.slice(dash + 1) }
}

export const artifactOf = record => {
  const base = record.raw
  const dir = `net/minecraftforge/forge/${base}`
  return { base, dir, prefix: `forge-${base}` }
}

export const downloadBase = (mcversion, version, branch) => {
  const suffix = branchSuffix(mcversion, version)
  return `${mcversion}-${version}${branch ? '-' + branch : ''}${suffix}`
}

export const compareVersion = (a, b) => {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export const parsePromotions = payload => {
  const entries = []
  for (const [key, version] of Object.entries(payload?.promos ?? {})) {
    const idx = key.lastIndexOf('-')
    if (idx === -1) continue
    entries.push({ mcversion: key.slice(0, idx), tag: key.slice(idx + 1), version })
  }
  return entries
}

export const buildIndex = versions => {
  const byBuild = new Map()
  const byMc = new Map()

  const mcs = new Set()
  for (const full of versions) {
    const dash = full.indexOf('-')
    if (dash > 0) mcs.add(full.slice(0, dash))
  }
  const sortedMc = [...mcs].sort((a, b) => b.length - a.length)

  for (const full of versions) {
    const hint = sortedMc.find(mc => full.startsWith(`${mc}-`))
    const split = splitFull(full, hint)
    if (!split) continue

    let version = split.version
    const tail = `-${split.mcversion}`
    if (version.endsWith(tail)) version = version.slice(0, -tail.length)
    const familyTail = version.match(/-(\d+\.\d+\.\d+(?:\.\d+)?)$/)
    if (familyTail) version = version.slice(0, version.length - familyTail[0].length)
    version = version.replace(/-prerelease$/, '')

    const build = encodeBuild(version)
    if (build === null) continue

    const family = /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version.split('.').slice(0, 3).join('.') : null
    const record = {
      mcversion: split.mcversion,
      version,
      branch: family && family !== split.mcversion ? split.mcversion : null,
      build,
      full,
      raw: full,
    }

    if (!byBuild.has(build)) byBuild.set(build, record)
    const list = byMc.get(record.mcversion) ?? []
    if (!list.some(r => r.version === record.version)) list.push(record)
    byMc.set(record.mcversion, list)
  }

  for (const list of byMc.values()) list.sort((a, b) => compareVersion(a.version, b.version))
  return { byBuild, byMc }
}

export const fileCategories = legacy => {
  if (legacy) {
    return [
      { category: 'installer', format: 'jar' },
      { category: 'universal', format: 'zip' },
      { category: 'src', format: 'zip' },
      { category: 'changelog', format: 'txt' },
    ]
  }
  return [
    { category: 'installer', format: 'jar' },
    { category: 'mdk', format: 'zip' },
    { category: 'changelog', format: 'txt' },
  ]
}

export const isLegacyBuild = version => String(version).split('.').length === 4

export const xmlVersions = xml => {
  const out = []
  const re = /<version>([^<]+)<\/version>/g
  let match = re.exec(xml)
  while (match) {
    out.push(match[1].trim())
    match = re.exec(xml)
  }
  return out
}

export const xmlLatest = xml => {
  const latest = /<latest>([^<]+)<\/latest>/.exec(xml)
  const release = /<release>([^<]+)<\/release>/.exec(xml)
  return { latest: latest?.[1]?.trim() ?? null, release: release?.[1]?.trim() ?? null }
}