import { Context, Schema } from 'koishi'
import {} from '@koishijs/plugin-server'
import { ArgusServer } from './server'
import { applyCommands } from './commands'
import { PeekCache } from './cache'
import type { BlurMode } from './blur'

export const name = 'argus'

export const inject = ['server']

export interface Config {
    path: string
    token: string
    commandName: string
    blur: number
    blurMode: BlurMode
    minBlur: number
    maxImageBytes: number
    timeout: number
    cacheDuration: number
    registerAlias: boolean
    authority: number
    forceAuthority: number
}

export const Config: Schema<Config> = Schema.object({
    path: Schema.string().default('/argus'),
    token: Schema.string().role('secret').default(''),
    commandName: Schema.string().default('peek'),
    blur: Schema.natural().min(0).max(200).default(40),
    blurMode: Schema.union(['gaussian', 'fast'] as const).default('fast'),
    minBlur: Schema.natural().min(0).max(200).default(10),
    maxImageBytes: Schema.natural().default(8 * 1024 * 1024),
    timeout: Schema.natural().default(15_000),
    cacheDuration: Schema.natural().default(5 * 60 * 1000),
    registerAlias: Schema.boolean().default(true),
    authority: Schema.natural().default(1),
    forceAuthority: Schema.natural().default(3)
}).i18n({
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    'zh-CN': require('./locales/zh-CN.schema.yml'),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    'en-US': require('./locales/en-US.schema.yml')
})

declare module 'koishi' {
    interface Events {
        'argus/client-connect'(name: string): void
        'argus/client-disconnect'(name: string): void
    }
}

export function apply(ctx: Context, config: Config) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctx.i18n.define('zh-CN', require('./locales/zh-CN.yml'))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctx.i18n.define('en-US', require('./locales/en-US.yml'))

    if (!config.token) {
        ctx.logger.warn(
            'token 未配置，所有客户端连接都会被拒绝。请在配置中设置 token。'
        )
    }

    const cache = new PeekCache(config.cacheDuration)

    const server = new ArgusServer(ctx, {
        path: config.path,
        token: config.token,
        timeout: config.timeout,
        maxImageBytes: config.maxImageBytes,
        onClientChange: (event) => {
            if (event.type === 'connect') {
                ctx.emit('argus/client-connect', event.name)
            } else {
                ctx.emit('argus/client-disconnect', event.name)
            }
        }
    })

    applyCommands(ctx, server, config, cache)

    ctx.on('dispose', () => {
        cache.clear()
    })
}
