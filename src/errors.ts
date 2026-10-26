/** Stable public error codes; callers should not parse human-readable messages. */
export type HeicErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_OPTIONS'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_FEATURE'
  | 'INVALID_CONTAINER'
  | 'INVALID_BITSTREAM'
  | 'RESOURCE_LIMIT'
  | 'DECODE_FAILED'
  | 'WORKER_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'TIMEOUT';

export class HeicError extends Error {
  readonly name = 'HeicError';
  constructor(
    readonly code: HeicErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function asHeicError(error: unknown): HeicError {
  return error instanceof HeicError
    ? error
    : new HeicError('DECODE_FAILED', error instanceof Error ? error.message : String(error), {
        cause: error,
      });
}
