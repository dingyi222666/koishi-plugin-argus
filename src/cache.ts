import type { PeekBusyFrame } from './types'

/**
 * 缓存一次 peek 的响应（图片 buffer 或 busy 状态）。
 * 在 cacheDuration 内对同一 (client, display, blur) 的调用直接复用。
 */
export interface CachedPeek {
    cachedAt: number
    expiresAt: number
    image?: Buffer
    busy?: PeekBusyFrame
}

export class PeekCache {
    private store = new Map<string, CachedPeek>()
    private timers = new Map<string, NodeJS.Timeout>()

    constructor(private duration: number) {}

    /** key 包含 client、display 的类型与值、blur。 */
    static key(
        client: string,
        display: number | string | undefined,
        blur: number
    ) {
        return JSON.stringify([client, display ?? null, blur])
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
        const cached: CachedPeek = {
            ...entry,
            cachedAt,
            expiresAt: cachedAt + this.duration
        }
        this.store.set(key, cached)
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
        const prefix = `[${JSON.stringify(client)},`
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
