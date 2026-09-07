import type { Context, Disposable } from 'koishi'
import type { ArgusPeekResult } from './types'

export class PeekCache {
    private clients = new Map<string, Map<string, CacheEntry>>()

    constructor(
        private ctx: Context,
        private duration: number
    ) {}

    get(client: string, display: number | string | undefined, blur: number) {
        const entries = this.clients.get(client)
        const key = JSON.stringify([display ?? null, blur])
        const entry = entries?.get(key)
        if (!entry) return
        if (Date.now() < entry.result.expiresAt) return entry.result
        this.delete(client, key)
    }

    set(
        client: string,
        display: number | string | undefined,
        blur: number,
        result: ArgusPeekResult
    ) {
        if (this.duration <= 0) return
        const key = JSON.stringify([display ?? null, blur])
        this.delete(client, key)
        let entries = this.clients.get(client)
        if (!entries) this.clients.set(client, (entries = new Map()))
        entries.set(key, {
            result: { ...result, expiresAt: Date.now() + this.duration },
            dispose: this.ctx.setTimeout(
                () => this.delete(client, key),
                this.duration
            )
        })
    }

    deleteClient(client: string) {
        const entries = this.clients.get(client)
        if (!entries) return
        for (const entry of entries.values()) entry.dispose()
        this.clients.delete(client)
    }

    clear() {
        for (const client of this.clients.keys()) this.deleteClient(client)
    }

    private delete(client: string, key: string) {
        const entries = this.clients.get(client)
        entries?.get(key)?.dispose()
        entries?.delete(key)
        if (!entries?.size) this.clients.delete(client)
    }
}

interface CacheEntry {
    result: ArgusPeekResult & { expiresAt: number }
    dispose: Disposable
}
