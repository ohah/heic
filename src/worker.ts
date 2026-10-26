import { decodeHDRSync } from './hdr.js';
import { asHeicError } from './errors.js';
import { decodeHeic } from './decoder.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = ({ data }) => {
  try {
    const image =
      data.operation === 'hdr'
        ? decodeHDRSync(data.input, data.options)
        : decodeHeic(data.input, data.options);
    scope.postMessage({ image }, [image.data.buffer]);
  } catch (error) {
    const failure = asHeicError(error);
    scope.postMessage({ error: { code: failure.code, message: failure.message } });
  }
};
