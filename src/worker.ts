import { decodeHeic } from './decoder.js'

const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = ({ data }) => {
  try {
    const image = decodeHeic(data.input, data.options)
    scope.postMessage({ image }, [image.data.buffer])
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
