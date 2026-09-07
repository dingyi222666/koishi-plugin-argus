import { Context, Service } from 'koishi'
import type { Config } from '.'
import { PeekCache } from './cache'
import { ArgusPeekError } from './errors'
import { processImage } from './image'
import { ArgusServer } from './server'
import type {
    ArgusClientInfo,
    ArgusPeekOptions,
    ArgusPeekResult
} from './types'

export class ArgusService extends Service<Config> {
    static inject = ['server']

    private server: ArgusServer
    private cache: PeekCache

    constructor(ctx: Context, config: Config) {
        super(ctx, 'argus')
        this.config = config
        this.cache = new PeekCache(ctx, config.cacheDuration)
        this.server = new ArgusServer(ctx, config)

        ctx.on('argus/client-disconnect', (name) =>
            this.cache.deleteClient(name)
        )
        ctx.on('dispose', () => this.cache.clear())
    }

    listClients(): ArgusClientInfo[] {
        return this.server.listClients().map((client) => ({
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
        const radius = Math.max(
            0,
            Math.min(200, options.blur ?? this.config.blur)
        )
        const cached = options.force
            ? undefined
            : this.cache.get(client.name, options.display, radius)
        if (cached) return cached

        try {
            const response = await this.server.peek(client, options.display)
            // A reply can resolve just before the connection is replaced or closed.
            if (this.server.getClient(client.name) !== client) {
                throw new ArgusPeekError(
                    'client_offline',
                    'client disconnected',
                    {
                        client: client.name
                    }
                )
            }

            const result: ArgusPeekResult =
                response.kind === 'busy'
                    ? {
                          kind: 'busy',
                          client: client.name,
                          busy: response.frame
                      }
                    : {
                          kind: 'image',
                          client: client.name,
                          image: processImage(
                              this.ctx,
                              this.config,
                              response.frame,
                              radius
                          ),
                          mime: 'image/jpeg'
                      }

            this.cache.set(client.name, options.display, radius, result)
            return result
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error)
            this.ctx.logger.warn(
                'argus peek failed for %s: %s',
                client.name,
                reason
            )
            if (error instanceof ArgusPeekError) throw error
            throw new ArgusPeekError('capture_failed', reason, {
                client: client.name,
                reason
            })
        }
    }

    private resolveClient(name?: string) {
        const clients = this.server.listClients()
        if (!clients.length) {
            throw new ArgusPeekError('no_clients', 'no clients are connected')
        }

        const target = name?.trim()
        if (!target) {
            if (clients.length === 1) return clients[0]
            throw new ArgusPeekError(
                'multiple_clients',
                'multiple clients are connected',
                {
                    clients: clients.map((client) => client.name)
                }
            )
        }

        const client = this.server.getClient(target)
        if (!client) {
            throw new ArgusPeekError(
                'client_offline',
                `client is not connected: ${target}`,
                {
                    client: target
                }
            )
        }
        return client
    }
}

declare module 'koishi' {
    interface Context {
        argus: ArgusService
    }

    interface Events {
        'argus/client-connect'(name: string): void
        'argus/client-disconnect'(name: string): void
    }
}
