import { Context, h, type Session } from 'koishi'
import type { Config } from '.'
import { ArgusPeekError } from './errors'
import type { ArgusClientInfo, ArgusPeekResult } from './types'

export const inject = ['argus']

export function apply(ctx: Context, config: Config) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctx.i18n.define('zh-CN', require('./locales/zh-CN.yml'))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ctx.i18n.define('en-US', require('./locales/en-US.yml'))

    ctx.command(`${config.commandName} [name:string]`, {
        authority: config.authority
    })
        .option('display', '-d <id:number>')
        .option('blur', '-b <radius:number>')
        .option('list', '-l, --list')
        .option('force', '-f, --force', { authority: config.forceAuthority })
        .action(async ({ session, options }, name) => {
            if (!session) return
            if (options.list) {
                return formatClientList(ctx.argus.listClients(), session)
            }

            try {
                const result = await ctx.argus.peek(name, {
                    display: options.display,
                    blur: Math.max(
                        config.minBlur,
                        Math.min(200, options.blur ?? config.blur)
                    ),
                    force: options.force
                })
                return formatPeekResult(session, result)
            } catch (error) {
                return formatPeekError(session, error, name)
            }
        })

    // 自动给每个连进来的客户端注册同名命令作为 alias
    if (config.registerAlias) {
        const disposers = new Map<string, () => void>()

        const register = (name: string) => {
            if (!isSafeAlias(name)) return
            if (disposers.has(name)) return
            // alias 命令本身只是一个转发器，避免与已有命令名冲突
            if (ctx.$commander.get(name)) return

            const sub = ctx
                .command(`${name}`, { authority: config.authority })
                .option('display', '-d <id:number>')
                .option('blur', '-b <radius:number>')
                .option('force', '-f, --force', {
                    authority: config.forceAuthority
                })
                .action(async ({ session, options }) => {
                    if (!session) return
                    return session.execute({
                        name: config.commandName,
                        args: [name],
                        options
                    })
                })

            disposers.set(name, () => sub.dispose())
        }

        const unregister = (name: string) => {
            const dispose = disposers.get(name)
            if (dispose) {
                dispose()
                disposers.delete(name)
            }
        }

        for (const client of ctx.argus.listClients()) register(client.name)

        ctx.on('argus/client-connect', register)
        ctx.on('argus/client-disconnect', unregister)

        ctx.on('dispose', () => {
            for (const dispose of disposers.values()) dispose()
            disposers.clear()
        })
    }
}

function formatClientList(clients: ArgusClientInfo[], session: Session) {
    if (clients.length === 0) return session.text('.no-clients')
    const lines = clients.map((c) => {
        const displays = c.displays.length
            ? c.displays
                  .map((d) => {
                      const label = d.name ?? `display-${d.id}`
                      const size =
                          d.width && d.height ? ` ${d.width}x${d.height}` : ''
                      const star = d.id === c.defaultDisplay ? '*' : ''
                      return `${star}${d.id}:${label}${size}`
                  })
                  .join(', ')
            : '-'
        return `· ${c.name} [${displays}]`
    })
    return (
        session.text('.list-header', [clients.length]) + '\n' + lines.join('\n')
    )
}

function formatPeekResult(session: Session, result: ArgusPeekResult) {
    if (result.kind === 'busy') {
        return formatBusy(session, result.client, result.busy, result.expiresAt)
    }

    const image = h.image(result.image, result.mime)
    if (result.expiresAt === undefined) return image
    return [image, formatCacheNote(session, result.expiresAt)]
}

function formatPeekError(
    session: Session,
    error: unknown,
    requestedName?: string
) {
    if (!(error instanceof ArgusPeekError)) {
        const message = error instanceof Error ? error.message : String(error)
        return session.text('.failed', [message])
    }

    switch (error.code) {
        case 'no_clients':
            return session.text('.no-clients')
        case 'multiple_clients':
            return session.text('.multiple-clients', [
                error.details.clients?.join(', ') ?? ''
            ])
        case 'client_offline':
            return session.text('.client-offline', [
                error.details.client ?? requestedName ?? ''
            ])
        case 'timeout':
            return session.text('.timeout', [
                error.details.client ?? requestedName ?? ''
            ])
        case 'image_too_large':
            return session.text('.image-too-large')
        case 'decrypt_failed':
            return session.text('.failed', ['decrypt_failed'])
        case 'capture_failed':
            return session.text('.failed', [
                error.details.reason ?? error.message
            ])
    }
}

function formatBusy(
    session: Session,
    clientName: string,
    busy: { app?: string; title?: string; reason?: string },
    expiresAt?: number
) {
    const app = busy.app || busy.title || 'unknown app'
    const message = session.text('.busy', [clientName, app])
    if (expiresAt === undefined) return message
    return message + ' ' + formatCacheNote(session, expiresAt)
}

function formatCacheNote(session: Session, expiresAt: number) {
    return session.text('.cache-note', [
        formatRemaining(expiresAt - Date.now())
    ])
}

function isSafeAlias(name: string) {
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)
}

function formatRemaining(ms: number) {
    const seconds = Math.max(0, Math.ceil(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`
}
