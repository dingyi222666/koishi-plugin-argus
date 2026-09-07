import type { Context, Disposable } from 'koishi'
import type {} from '@koishijs/plugin-server'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { Config } from '.'
import { ArgusPeekError } from './errors'
import type {
    ArgusClientInfo,
    ClientFrame,
    HelloFrame,
    PeekBusyFrame,
    PeekResultFrame,
    ServerFrame
} from './types'

export class ArgusServer {
    private clients = new Map<string, ArgusClient>()
    private readonly maxFrameText: number

    constructor(
        private ctx: Context,
        private config: ArgusServerConfig
    ) {
        // Include base64 expansion and JSON metadata in the transport limit.
        this.maxFrameText = Math.max(
            Math.ceil((config.maxImageKB * 1024) / BASE64_BYTES_PER_CHAR) +
                4096,
            4 * 1024 * 1024
        )
        const layer = ctx.server.ws(config.path, (socket) =>
            this.handleConnection(socket)
        )
        ctx.on('dispose', () => {
            for (const client of this.clients.values()) {
                this.cleanupClient(client, 'plugin_dispose')
            }
            layer.close()
        })
    }

    listClients() {
        return [...this.clients.values()]
    }

    getClient(name: string) {
        return this.clients.get(name)
    }

    peek(
        client: ArgusClient,
        display?: number | string
    ): Promise<PeekResponse> {
        const id = randomUUID()
        return new Promise((resolve, reject) => {
            const timer = this.ctx.setTimeout(() => {
                client.pending.delete(id)
                reject(
                    new ArgusPeekError(
                        'timeout',
                        'screenshot request timed out',
                        {
                            client: client.name
                        }
                    )
                )
            }, this.config.timeout)

            client.pending.set(id, { resolve, reject, timer })
            if (!this.send(client.socket, { type: 'peek', id, display })) {
                timer()
                client.pending.delete(id)
                reject(
                    new ArgusPeekError('client_offline', 'socket is not open', {
                        client: client.name
                    })
                )
            }
        })
    }

    private handleConnection(socket: WebSocket) {
        let client: ArgusClient | undefined
        const helloTimer = this.ctx.setTimeout(() => {
            this.send(socket, {
                type: 'hello_ack',
                ok: false,
                error: 'hello_timeout'
            })
            socket.close(4002, 'hello_timeout')
        }, 10_000)

        socket.on('message', (raw, isBinary) => {
            if (isBinary || socket.readyState !== socket.OPEN) return
            const text = raw.toString('utf8')
            if (text.length > this.maxFrameText) {
                socket.close(1009, 'message_too_large')
                return
            }

            let frame: ClientFrame
            try {
                frame = JSON.parse(text)
                if (!frame || typeof frame.type !== 'string') {
                    throw new Error('invalid frame')
                }
            } catch {
                socket.close(1003, 'invalid_json')
                return
            }

            if (!client) {
                if (frame.type !== 'hello') {
                    socket.close(4003, 'expect_hello')
                    return
                }
                helloTimer()
                client = this.handleHello(socket, frame)
                return
            }

            client.lastSeen = Date.now()
            this.handleFrame(client, frame)
        })

        socket.on('close', () => {
            helloTimer()
            if (client) this.cleanupClient(client, 'socket_close')
        })
        socket.on('error', (error) => {
            this.ctx.logger.warn('argus socket error: %s', error.message)
        })
    }

