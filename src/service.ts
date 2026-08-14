import type { Context } from 'koishi'
import type { WebSocket } from 'ws'
import type { Config } from '.'
import { blurImage } from './blur'
import { PeekCache, type CachedPeek } from './cache'
import { compressToBudget } from './compress'
import { decryptBuffer } from './crypto'
import type {
    ArgusClient,
    ArgusClientInfo,
    ArgusPeekErrorCode,
    ArgusPeekErrorDetails,
    ArgusPeekOptions,
    ArgusPeekResult,
    ClientFrame,
    PeekRequestFrame,
    PeekResponse,
    PeekResultFrame,
    ServerFrame
} from './types'

const HEARTBEAT_INTERVAL = 30_000
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3

/** base64 文本长度 × 0.75 ≈ 实际二进制字节数（base64 为 4/3 编码）。 */
const BASE64_BYTES_PER_CHAR = 0.75

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

export class ArgusService {
    private clients = new Map<string, ArgusClient>()
    private cache: PeekCache
    private readonly maxFrameText: number

    constructor(
        private ctx: Context,
        private config: Config
    ) {
        this.cache = new PeekCache(config.cacheDuration)
        // 单帧文本上限跟随 maxImageKB（base64 换算），保证配置的截图预算能
        // 真正到达 peek_result 的体积检查；保底 4MB，防止极小的 maxImageKB
        // 连 hello 握手帧都拒绝。
        this.maxFrameText = Math.max(
            Math.ceil((config.maxImageKB * 1024) / BASE64_BYTES_PER_CHAR),
            4 * 1024 * 1024
        )
        this.mount()
    }

    listClients(): ArgusClientInfo[] {
        return [...this.clients.values()].map((client) => ({
            name: client.name,
            displays: client.displays.map((display) => ({ ...display })),
            defaultDisplay: client.defaultDisplay
        }))
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
            const response = await this.requestPeek(client, options.display)

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
                'peek pipeline: blur=%dms compress=%dms %dKB -> %dKB',
                blurMs,
                compressMs,
                Math.round(blurred.length / 1024),
                Math.round(output.length / 1024)
            )

