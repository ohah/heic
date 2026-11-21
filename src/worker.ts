import { decodeHDRSync } from './hdr.js';
import { asHeicError } from './errors.js';
import { decodeHeic } from './decoder.js';
import { prepareAvcDecodeOptions } from './avc.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async ({ data }) => {
  try {
    const options = await prepareAvcDecodeOptions(data.input, data.options);
    const image =
      data.operation === 'hdr'
        ? decodeHDRSync(data.input, options)
        : decodeHeic(data.input, options);
    scope.postMessage({ image }, [image.data.buffer]);
  } catch (error) {
    const failure = asHeicError(error);
    scope.postMessage({ error: { code: failure.code, message: failure.message } });
  }
};
