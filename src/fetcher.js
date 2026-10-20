import { Readable } from 'node:stream'
import { cfg } from './config.js'

const textLike = value => /json|text\/|xml|javascript/.test(String(value || '').toLowerCase())

export const isTextual = textLike

export async function fetchFirst (targets, options = {}) {
  const failures = []
  const timeout = options.timeout ?? cfg.upstreamTimeout
  const attempts = Math.max(1, options.attempts ?? 2)

  for (let round = 0; round < attempts; round++) {
    for (const target of targets) {
      try {
        const response = await fetch(target, {
          method: options.method ?? 'GET',
          redirect: 'follow',
          headers: { 'user-agent': cfg.userAgent, ...(options.headers ?? {}) },
          signal: AbortSignal.timeout(timeout),
        })

        if (!response.ok) {
          failures.push(`${response.status} ${target}`)
          await response.body?.cancel().catch(() => {})
          continue
        }
        return { response, target, failures }
      } catch (err) {
        failures.push(`${err.name || 'Error'}: ${err.message} ${target}`)
      }
    }
    if (round + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300 * (round + 1)))
  }

  return { response: null, target: null, failures }
}

export async function readAll (response, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length
    if (total > limit) {
      throw new Error(`response exceeds limit of ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

export async function pipeTo (response, res, sink) {
  const source = Readable.fromWeb(response.body)
  let total = 0
  let clientGone = false
  const onClose = () => {
    clientGone = true
  }
  res.on('close', onClose)
  if (typeof res.setMaxListeners === 'function') res.setMaxListeners(0)

  try {
    for await (const chunk of source) {
      total += chunk.length
      if (sink) {
        if (!sink.write(chunk)) await sink.waitDrain()
      }
      if (!clientGone && !res.writableEnded) {
        if (!res.write(chunk)) {
          await Promise.race([
            new Promise(resolve => res.once('drain', resolve)),
            new Promise(resolve => res.once('close', resolve)),
          ])
        }
      }
    }
    return { total, clientGone }
  } catch (err) {
    source.destroy()
    throw err
  } finally {
    res.off('close', onClose)
  }
}