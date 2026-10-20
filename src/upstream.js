import { cfg } from './config.js'

const env = (name, fallback) => {
  const value = process.env[name]
  return value && value.trim() ? value.trim().replace(/\/+$/, '') : fallback
}

export const origins = {
  launchermeta: env('BMCL_ORIGIN_LAUNCHERMETA', 'https://launchermeta.mojang.com'),
  pistonMeta: env('BMCL_ORIGIN_PISTON_META', 'https://piston-meta.mojang.com'),
  pistonData: env('BMCL_ORIGIN_PISTON_DATA', 'https://piston-data.mojang.com'),
  launcher: env('BMCL_ORIGIN_LAUNCHER', 'https://launcher.mojang.com'),
  resources: env('BMCL_ORIGIN_RESOURCES', 'https://resources.download.minecraft.net'),
  libraries: env('BMCL_ORIGIN_LIBRARIES', 'https://libraries.minecraft.net'),
  forgeMaven: env('BMCL_ORIGIN_FORGE_MAVEN', 'https://maven.minecraftforge.net'),
  forgeFiles: env('BMCL_ORIGIN_FORGE_FILES', 'https://files.minecraftforge.net/maven'),
  neoforgeMaven: env('BMCL_ORIGIN_NEOFORGE_MAVEN', 'https://maven.neoforged.net/releases'),
  fabricMaven: env('BMCL_ORIGIN_FABRIC_MAVEN', 'https://maven.fabricmc.net'),
  fabricMeta: env('BMCL_ORIGIN_FABRIC_META', 'https://meta.fabricmc.net'),
  quiltMaven: env('BMCL_ORIGIN_QUILT_MAVEN', 'https://maven.quiltmc.org/repository/release'),
  quiltMeta: env('BMCL_ORIGIN_QUILT_META', 'https://meta.quiltmc.org'),
  liteloader: env('BMCL_ORIGIN_LITELOADER', 'https://dl.liteloader.com'),
  authlib: env('BMCL_ORIGIN_AUTHLIB', 'https://authlib-injector.yushi.moe'),
  forgeWeb: env('BMCL_ORIGIN_FORGE_WEB', 'https://files.minecraftforge.net'),
}

const uniq = list => [...new Set(list.filter(Boolean))]

const mavenByPath = rest => {
  if (rest.startsWith('/net/minecraftforge/')) return [origins.forgeMaven, origins.forgeFiles, origins.libraries]
  if (rest.startsWith('/net/neoforged/')) return [origins.neoforgeMaven, origins.libraries]
  if (rest.startsWith('/net/fabricmc/')) return [origins.fabricMaven, origins.libraries]
  if (rest.startsWith('/org/quiltmc/')) return [origins.quiltMaven, origins.libraries]
  if (rest.startsWith('/com/mumfrey/liteloader/')) return [origins.liteloader + '/versions', origins.libraries]
  return uniq([origins.libraries, origins.forgeMaven, origins.fabricMaven, origins.neoforgeMaven])
}

const stripPrefix = (pathname, prefix) => pathname.slice(prefix.length) || '/'

