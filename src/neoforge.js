const mavenBase = () => (process.env.BMCL_ORIGIN_NEOFORGE_MAVEN || 'https://maven.neoforged.net/releases').replace(/\/+$/, '')

const apiRoot = () => {
  const base = mavenBase()
  const idx = base.indexOf('/releases')
  return idx === -1 ? `${base}/api/maven` : `${base.slice(0, idx)}/api/maven`
}

export const listEndpoint = artifactId => `${apiRoot()}/versions/releases/net/neoforged/${artifactId}`

export const detailEndpoint = (artifactId, version) =>
  `${apiRoot()}/details/releases/net/neoforged/${artifactId}/${encodeURIComponent(version)}`

const artifactCache = { neoforge: null, forge: null }

const guessMc = version => {
  const clean = version.replace(/[-+].*$/, '')
  const parts = clean.split('.').map(Number)
  if (parts.length < 2 || parts.some(n => !Number.isInteger(n))) return null
  const [major, minor, micro] = parts

  if (major === 1) return micro === undefined ? `1.${minor}` : `1.${minor}.${micro}`

  if (major === 20) {
    if (minor === 2 && (micro === 0 || micro === undefined)) return '1.20.1'
    if (minor >= 2 && minor <= 6) return `1.20.${minor}`
    return null
  }

  if (major === 18 || major === 19) return `1.${major}.${minor}`

  if (major >= 21 && major <= 22) {
    return minor === 0 ? `1.${major}` : `1.${major}.${minor}`
  }

  if (major >= 23) {
    return micro ? `${major}.${minor}.${micro}` : `${major}.${minor}`
  }

  return null
}

const modernThreshold = 80

export const buildRecord = (artifactId, rawVersion) => {
  if (artifactId === 'forge') {
    const marker = rawVersion.indexOf('-forge-')
    if (marker !== -1) {
      const mcversion = rawVersion.slice(0, marker)
      const shortVersion = rawVersion.slice(marker + '-forge-'.length)
      return {
        artifactId,
        rawVersion,
        mavenVersion: `${mcversion}-${shortVersion}`,
        version: `${mcversion}-${shortVersion}`,
        mcversion,
        modern: true,
        renamed: true,
      }
    }
    const dash = rawVersion.indexOf('-')
    if (dash !== -1) {
      const mcversion = rawVersion.slice(0, dash)
      const shortVersion = rawVersion.slice(dash + 1)
      const parts = shortVersion.split('.')
      const patch = Number.parseInt(parts[2] ?? '0', 10)
      const renamed = parts.length >= 3 && Number.isInteger(patch) && patch >= modernThreshold
      return {
        artifactId,
        rawVersion: renamed ? `${mcversion}-forge-${shortVersion}` : rawVersion,
        mavenVersion: rawVersion,
        version: renamed ? `${mcversion}-${shortVersion}` : shortVersion,
        mcversion,
        modern: renamed,
        renamed,
      }
    }
    return { artifactId, rawVersion, mavenVersion: rawVersion, version: rawVersion, mcversion: null, modern: false, renamed: false }
  }

  const prefix = `${artifactId}-`
  const version = rawVersion.startsWith(prefix) ? rawVersion.slice(prefix.length) : rawVersion
  return {
    artifactId,
    rawVersion: `${artifactId}-${version}`,
    mavenVersion: rawVersion,
    version,
    mcversion: guessMc(version),
    modern: true,
    renamed: false,
  }
}

export const listRecords = (artifactId, payload) => {
  const versions = Array.isArray(payload?.versions) ? payload.versions : []
  return versions.map(raw => buildRecord(artifactId, raw)).filter(r => r.mcversion)
}

export const filterByMc = (records, mcversion) => records.filter(r => r.mcversion === mcversion)

export const findVersion = (records, version) => {
  const target = String(version)
  const direct = records.find(r => r.version === target)
  if (direct) return direct
  const raw = records.find(r => r.rawVersion === target)
  if (raw) return raw
  const maven = records.find(r => r.mavenVersion === target)
  return maven ?? null
}

const fileAliases = {
  install: 'installer.jar',
  installer: 'installer.jar',
  'installer.jar': 'installer.jar',
  universal: 'universal.jar',
  'universal.jar': 'universal.jar',
  'mdk.zip': 'mdk.zip',
  userdev: 'userdev.jar',
  'userdev.jar': 'userdev.jar',
  sources: 'sources.jar',
  'sources.jar': 'sources.jar',
  changelog: 'changelog.txt',
  'changelog.txt': 'changelog.txt',
}

export const fileAlias = file => fileAliases[String(file).toLowerCase()] ?? null

export const artifactPath = (record, fileName) => {
  const dirVersion = record.mavenVersion ?? record.rawVersion
  const baseVersion = record.renamed ? record.version : dirVersion
  const dir = `net/neoforged/${record.artifactId}/${dirVersion}`
  return `${dir}/${record.artifactId}-${baseVersion}-${fileName}`
}

export const resolveNeoforgeFile = (record, file) => {
  const alias = fileAlias(file)
  if (!alias) return null
  return { artifactId: record.artifactId, path: artifactPath(record, alias) }
}

export const apiShape = record => {
  const base = { rawVersion: record.rawVersion, mcversion: record.mcversion, version: record.version }
  if (!record.modern) return base
  return { ...base, installerPath: `/maven/${artifactPath(record, 'installer.jar')}` }
}

export const rememberArtifact = (map, records) => {
  for (const record of records) map.set(record.rawVersion, record.artifactId)
  return map
}

export const artifactRegistry = new Map()

export const lookupArtifact = rawVersion => artifactRegistry.get(rawVersion) ?? null