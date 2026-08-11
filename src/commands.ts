import { Context, h } from 'koishi'
import type { Config } from '.'
import { formatRemaining } from './cache'
import {
    ArgusPeekError,
    type ArgusPeekService,
    type ArgusPeekResult
} from './peek'

interface CommandOptions {
    display?: number
    blur?: number
    list?: boolean
    force?: boolean
}

export function applyCommands(
    ctx: Context,
    peekService: ArgusPeekService,
    config: Config
) {
    const cmd = ctx
        .command(
            `${config.commandName} [name:string]`,
            { authority: config.authority }
        )
        .option('display', '-d <id:number>')
        .option('blur', '-b <radius:number>')
        .option('list', '-l, --list')
        .option('force', '-f, --force', { authority: config.forceAuthority })
        .action(async ({ session, options }, name) => {
            if (!session) return
            const opts = options as CommandOptions

            if (opts.list) {
                return formatClientList(peekService, session)
            }

            try {
                const result = await peekService.peek(name, {
                    display: opts.display,
                    blur: clamp(
                        opts.blur ?? config.blur,
                        config.minBlur,
                        200
                    ),
                    force: opts.force
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
                .option('force', '-f, --force', { authority: config.forceAuthority })
                .action(async ({ session, options }) => {
                    if (!session) return
                    const opts = options as CommandOptions
                    const parts = [config.commandName, name]
                    if (opts.display !== undefined) {
                        parts.push('-d', String(opts.display))
                    }
                    if (opts.blur !== undefined) {
                        parts.push('-b', String(opts.blur))
                    }
                    if (opts.force) parts.push('-f')
                    return await session.execute(parts.join(' '))
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

        for (const client of peekService.listClients()) register(client.name)

        ctx.on('argus/client-connect', register)
        ctx.on('argus/client-disconnect', unregister)

        ctx.on('dispose', () => {
            for (const dispose of disposers.values()) dispose()
            disposers.clear()
        })
    }

    return cmd
}

function formatClientList(
    peekService: ArgusPeekService,
    session: { text: (key: string, args?: unknown[]) => string }
) {
    const clients = peekService.listClients()
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
    return session.text('.list-header', [clients.length]) + '\n' + lines.join('\n')
}

function formatPeekResult(
    session: { text: (key: string, args?: unknown[]) => string },
    result: ArgusPeekResult
) {
    if (result.kind === 'busy') {
        return formatBusy(session, result.client, result.busy, result.expiresAt)
    }

    const image = h.image(result.image, result.mime)
    if (result.expiresAt === undefined) return image
    return [image, formatCacheNote(session, result.expiresAt)]
}

function formatPeekError(
    session: { text: (key: string, args?: unknown[]) => string },
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
    session: {
        text: (key: string, args?: unknown[]) => string
    },
    clientName: string,
    busy: { app?: string; title?: string; reason?: string },
    expiresAt?: number
) {
    const app = busy.app || busy.title || 'unknown app'
    const note = expiresAt !== undefined
        ? ' ' +
          session.text('.cache-note', [
              formatRemaining(expiresAt - Date.now())
          ])
        : ''
    return session.text('.busy', [clientName, app]) + note
}

function formatCacheNote(
    session: { text: (key: string, args?: unknown[]) => string },
    expiresAt: number
) {
    return session.text('.cache-note', [
        formatRemaining(expiresAt - Date.now())
    ])
}

function isSafeAlias(name: string) {
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
}
