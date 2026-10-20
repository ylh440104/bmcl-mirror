import { cfg } from './config.js'

const siteBase = () => (process.env.BMCL_ORIGIN_OPTIFINE || 'https://optifine.net').replace(/\/+$/, '')
const pageTimeout = () => cfg.upstreamTimeout

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const stripTags = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const entities = { amp: '&', lt: '<', gt: '>', quot: String.fromCharCode(34), apos: String.fromCharCode(39), nbsp: ' ' }

const decodeEntities = text =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return entities[body.toLowerCase()] ?? whole
  })

const filenameToEntry = filename => {
  const preview = /^preview_OptiFine_([0-9][A-Za-z0-9._]*)_([A-Z]+_[A-Z])_([A-Z][A-Z0-9]*)_(pre\d+)\.jar$/i.exec(filename)
  if (preview) {
    return {
      mcversion: preview[1],
      type: `${preview[2].toUpperCase()}_${preview[3].toUpperCase()}`,
      patch: preview[4].toLowerCase(),
      filename,
      preview: true,
    }
  }

  const plain = /^OptiFine_([0-9][A-Za-z0-9._]*)_([A-Z]+_[A-Z])_([A-Z][A-Z0-9]*)\.jar$/i.exec(filename)
  if (plain) {
    return {
      mcversion: plain[1],
      type: plain[2].toUpperCase(),
      patch: plain[3].toUpperCase(),
      filename,
      preview: false,
    }
  }

  return null
}

const parseRows = html => {
  const rows = html.split(/<tr[\s>]/i).slice(1)
  const out = []
  for (const row of rows) {
    const jar = /adloadx\?f=([A-Za-z0-9_.]+\.jar)/.exec(row)
    if (!jar) continue
    const entry = filenameToEntry(jar[1])
    if (!entry) continue
    const text = decodeEntities(stripTags(row.split('</tr>')[0]))
    const forge = /Forge\s*(#\s*[0-9.]+|N\/A)/i.exec(text)
    const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text)
    out.push({
      ...entry,
      forge: forge ? forge[1].replace(/^#\s*/, 'Forge ') : undefined,
      date: date ? `${date[3]}-${date[2]}-${date[1]}` : undefined,
    })
  }
  return out
}

const downloadPage = async () => {
  const url = `${siteBase()}/downloads`
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(pageTimeout()),
  })
  if (!res.ok) throw new Error(`optifine downloads page ${res.status}`)
  return res.text()
}

export const fetchOptifineList = async () => {
  const html = await downloadPage()
  const entries = parseRows(html)
  if (!entries.length) throw new Error('optifine page layout changed, no rows parsed')
  return entries
}

export const flattenOptifine = entries =>
  entries.map(e => ({
    mcversion: e.mcversion,
    patch: e.patch,
    type: e.type,
    filename: e.filename,
    ...(e.forge ? { forge: e.forge } : {}),
  }))

export const resolveOptifineEntry = (entries, mcversion, type, patch) => {
  const exact = entries.find(e => e.mcversion === mcversion && e.type === type && e.patch === patch)
  if (exact) return exact

  const upper = type.toUpperCase()
  const relaxed = entries.find(e => e.mcversion === mcversion && e.patch === patch && e.type.toUpperCase() === upper)
  return relaxed ?? null
}

export const entryFileName = entry => entry.filename

export const fetchOptifineJar = async (entry, referer) => {
  const fileName = entry.filename
  const listPage = `${siteBase()}/adloadx?f=${encodeURIComponent(fileName)}&x=1774`
  const listRes = await fetch(listPage, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(pageTimeout()),
  })
  if (!listRes.ok) throw new Error(`optifine adloadx ${listRes.status}`)
  const setCookie = listRes.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ')
  const html = await listRes.text()
  const token = /downloadx\?f=[A-Za-z0-9_.]+&x=[A-Za-z0-9]+/.exec(html)
  if (!token) throw new Error('optifine token not found on adloadx page')

  const jarRes = await fetch(`${siteBase()}/${token[0]}`, {
    headers: {
      'user-agent': UA,
      referer: referer || listPage,
      ...(cookie ? { cookie } : {}),
    },
    signal: AbortSignal.timeout(Math.max(pageTimeout(), 120000)),
  })
  if (!jarRes.ok) throw new Error(`optifine downloadx ${jarRes.status}`)

  const contentType = jarRes.headers.get('content-type') || ''
  if (!/java-archive|octet-stream|zip/.test(contentType)) {
    await jarRes.body?.cancel().catch(() => {})
    throw new Error(`optifine returned ${contentType}, expected jar`)
  }

  return {
    stream: jarRes.body,
    size: jarRes.headers.get('content-length'),
    contentType: 'application/java-archive',
  }
}