    private handleHello(
        socket: WebSocket,
        frame: HelloFrame
    ): ArgusClient | undefined {
        if (!frame.token || frame.token !== this.config.token) {
            this.send(socket, {
                type: 'hello_ack',
                ok: false,
                error: 'auth_failed'
            })
            socket.close(4001, 'auth_failed')
            return
        }

        const name = typeof frame.name === 'string' ? frame.name.trim() : ''
        if (!/^[a-zA-Z0-9_\-.]{1,32}$/.test(name)) {
            this.send(socket, {
                type: 'hello_ack',
                ok: false,
                error: 'invalid_name'
            })
            socket.close(4004, 'invalid_name')
            return
        }

        if (!this.send(socket, { type: 'hello_ack', ok: true })) return
        const previous = this.clients.get(name)
        if (previous) this.cleanupClient(previous, 'replaced')

        const client: ArgusClient = {
            name,
            socket,
            version: frame.version,
            displays: Array.isArray(frame.displays) ? frame.displays : [],
            defaultDisplay: frame.defaultDisplay,
            connectedAt: Date.now(),
            pending: new Map(),
            lastSeen: Date.now()
        }

        client.heartbeatTimer = this.ctx.setInterval(() => {
            const now = Date.now()
            if (now - client.lastSeen > HEARTBEAT_TIMEOUT) {
                this.ctx.logger.info('argus client %s heartbeat lost', name)
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

    private handleFrame(client: ArgusClient, frame: ClientFrame) {
        if (this.clients.get(client.name) !== client) return

        switch (frame.type) {
            case 'peek_result':
            case 'peek_busy':
            case 'peek_error': {
                const pending = client.pending.get(frame.id)
                if (!pending) return
                pending.timer()
                client.pending.delete(frame.id)

                if (frame.type === 'peek_error') {
                    pending.reject(new Error(frame.error || 'client_error'))
                } else if (frame.type === 'peek_busy') {
                    pending.resolve({ kind: 'busy', frame })
                } else if (typeof frame.image !== 'string') {
                    pending.reject(new Error('invalid_image'))
                } else if (
                    frame.image.length * BASE64_BYTES_PER_CHAR >
                    this.config.maxImageKB * 1024
                ) {
                    pending.reject(
                        new ArgusPeekError(
                            'image_too_large',
                            'screenshot exceeds size limit',
                            {
                                client: client.name
                            }
                        )
                    )
                } else {
                    pending.resolve({ kind: 'image', frame })
                }
                return
            }
            case 'ping':
                this.send(client.socket, { type: 'pong', t: frame.t })
                return
            case 'bye':
                client.socket.close(1000, 'bye')
        }
    }

    private cleanupClient(client: ArgusClient, reason: string) {
        client.heartbeatTimer?.()
        for (const pending of client.pending.values()) {
            pending.timer()
            pending.reject(
                new ArgusPeekError('client_offline', `disconnected:${reason}`, {
                    client: client.name
                })
            )
        }
        client.pending.clear()

        if (this.clients.get(client.name) === client) {
            this.clients.delete(client.name)
            this.ctx.logger.info(
                'argus client disconnected: %s (%s)',
                client.name,
                reason
            )
            this.ctx.emit('argus/client-disconnect', client.name)
        }

        if (client.socket.readyState === client.socket.OPEN) {
            client.socket.close(1000, reason)
        }
    }

    private send(socket: WebSocket, frame: ServerFrame): boolean {
        if (socket.readyState !== socket.OPEN) return false
        try {
            socket.send(JSON.stringify(frame))
            return true
        } catch (error) {
            this.ctx.logger.warn('argus send failed: %s', error)
            socket.close(1011, 'send_failed')
            return false
        }
    }
}

type ArgusServerConfig = Pick<
    Config,
    'path' | 'token' | 'timeout' | 'maxImageKB'
>

interface PendingPeek {
    resolve: (response: PeekResponse) => void
    reject: (error: Error) => void
    timer: Disposable
}

type PeekResponse =
    | { kind: 'image'; frame: PeekResultFrame }
    | { kind: 'busy'; frame: PeekBusyFrame }

export interface ArgusClient extends ArgusClientInfo {
    socket: WebSocket
    version?: string
    connectedAt: number
    pending: Map<string, PendingPeek>
    lastSeen: number
    heartbeatTimer?: Disposable
}

const HEARTBEAT_INTERVAL = 30_000
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3
const BASE64_BYTES_PER_CHAR = 0.75
