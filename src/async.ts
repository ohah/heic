import type { DecodeOptions, HeicImageData } from './decoder.js'
import { decodeHeic } from './decoder.js'

export interface AsyncDecodeOptions extends DecodeOptions {
  /** Defaults to worker. main runs synchronously before resolving its Promise. */
  execution?: 'worker' | 'main'
  signal?: AbortSignal
  /** Worker only: terminate decoding after this many milliseconds. Default 30s. */
  timeoutMs?: number
  /** For bundlers/CSP policies that require a custom Worker entry point. */
  workerFactory?: () => Worker
}

/** Decodes without detaching or modifying the caller's input buffer. */
export async function decode(input: Uint8Array, options: AsyncDecodeOptions = {}): Promise<HeicImageData> {
  const { execution = 'worker', signal, timeoutMs = 30000, workerFactory, ...decodeOptions } = options
  signal?.throwIfAborted()
  if (execution === 'main') return decodeHeic(input, decodeOptions)
  if (execution !== 'worker') throw new TypeError('Unknown execution mode')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive')
  if (!workerFactory && typeof Worker === 'undefined') throw new Error('Worker unavailable; use execution: main')
  return new Promise((resolve, reject) => {
    const worker = workerFactory ? workerFactory() : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    const finish = (error?: unknown, image?: HeicImageData) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(image!)
    }
    const abort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('HEIC decoding timed out')), timeoutMs)
    worker.onmessage = ({ data }) => {
      if (data.error) finish(new Error(data.error))
      else finish(undefined, data.image)
    }
    worker.onerror = (event) => { event.preventDefault(); finish(new Error(event.message || 'HEIC worker failed')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      const copy = new Uint8Array(input)
      worker.postMessage({ input: copy, options: decodeOptions }, [copy.buffer])
    } catch (error) { finish(error) }
  })
}
