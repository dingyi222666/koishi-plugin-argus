import type { Context } from 'koishi'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type {
    ClientFrame,
    DisplayInfo,
    PeekRequestFrame,
    PeekResultFrame,
    ServerFrame
} from './types'

export interface ArgusServerConfig {
    path: string
    token: string
    timeout: number
    maxImageBytes: number
    onClientChange?: (event: ClientChangeEvent) => void
}

export interface ClientChangeEvent {
    type: 'connect' | 'disconnect'
    name: string
}

export interface PendingPeek {
    resolve: (frame: PeekResultFrame) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

export interface ArgusClient {
    name: string
    socket: WebSocket
    version?: string
    displays: DisplayInfo[]
    defaultDisplay?: number
    connectedAt: number
    pending: Map<string, PendingPeek>
    /** 心跳：上次收到任何客户端帧的时间戳。 */
    lastSeen: number
    heartbeatTimer?: NodeJS.Timeout
}

const HEARTBEAT_INTERVAL = 30_000
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 3

export class ArgusServer {
    /** name → client */
    private clients = new Map<string, ArgusClient>()

    constructor(
        private ctx: Context,
        private config: ArgusServerConfig
    ) {
        this.mount()
    }

    listClients(): ArgusClient[] {
        return [...this.clients.values()]
    }

    getClient(name: string): ArgusClient | undefined {
        return this.clients.get(name)
    }

    /**
     * 派发一次截图请求并等待结果。
     */
    async peek(
        name: string,
        options: { display?: number } = {}
    ): Promise<PeekResultFrame> {
        const client = this.clients.get(name)
        if (!client) throw new Error(`client_offline:${name}`)

        const id = randomId()
        const frame: PeekRequestFrame = {
            type: 'peek',
            id,
            display: options.display
        }

        return await new Promise<PeekResultFrame>((resolve, reject) => {
            const timer = setTimeout(() => {
                client.pending.delete(id)
                reject(new Error('timeout'))
            }, this.config.timeout)

            client.pending.set(id, { resolve, reject, timer })

            try {
                this.send(client.socket, frame)
            } catch (err) {
                clearTimeout(timer)
                client.pending.delete(id)
                reject(
                    err instanceof Error ? err : new Error(String(err))
                )
            }
        })
    }

    private mount() {
        const layer = this.ctx.server.ws(this.config.path, (socket, req) =>
            this.handleConnection(socket, req)
        )
        // ctx 卸载时 plugin-server 会自己 close，这里再保险一下。
        this.ctx.on('dispose', () => {
            for (const client of this.clients.values()) {
                this.cleanup(client, 'plugin_dispose')
            }
            this.clients.clear()
            layer.close()
        })
    }

    private handleConnection(socket: WebSocket, _req: IncomingMessage) {
        // 在 hello 完成前不进入 clients 表。
        let client: ArgusClient | undefined
        // 限制握手时间，避免空连接挂着。
        const helloTimer = setTimeout(() => {
            if (!client) {
                this.send(socket, {
                    type: 'hello_ack',
                    ok: false,
                    error: 'hello_timeout'
                })
                socket.close(4002, 'hello_timeout')
            }
        }, 10_000)

        socket.on('message', (raw, isBinary) => {
            if (isBinary) return // 我们只用 JSON 文本帧
            const text =
                typeof raw === 'string' ? raw : raw.toString('utf8')
            // 防御：拒绝过大的控制帧
            if (text.length > 4 * 1024 * 1024) {
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
            if (client) this.cleanup(client, 'socket_close')
        })

        socket.on('error', (err) => {
            this.ctx.logger.warn('argus socket error: %s', err.message)
        })
    }

    private handleHello(
        socket: WebSocket,
        frame: ClientFrame & { type: 'hello' }
    ): ArgusClient | undefined {
        if (!frame.token || frame.token !== this.config.token) {
            this.send(socket, {
                type: 'hello_ack',
                ok: false,
                error: 'auth_failed'
            })
            socket.close(4001, 'auth_failed')
            return undefined
        }
        const name = (frame.name || '').trim()
        if (!name || !/^[a-zA-Z0-9_\-.]{1,32}$/.test(name)) {
            this.send(socket, {
                type: 'hello_ack',
                ok: false,
                error: 'invalid_name'
            })
            socket.close(4004, 'invalid_name')
            return undefined
        }

        // 同名重连 → 踢掉老的
        const old = this.clients.get(name)
        if (old) this.cleanup(old, 'replaced')

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
        this.send(socket, { type: 'hello_ack', ok: true })

        this.ctx.logger.info(
            'argus client connected: %s (displays=%d)',
            name,
            client.displays.length
        )
        this.config.onClientChange?.({ type: 'connect', name })

        return client
    }

    private handleAuthedFrame(client: ArgusClient, frame: ClientFrame) {
        switch (frame.type) {
            case 'peek_result': {
                const pending = client.pending.get(frame.id)
                if (!pending) return
                clearTimeout(pending.timer)
                client.pending.delete(frame.id)

                const size = (frame.image?.length ?? 0) * 0.75
                if (size > this.config.maxImageBytes) {
                    pending.reject(new Error('image_too_large'))
                    return
                }
                pending.resolve(frame)
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
                // lastSeen 已更新
                return
            case 'bye':
                client.socket.close(1000, frame.reason || 'bye')
                return
            case 'hello':
                // 重复 hello，忽略
                return
        }
    }

    private cleanup(client: ArgusClient, reason: string) {
        if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
        for (const pending of client.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error(`disconnected:${reason}`))
        }
        client.pending.clear()
        if (this.clients.get(client.name) === client) {
            this.clients.delete(client.name)
            this.ctx.logger.info(
                'argus client disconnected: %s (%s)',
                client.name,
                reason
            )
            this.config.onClientChange?.({
                type: 'disconnect',
                name: client.name
            })
        }
        try {
            if (
                client.socket.readyState === client.socket.OPEN ||
                client.socket.readyState === client.socket.CONNECTING
            ) {
                client.socket.close(1000, reason)
            }
        } catch {
            // ignore
        }
    }

    private send(socket: WebSocket, frame: ServerFrame) {
        if (socket.readyState !== socket.OPEN) return
        socket.send(JSON.stringify(frame))
    }
}

function randomId() {
    return Math.random().toString(36).slice(2, 10)
}
