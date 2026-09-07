import type { ArgusPeekErrorCode, ArgusPeekErrorDetails } from './types'

export class ArgusPeekError extends Error {
    constructor(
        public readonly code: ArgusPeekErrorCode,
        message: string,
        public readonly details: ArgusPeekErrorDetails = {}
    ) {
        super(message)
        this.name = 'ArgusPeekError'
    }
}

// The optional tool entry can be loaded as ESM alongside the CommonJS service.
export function isArgusPeekError(error: unknown): error is ArgusPeekError {
    return (
        error instanceof Error &&
        error.name === 'ArgusPeekError' &&
        'code' in error &&
        'details' in error
    )
}
