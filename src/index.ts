import { Context, Schema } from 'koishi'
import * as commands from './commands'
import { ArgusService } from './service'
import type { BlurMode } from './blur'
import zhCN from './locales/zh-CN.schema.yml'
import enUS from './locales/en-US.schema.yml'

export { ArgusService } from './service'
export { ArgusPeekError } from './errors'
export type {
    ArgusClientInfo,
    ArgusPeekOptions,
    ArgusPeekResult
} from './types'

export const name = 'argus'

export const inject = ['server']

export interface Config {
    path: string
    token: string
    commandName: string
    blur: number
    blurMode: BlurMode
    minBlur: number
    maxImageKB: number
    finalMaxKB: number
    timeout: number
    cacheDuration: number
    registerAlias: boolean
    enableChatLunaTool: boolean
    chatLunaToolBlur: number
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
    maxImageKB: Schema.natural().default(8 * 1024),
    finalMaxKB: Schema.natural().default(200),
    timeout: Schema.natural().default(15_000),
    cacheDuration: Schema.natural().default(5 * 60 * 1000),
    registerAlias: Schema.boolean().default(true),
    enableChatLunaTool: Schema.boolean().default(false),
    chatLunaToolBlur: Schema.natural().min(0).max(200).default(40),
    authority: Schema.natural().default(1),
    forceAuthority: Schema.natural().default(3)
}).i18n({
    'zh-CN': zhCN,
    'en-US': enUS
})

export function apply(ctx: Context, config: Config) {
    if (!config.token) {
        ctx.logger.warn(
            'token 未配置，所有客户端连接都会被拒绝。请在配置中设置 token。'
        )
    }

    ctx.plugin(ArgusService, config)
    ctx.plugin(commands, config)

    if (config.enableChatLunaTool) {
        ctx.inject(['argus', 'chatluna', 'chatluna_storage'], async (ctx) => {
            const chatluna = await import('koishi-plugin-argus/chatluna')
            ctx.plugin(chatluna, config)
        })
    }
}
