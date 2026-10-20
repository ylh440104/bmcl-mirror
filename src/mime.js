import path from 'node:path'

const table = {
  '.json': 'application/json; charset=utf-8',
  '.jar': 'application/java-archive',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mdk': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.log': 'text/plain; charset=utf-8',
}

export const contentTypeOf = (pathname, fallback) => {
  const guessed = table[path.extname(pathname).toLowerCase()]
  return guessed || fallback || 'application/octet-stream'
}