            this.cache.set(cacheKey, {
                image: output
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

    private resolveClient(name?: string): ArgusClient {
        const clients = [...this.clients.values()]
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

        const client = this.clients.get(target)
        if (!client) {
            throw new ArgusPeekError(
                'client_offline',
                `client is not connected: ${target}`,
                { client: target }
            )
        }
        return client
    }

    private requestPeek(
        client: ArgusClient,
        display?: number | string
    ): Promise<PeekResponse> {
        const id = randomId()
        const frame: PeekRequestFrame = { type: 'peek', id, display }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                client.pending.delete(id)
                reject(new Error('timeout'))
            }, this.config.timeout)

            client.pending.set(id, { resolve, reject, timer })

            try {
                if (!this.send(client.socket, frame)) {
                    throw new Error('socket_not_open')
                }
            } catch (error) {
                clearTimeout(timer)
                client.pending.delete(id)
                reject(error)
            }
        })
    }

    private mount() {
        const layer = this.ctx.server.ws(this.config.path, (socket) =>
            this.handleConnection(socket)
        )

        this.ctx.on('dispose', () => {
            for (const client of this.clients.values()) {
                this.cleanupClient(client, 'plugin_dispose')
            }
            this.clients.clear()
            this.cache.clear()
            layer.close()
        })
    }

    private handleConnection(socket: WebSocket) {
        let client: ArgusClient | undefined
        const helloTimer = setTimeout(() => {
            if (client) return
            if (!this.send(socket, helloError('hello_timeout'))) return
            socket.close(4002, 'hello_timeout')
        }, 10_000)

        socket.on('message', (raw, isBinary) => {
            if (isBinary) return
            const text = typeof raw === 'string' ? raw : raw.toString('utf8')
            if (text.length > this.maxFrameText) {
                socket.close(1009, 'message_too_large')
                return
            }

            let frame: ClientFrame
            try {
                frame = JSON.parse(text) as ClientFrame
            } catch {
                socket.close(1003, 'invalid_json')
                return
            }

            if (!client) {
                if (frame.type !== 'hello') {
                    socket.close(4003, 'expect_hello')
                    return
                }
                clearTimeout(helloTimer)
                client = this.handleHello(socket, frame)
                return
            }

            client.lastSeen = Date.now()
            this.handleAuthedFrame(client, frame)
        })

        socket.on('close', () => {
            clearTimeout(helloTimer)
            if (client) this.cleanupClient(client, 'socket_close')
        })

        socket.on('error', (error) => {
            this.ctx.logger.warn('argus socket error: %s', error.message)
        })
    }

    private handleHello(
        socket: WebSocket,
        frame: ClientFrame & { type: 'hello' }
    ): ArgusClient | undefined {
        if (!frame.token || frame.token !== this.config.token) {
            if (!this.send(socket, helloError('auth_failed'))) return
            socket.close(4001, 'auth_failed')
            return
        }

        const name = (frame.name || '').trim()
        if (!name || !/^[a-zA-Z0-9_\-.]{1,32}$/.test(name)) {
            if (!this.send(socket, helloError('invalid_name'))) return
            socket.close(4004, 'invalid_name')
            return
        }

        const client: ArgusClient = {
            name,
            socket,
            version: frame.version,
            displays: frame.displays ?? [],
            defaultDisplay: frame.defaultDisplay,
            connectedAt: Date.now(),
            pending: new Map(),
            lastSeen: Date.now()
        }

        try {
            if (!this.send(socket, { type: 'hello_ack', ok: true })) return
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error)
            this.ctx.logger.warn(
                'argus hello acknowledgement failed for %s: %s',
                name,
                reason
            )
            socket.close(1011, 'hello_ack_failed')
            return
        }

        const previous = this.clients.get(name)
        if (previous) this.cleanupClient(previous, 'replaced')

        client.heartbeatTimer = setInterval(() => {
            const now = Date.now()
            if (now - client.lastSeen > HEARTBEAT_TIMEOUT) {
                this.ctx.logger.info(
                    'argus client %s heartbeat lost',
                    client.name
                )
                socket.close(4005, 'heartbeat_lost')
                return
            }
            this.send(socket, { type: 'ping', t: now })
        }, HEARTBEAT_INTERVAL)

        this.clients.set(name, client)
        this.ctx.logger.info(
            'argus client connected: %s (displays=%d)',
            name,
            client.displays.length
        )
        this.ctx.emit('argus/client-connect', name)
        return client
    }

    private handleAuthedFrame(client: ArgusClient, frame: ClientFrame) {
        if (this.clients.get(client.name) !== client) return

        switch (frame.type) {
            case 'peek_result': {
                const pending = client.pending.get(frame.id)
                if (!pending) return
                clearTimeout(pending.timer)
                client.pending.delete(frame.id)

                const size = (frame.image?.length ?? 0) * BASE64_BYTES_PER_CHAR
                if (size > this.config.maxImageKB * 1024) {
                    pending.reject(new Error('image_too_large'))
                    return
                }
                pending.resolve({ kind: 'image', frame })
                return
            }
            case 'peek_busy': {
                const pending = client.pending.get(frame.id)
                if (!pending) return
                clearTimeout(pending.timer)
                client.pending.delete(frame.id)
                pending.resolve({ kind: 'busy', frame })
                return
            }
            case 'peek_error': {
                const pending = client.pending.get(frame.id)
                if (!pending) return
                clearTimeout(pending.timer)
                client.pending.delete(frame.id)
                pending.reject(new Error(frame.error || 'client_error'))
                return
            }
            case 'ping':
                this.send(client.socket, { type: 'pong', t: frame.t })
                return
            case 'pong':
            case 'hello':
                return
            case 'bye':
                client.socket.close(1000, frame.reason || 'bye')
        }
    }

    private cleanupClient(client: ArgusClient, reason: string) {
        if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
        for (const pending of client.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error(`disconnected:${reason}`))
        }
        client.pending.clear()

        if (this.clients.get(client.name) === client) {
            this.clients.delete(client.name)
            this.cache.deleteClient(client.name)
            this.ctx.logger.info(
                'argus client disconnected: %s (%s)',
                client.name,
                reason
            )
            this.ctx.emit('argus/client-disconnect', client.name)
        }

        if (
            client.socket.readyState === client.socket.OPEN ||
            client.socket.readyState === client.socket.CONNECTING
        ) {
            client.socket.close(1000, reason)
        }
    }

    private fromCache(
        client: string,
        cached: CachedPeek
    ): ArgusPeekResult | undefined {
        if (cached.image) {
            return {
                kind: 'image',
                client,
                image: cached.image,
                mime: 'image/jpeg',
                expiresAt: cached.expiresAt
            }
        }
        if (cached.busy) {
            return {
                kind: 'busy',
                client,
                busy: cached.busy,
                expiresAt: cached.expiresAt
            }
        }
    }

    private decodeImage(frame: PeekResultFrame, client: string) {
        try {
            if (!frame.enc || frame.enc === 'none') {
                return Buffer.from(frame.image, 'base64')
            }
            if (frame.enc === 'aes-256-gcm') {
                return decryptBuffer(frame.image, this.config.token)
            }
            throw new Error(`unsupported_enc:${frame.enc}`)
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error)
            this.ctx.logger.warn(
                'argus decrypt failed for %s: %s',
                client,
                reason
            )
            throw new ArgusPeekError(
                'decrypt_failed',
                'failed to decrypt screenshot',
                { client, reason }
            )
        }
    }

    private send(socket: WebSocket, frame: ServerFrame) {
        if (socket.readyState !== socket.OPEN) return false
        socket.send(JSON.stringify(frame))
        return true
    }
}

function mapPeekError(error: unknown, client: string) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'timeout') {
        return new ArgusPeekError('timeout', message, { client })
    }
    if (message === 'image_too_large') {
        return new ArgusPeekError('image_too_large', message, { client })
    }
    if (message.startsWith('disconnected:')) {
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

function randomId() {
    return Math.random().toString(36).slice(2, 10)
}

function helloError(error: string): ServerFrame {
    return { type: 'hello_ack', ok: false, error }
}