export function resolveTargets (pathname) {
  if (pathname === '/mc/game/version_manifest.json' || pathname === '/mc/game/version_manifest_v2.json') {
    return [origins.launchermeta + pathname, origins.pistonMeta + pathname]
  }

  if (pathname.startsWith('/v1/packages/') || pathname.startsWith('/v2/')) {
    return uniq([origins.pistonMeta + pathname, origins.launchermeta + pathname])
  }

  if (pathname.startsWith('/v1/products/')) {
    return uniq([origins.launchermeta + pathname, origins.pistonMeta + pathname])
  }

  if (pathname.startsWith('/v1/objects/')) {
    return uniq([origins.pistonData + pathname, origins.launcher + pathname, origins.launchermeta + pathname])
  }

  if (pathname.startsWith('/assets/')) {
    const rest = stripPrefix(pathname, '/assets')
    return uniq([origins.resources + rest])
  }

  if (pathname.startsWith('/maven/')) {
    const rest = stripPrefix(pathname, '/maven')
    return uniq(mavenByPath(rest).map(origin => origin + rest))
  }

  if (pathname.startsWith('/fabric-meta/')) {
    return uniq([origins.fabricMeta + stripPrefix(pathname, '/fabric-meta')])
  }

  if (pathname.startsWith('/quilt-meta/')) {
    return uniq([origins.quiltMeta + stripPrefix(pathname, '/quilt-meta')])
  }

  if (pathname.startsWith('/mirrors/authlib-injector/')) {
    return uniq([origins.authlib + stripPrefix(pathname, '/mirrors/authlib-injector')])
  }

  if (pathname === '/forge/promotions_slim.json') {
    return uniq([origins.forgeWeb + '/net/minecraftforge/forge/promotions_slim.json'])
  }

  if (pathname === '/forge/maven-metadata.json') {
    return uniq([origins.forgeWeb + '/net/minecraftforge/forge/maven-metadata.json'])
  }

  return []
}

export function resolveRedirect (url) {
  if (url.pathname === '/forge/download') {
    const mc = url.searchParams.get('mcversion')
    const version = url.searchParams.get('version')
    const category = url.searchParams.get('category')
    const format = url.searchParams.get('format')
    if (!mc || !version || !category || !format) return null
    const branch = url.searchParams.get('branch')
    const base = `${mc}-${version}${branch ? '-' + branch : ''}`
    return `/maven/net/minecraftforge/forge/${base}/forge-${base}-${category}.${format}`
  }

  return null
}

const withSchemeVariants = origin =>
  uniq([origin + '/', origin.replace(/^https:\/\//, 'http://') + '/', origin.replace(/^http:\/\//, 'https://') + '/'])

const rewriteTable = [
  [origins.launchermeta, ''],
  [origins.pistonMeta, ''],
  [origins.pistonData, ''],
  [origins.launcher, ''],
  [origins.resources, '/assets'],
  [origins.libraries, '/maven'],
  [origins.forgeMaven, '/maven'],
  [origins.forgeFiles, '/maven'],
  [origins.neoforgeMaven, '/maven'],
  [origins.fabricMaven, '/maven'],
  [origins.fabricMeta, '/fabric-meta'],
  [origins.quiltMaven, '/maven'],
  [origins.quiltMeta, '/quilt-meta'],
  [origins.authlib, '/mirrors/authlib-injector'],
]

export function rewriteText (text, base) {
  let out = text
  for (const [origin, prefix] of rewriteTable) {
    const target = `${base}${prefix}/`
    for (const candidate of withSchemeVariants(origin)) {
      if (candidate === target) continue
      if (!out.includes(candidate)) continue
      out = out.split(candidate).join(target)
    }
  }
  return out
}

export const routeTable = () => [
  { local: '/mc/game/version_manifest.json', upstream: origins.launchermeta },
  { local: '/v1/packages/*', upstream: origins.pistonMeta },
  { local: '/v1/products/*', upstream: origins.launchermeta },
  { local: '/v1/objects/*', upstream: `${origins.pistonData} | ${origins.launcher}` },
  { local: '/assets/*', upstream: origins.resources },
  { local: '/maven/*', upstream: 'mojang libraries + forge + neoforge + fabric + quilt' },
  { local: '/fabric-meta/*', upstream: origins.fabricMeta },
  { local: '/quilt-meta/*', upstream: origins.quiltMeta },
  { local: '/mirrors/authlib-injector/*', upstream: origins.authlib },
  { local: '/forge/download?mcversion=&version=&category=&format=', upstream: '302 -> /maven/net/minecraftforge/forge/...' },
  { local: '/forge/promotions_slim.json', upstream: origins.forgeWeb },
]

export const publicBase = req => {
  if (cfg.baseUrl) return cfg.baseUrl
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${cfg.port}`
  const rawProto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim()
  const proto = rawProto === 'https' ? 'https' : 'http'
  return `${proto}://${host}`
}