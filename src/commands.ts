import { Context, h } from 'koishi'
import type { ArgusServer } from './server'
import type { Config } from '.'
import { blurImage } from './blur'
import { compressToBudget } from './compress'
import { PeekCache, formatRemaining } from './cache'
import { decryptBuffer } from './crypto'

interface CommandOptions {
    display?: number
    blur?: number
    list?: boolean
    force?: boolean
}

export function applyCommands(
    ctx: Context,
    server: ArgusServer,
    config: Config,
    cache: PeekCache
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

            const cacheKey = PeekCache.key(client.name, opts.display)
            const cached = !opts.force ? cache.get(cacheKey) : undefined
            // -b 与 cache 的关系：缓存的图已经按当时的 radius 模糊过，
            // 临时调整 -b 时强制绕过缓存重新出图。
            const cacheUsable =
                cached &&
                (opts.blur === undefined ||
                    opts.blur === config.blur)

            if (cacheUsable && cached) {
                if (cached.busy) {
                    return formatBusy(session, client.name, cached.busy, cached)
                }
                if (cached.image) {
                    return [
                        h.image(cached.image, cached.mime ?? 'image/png'),
                        formatCacheNote(session, cached)
                    ]
                }
            }

            try {
                const response = await server.peek(client.name, {
                    display: opts.display
                })

                if (response.kind === 'busy') {
                    cache.set(cacheKey, { busy: response.frame })
                    return formatBusy(session, client.name, response.frame)
                }

                let buffer: Buffer
                try {
                    buffer = decodeImagePayload(response.frame, config.token)
                } catch (err) {
                    const message =
                        err instanceof Error ? err.message : String(err)
                    ctx.logger.warn(
                        'argus decrypt failed for %s: %s',
                        client.name,
                        message
                    )
                    return session.text('.failed', ['decrypt_failed'])
                }
                const blurStart = Date.now()
                const blurred = blurImage(buffer, {
                    radius,
                    mode: config.blurMode
                })
                const blurMs = Date.now() - blurStart

                // 第二轮压缩：群里发图，体积越小越好。
                // blur 总是输出 JPEG，所以 mime 总是 image/jpeg。
                const finalBudget = config.finalMaxKB * 1024
                const compressStart = Date.now()
                const output =
                    finalBudget > 0 && blurred.length > finalBudget
                        ? compressToBudget(blurred, { targetBytes: finalBudget })
                        : blurred
                const compressMs = Date.now() - compressStart
                const mime = 'image/jpeg'

                ctx.logger.debug(
                    'peek pipeline: blur=%dms compress=%dms %dKB→%dKB',
                    blurMs,
                    compressMs,
                    Math.round(blurred.length / 1024),
                    Math.round(output.length / 1024)
                )

                // 只有用配置默认 radius 时才入缓存，避免污染
                if (opts.blur === undefined || opts.blur === config.blur) {
                    cache.set(cacheKey, { image: output, mime })
                }

                return h.image(output, mime)
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

        for (const client of server.listClients()) register(client.name)

        ctx.on('argus/client-connect', register)
        ctx.on('argus/client-disconnect', (name) => {
            unregister(name)
            // 客户端下线，相关缓存全部清掉
            for (const display of [undefined, ...range(0, 16)]) {
                cache.delete(PeekCache.key(name, display))
            }
        })

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

function formatBusy(
    session: {
        text: (key: string, args?: unknown[]) => string
    },
    clientName: string,
    busy: { app?: string; title?: string; reason?: string },
    cached?: { expiresAt: number }
) {
    const app = busy.app || busy.title || 'unknown app'
    const note = cached
        ? ' ' +
          session.text('.cache-note', [
              formatRemaining(cached.expiresAt - Date.now())
          ])
        : ''
    return session.text('.busy', [clientName, app]) + note
}

function formatCacheNote(
    session: { text: (key: string, args?: unknown[]) => string },
    cached: { expiresAt: number }
) {
    return session.text('.cache-note', [
        formatRemaining(cached.expiresAt - Date.now())
    ])
}

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
}

function isSafeAlias(name: string) {
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)
}

function range(start: number, end: number) {
    const out: number[] = []
    for (let i = start; i < end; i++) out.push(i)
    return out
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
