import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] || '.'
const skip = new Set(['node_modules', '.git', 'cache'])

const walk = dir => {
  const out = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(item.name)) continue
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(full))
    else if (item.name.endsWith('.js')) out.push(full)
  }
  return out
}

const stripLiterals = source => {
  let out = ''
  let i = 0
  const n = source.length
  let mode = null
  let escaped = false

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    if (mode === 'line') {
      if (ch === '\n') {
        mode = null
        out += '\n'
      } else {
        out += ' '
      }
      i += 1
      continue
    }

    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = null
        out += '  '
        i += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`'
      if (escaped) {
        escaped = false
        out += ' '
        i += 1
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ' '
        i += 1
        continue
      }
      if (ch === closer) {
        mode = null
        out += ch
        i += 1
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      i += 1
      continue
    }

    if (ch === '/' && next === '/') {
      mode = 'line'
      out += '  '
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      mode = 'block'
      out += '  '
      i += 2
      continue
    }
    if (ch === "'") {
      mode = 'single'
      out += ch
      i += 1
      continue
    }
    if (ch === '"') {
      mode = 'double'
      out += ch
      i += 1
      continue
    }
    if (ch === '`') {
      mode = 'template'
      out += ch
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return { stripped: out, leftover: mode }
}

const files = walk(root)
let failures = 0

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split('\n')

  const commentLines = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (/^\/\//.test(trimmed) || /^\/\*/.test(trimmed) || /^\*/.test(trimmed)) {
      commentLines.push(index + 1)
    }
  })

  const { stripped } = stripLiterals(source)
  const strippedLines = stripped.split('\n')
  const inlineComments = []
  strippedLines.forEach((line, index) => {
    if (/\/\//.test(line) || /\/\*/.test(line)) inlineComments.push(index + 1)
  })

  if (commentLines.length || inlineComments.length) {
    failures += 1
    console.log(`COMMENT ${file}`)
    if (commentLines.length) console.log(`  full-line: ${commentLines.join(',')}`)
    if (inlineComments.length) console.log(`  inline: ${inlineComments.join(',')}`)
  }
}

console.log(`${files.length} files scanned, ${failures} with comments`)
process.exitCode = failures ? 1 : 0