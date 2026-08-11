import type { PeekBusyFrame } from './types'

/**
 * 缓存一次 peek 的响应（图片 buffer 或 busy 状态）。
 * 在 cacheDuration 内对同一 (client, display, blur) 的调用直接复用。
 */
export interface CachedPeek {
    cachedAt: number
    expiresAt: number
    /** 已经过模糊处理的最终 buffer，busy 时为空。 */
    image?: Buffer
    /** 缓存图片的 mime（'image/png' | 'image/jpeg'）。 */
    mime?: string
    /** busy 状态：客户端在玩游戏 / 全屏。 */
    busy?: PeekBusyFrame
}

export class PeekCache {
    private store = new Map<string, CachedPeek>()
    private timers = new Map<string, NodeJS.Timeout>()

    constructor(private duration: number) {}

    setDuration(duration: number) {
        this.duration = duration
    }

    /** key 形如 `client::display::blur`。display 缺省用 'default'。 */
    static key(
        client: string,
        display: number | string | undefined,
        blur: number
    ) {
        return `${client}::${display ?? 'default'}::${blur}`
    }

    get(key: string): CachedPeek | undefined {
        const entry = this.store.get(key)
        if (!entry) return undefined
        if (Date.now() >= entry.expiresAt) {
            this.delete(key)
            return undefined
        }
        return entry
    }

    set(key: string, entry: Omit<CachedPeek, 'cachedAt' | 'expiresAt'>) {
        if (this.duration <= 0) return
        this.delete(key)
        const cachedAt = Date.now()
        const full: CachedPeek = {
            ...entry,
            cachedAt,
            expiresAt: cachedAt + this.duration
        }
        this.store.set(key, full)
        const timer = setTimeout(() => this.delete(key), this.duration)
        this.timers.set(key, timer)
    }

    delete(key: string) {
        this.store.delete(key)
        const timer = this.timers.get(key)
        if (timer) {
            clearTimeout(timer)
            this.timers.delete(key)
        }
    }

    deleteClient(client: string) {
        const prefix = `${client}::`
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) this.delete(key)
        }
    }

    clear() {
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
        this.store.clear()
    }
}

export function formatRemaining(ms: number) {
    const sec = Math.max(0, Math.ceil(ms / 1000))
    if (sec < 60) return `${sec}s`
    const minutes = Math.floor(sec / 60)
    const seconds = sec % 60
    if (seconds === 0) return `${minutes}m`
    return `${minutes}m${seconds}s`
}
