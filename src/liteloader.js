const defaultUrl = () => (process.env.BMCL_ORIGIN_LITELOADER || 'https://dl.liteloader.com').replace(/\/+$/, '')

export const versionsUrl = () => `${defaultUrl()}/versions/versions.json`

const pickEntry = (bucket, mcversion) => {
  const holder = bucket?.['com.mumfrey:liteloader']
  if (!holder) return null
  const keys = Object.keys(holder).filter(k => k !== 'latest')
  if (!keys.length) return null
  const entry = holder[keys[0]]
  const record = {
    mcversion,
    hash: entry.md5 ?? keys[0],
    type: entry.stream === 'RELEASE' ? 'RELEASE' : 'SNAPSHOT',
    version: entry.version,
    build: entry.build,
    file: entry.file,
    tweakClass: entry.tweakClass,
    libraries: entry.libraries ?? [],
    timestamp: entry.timestamp,
  }
  const mcpJar = entry.mcpJar
  const srcJar = entry.srcJar
  if (mcpJar) record.mcpJar = mcpJar
  if (srcJar) record.srcJar = srcJar
  return record
}

export const parseLiteloader = payload => {
  const versions = payload?.versions ?? {}
  const out = []
  for (const [mcversion, node] of Object.entries(versions)) {
    for (const bucket of ['artefacts', 'releases', 'snapshots']) {
      const record = pickEntry(node?.[bucket], mcversion)
      if (record) {
        out.push({ ...record, repo: node.repo ?? null, stream: bucket })
        break
      }
    }
  }
  return out
}

export const toApiShape = record => ({
  _id: undefined,
  mcversion: record.mcversion,
  build: {
    file: record.file,
    libraries: record.libraries,
    ...(record.mcpJar ? { mcpJar: record.mcpJar } : {}),
    md5: record.hash,
    ...(record.srcJar ? { srcJar: record.srcJar } : {}),
    stream: record.type,
    timestamp: record.timestamp,
    tweakClass: record.tweakClass,
    version: record.version,
    ...(record.build ? { build: record.build } : {}),
  },
  hash: record.hash,
  type: record.type,
  version: record.version,
})

export const stripUndefined = value => {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = stripUndefined(v)
    }
    return out
  }
  return value
}

export const jarPathsFor = record => {
  if (record.type === 'SNAPSHOT' || /SNAPSHOT/i.test(record.version ?? '')) {
    return [`com/mumfrey/liteloader/${record.version}/liteloader-${record.version}.jar`]
  }
  const paths = [`com/mumfrey/liteloader/${record.mcversion}/liteloader-${record.mcversion}.jar`]
  if (record.version && record.version !== record.mcversion) {
    paths.push(`com/mumfrey/liteloader/${record.mcversion}/liteloader-${record.version}.jar`)
  }
  return paths
}

export const jarPathFor = record => jarPathsFor(record)[0]

export const findLiteloader = (records, version) =>
  records.find(r => r.version === version) ?? null