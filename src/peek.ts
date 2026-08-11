import { Context } from 'koishi'
import type { Config } from '.'
import { blurImage } from './blur'
import { PeekCache, type CachedPeek } from './cache'
import { compressToBudget } from './compress'
import { decryptBuffer } from './crypto'
import type { ArgusClient, ArgusServer } from './server'
import type { PeekBusyFrame, PeekResultFrame } from './types'

export type ArgusPeekErrorCode =
    | 'no_clients'
    | 'multiple_clients'
    | 'client_offline'
    | 'timeout'
    | 'image_too_large'
    | 'decrypt_failed'
    | 'capture_failed'

export class ArgusPeekError extends Error {
    constructor(
        public readonly code: ArgusPeekErrorCode,
        message: string,
        public readonly details: {
            client?: string
            clients?: string[]
            reason?: string
        } = {}
    ) {
        super(message)
        this.name = 'ArgusPeekError'
    }
}

export interface ArgusPeekOptions {
    display?: number | string
    blur?: number
    force?: boolean
}

export type ArgusPeekResult =
    | {
          kind: 'image'
          client: string
          image: Buffer
          mime: 'image/jpeg'
          expiresAt?: number
      }
    | {
          kind: 'busy'
          client: string
          busy: PeekBusyFrame
          expiresAt?: number
      }

export class ArgusPeekService {
    constructor(
        private ctx: Context,
        private server: ArgusServer,
        private config: Config,
        private cache: PeekCache
    ) {
        ctx.on('argus/client-disconnect', (name) => {
            cache.deleteClient(name)
        })
    }

    listClients(): ArgusClient[] {
        return this.server.listClients()
    }

    resolveClient(name?: string): ArgusClient {
        const clients = this.server.listClients()
        if (clients.length === 0) {
            throw new ArgusPeekError('no_clients', 'no clients are connected')
        }

        const target = name?.trim()
        if (!target) {
            if (clients.length === 1) return clients[0]
            throw new ArgusPeekError(
                'multiple_clients',
                'multiple clients are connected',
                { clients: clients.map((client) => client.name) }
            )
        }

        const client = this.server.getClient(target)
        if (!client) {
            throw new ArgusPeekError(
                'client_offline',
                `client is not connected: ${target}`,
                { client: target }
            )
        }
        return client
    }

    async peek(
        name?: string,
        options: ArgusPeekOptions = {}
    ): Promise<ArgusPeekResult> {
        const client = this.resolveClient(name)
        const radius = clamp(options.blur ?? this.config.blur, 0, 200)
        const cacheKey = PeekCache.key(client.name, options.display, radius)
        const cached = options.force ? undefined : this.cache.get(cacheKey)
        if (cached) {
            const result = this.fromCache(client.name, cached)
            if (result) return result
        }

        try {
            const response = await this.server.peek(client.name, {
                display: options.display
            })

            if (response.kind === 'busy') {
                this.cache.set(cacheKey, {
                    busy: response.frame
                })
                return {
                    kind: 'busy',
                    client: client.name,
                    busy: response.frame
                }
            }

            const buffer = this.decodeImage(response.frame, client.name)
            const blurStart = Date.now()
            const blurred = blurImage(buffer, {
                radius,
                mode: this.config.blurMode
            })
            const blurMs = Date.now() - blurStart

            const finalBudget = this.config.finalMaxKB * 1024
            const compressStart = Date.now()
            const output =
                finalBudget > 0 && blurred.length > finalBudget
                    ? compressToBudget(blurred, { targetBytes: finalBudget })
                    : blurred
            const compressMs = Date.now() - compressStart

            this.ctx.logger.debug(
                'peek pipeline: blur=%dms compress=%dms %dKB→%dKB',
                blurMs,
                compressMs,
                Math.round(blurred.length / 1024),
                Math.round(output.length / 1024)
            )

            this.cache.set(cacheKey, {
                image: output,
                mime: 'image/jpeg'
            })

            return {
                kind: 'image',
                client: client.name,
                image: output,
                mime: 'image/jpeg'
            }
        } catch (error) {
            if (error instanceof ArgusPeekError) throw error
            const peekError = mapPeekError(error, client.name)
            this.ctx.logger.warn(
                'argus peek failed for %s: %s',
                client.name,
                peekError.details.reason ?? peekError.message
            )
            throw peekError
        }
    }

    private fromCache(
        client: string,
        cached: CachedPeek
    ): ArgusPeekResult | undefined {
        const base = {
            client,
            expiresAt: cached.expiresAt
        }
        if (cached.busy) {
            return { ...base, kind: 'busy', busy: cached.busy }
        }
        if (cached.image) {
            return {
                ...base,
                kind: 'image',
                image: cached.image,
                mime: 'image/jpeg'
            }
        }
    }

    private decodeImage(frame: PeekResultFrame, client: string) {
        try {
            return decodeImagePayload(frame, this.config.token)
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)
            this.ctx.logger.warn(
                'argus decrypt failed for %s: %s',
                client,
                message
            )
            throw new ArgusPeekError(
                'decrypt_failed',
                'failed to decrypt screenshot',
                { client, reason: message }
            )
        }
    }
}

function decodeImagePayload(
    frame: { image: string; enc?: 'aes-256-gcm' | 'none' },
    token: string
): Buffer {
    if (!frame.enc || frame.enc === 'none') {
        return Buffer.from(frame.image, 'base64')
    }
    if (frame.enc === 'aes-256-gcm') {
        return decryptBuffer(frame.image, token)
    }
    throw new Error(`unsupported_enc:${frame.enc}`)
}

function mapPeekError(error: unknown, client: string) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timeout') {
        return new ArgusPeekError('timeout', message, { client })
    }
    if (message === 'image_too_large') {
        return new ArgusPeekError('image_too_large', message, { client })
    }
    if (
        message === `client_offline:${client}` ||
        message.startsWith('disconnected:')
    ) {
        return new ArgusPeekError('client_offline', message, { client })
    }
    return new ArgusPeekError('capture_failed', message, {
        client,
        reason: message
    })
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
}
