import { Context, h } from 'koishi'
import type { ArgusServer } from './server'
import type { Config } from '.'
import { blurImage } from './blur'

interface CommandOptions {
    display?: number
    blur?: number
    list?: boolean
}

export function applyCommands(
    ctx: Context,
    server: ArgusServer,
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
        .action(async ({ session, options }, name) => {
            if (!session) return
            const opts = options as CommandOptions

            if (opts.list) {
                return formatClientList(server, session)
            }

            const clients = server.listClients()
            if (clients.length === 0) {
                return session.text('.no-clients')
            }

            let target = name?.trim()
            if (!target) {
                if (clients.length === 1) {
                    target = clients[0].name
                } else {
                    return session.text('.multiple-clients', [
                        clients.map((c) => c.name).join(', ')
                    ])
                }
            }

            const client = server.getClient(target)
            if (!client) {
                return session.text('.client-offline', [target])
            }

            const radius = clamp(
                opts.blur ?? config.blur,
                config.minBlur,
                200
            )

            try {
                const result = await server.peek(client.name, {
                    display: opts.display
                })
                const buffer = Buffer.from(result.image, 'base64')
                const output = await blurImage(buffer, {
                    radius,
                    mode: config.blurMode
                })
                return h.image(output, 'image/png')
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                ctx.logger.warn(
                    'argus peek failed for %s: %s',
                    client.name,
                    message
                )
                if (message === 'timeout') {
                    return session.text('.timeout', [client.name])
                }
                if (message === 'image_too_large') {
                    return session.text('.image-too-large')
                }
                if (message.startsWith('disconnected:')) {
                    return session.text('.client-offline', [client.name])
                }
                return session.text('.failed', [message])
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
                .command(
                    `${name}`,
                    { authority: config.authority }
                )
                .option('display', '-d <id:number>')
                .option('blur', '-b <radius:number>')
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

        for (const client of server.listClients()) register(client.name)

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
    server: ArgusServer,
    session: { text: (key: string, args?: unknown[]) => string }
) {
    const clients = server.listClients()
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

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
}

function isSafeAlias(name: string) {
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)
}
