import process from 'node:process'

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const trimSlash = value => String(value ?? '').replace(/\/+$/, '')

export const cfg = {
  host: process.env.BMCL_HOST || '0.0.0.0',
  port: int(process.env.BMCL_PORT, 8080),
  baseUrl: trimSlash(process.env.BMCL_BASE_URL),
  cacheDir: process.env.BMCL_CACHE_DIR || './cache',
  cacheMaxBytes: int(process.env.BMCL_CACHE_MAX_BYTES, 64 * 1024 * 1024 * 1024),
  metaTtl: int(process.env.BMCL_META_TTL, 300) * 1000,
  fileTtl: int(process.env.BMCL_FILE_TTL, 0) * 1000,
  memEntries: int(process.env.BMCL_MEM_ENTRIES, 512),
  memMaxBytes: int(process.env.BMCL_MEM_MAX_BYTES, 256 * 1024 * 1024),
  jsonMaxBytes: int(process.env.BMCL_JSON_MAX_BYTES, 64 * 1024 * 1024),
  maxDownloads: int(process.env.BMCL_MAX_DOWNLOADS, 8),
  upstreamTimeout: int(process.env.BMCL_UPSTREAM_TIMEOUT, 60000),
  cors: process.env.BMCL_CORS ?? '*',
  userAgent: process.env.BMCL_USER_AGENT || 'bmcl-mirror/1.0',
}
