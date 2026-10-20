const runtimeIndex = () =>
  (process.env.BMCL_ORIGIN_JAVA_ALL || 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json').replace(/\/+$/, '')

const platformNames = {
  'windows-x64': 'Windows x64',
  'windows-x86': 'Windows x86',
  'windows-arm64': 'Windows ARM64',
  'mac-os': 'macOS',
  'mac-os-arm64': 'macOS ARM64',
  'linux': 'Linux',
  'linux-i386': 'Linux x86',
}

const extensionFor = platform => {
  if (platform.startsWith('windows')) return 'exe'
  if (platform.startsWith('mac-os')) return 'dmg'
  return 'tar.gz'
}

const skip = new Set(['gamecore', 'legacy-jre'])

export const buildJavaList = payload => {
  const out = []
  for (const [platform, runtimes] of Object.entries(payload ?? {})) {
    if (skip.has(platform)) continue
    const label = platformNames[platform]
    if (!label || !runtimes || typeof runtimes !== 'object') continue
    for (const [runtimeName, entries] of Object.entries(runtimes)) {
      if (!Array.isArray(entries) || !entries.length) continue
      const entry = entries[0]
      const version = entry?.version?.name
      if (!version) continue
      const alias = runtimeName.replace(/^java-runtime-?/, '') || 'jre'
      out.push({
        title: `${label} ${version}${alias !== 'jre' ? ` (${alias})` : ''}`,
        file: `jre_${platform.replace(/-/g, '_')}_${alias}.${extensionFor(platform)}`,
        platform,
        runtime: runtimeName,
        version,
        released: entry?.version?.released ?? null,
        manifest: entry?.manifest?.url ?? null,
      })
    }
  }
  return out.sort((a, b) => a.platform.localeCompare(b.platform) || String(b.version).localeCompare(String(a.version)))
}