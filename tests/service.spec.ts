import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import type { Context } from 'koishi'
import type { WebSocket } from 'ws'
import type { Config } from '../src'
import { ArgusPeekError, ArgusService } from '../src/service'
import type { ClientFrame, ServerFrame } from '../src/types'

class FakeSocket extends EventEmitter {
    readonly OPEN = 1
    readonly CONNECTING = 0
    readyState = this.OPEN
    closeCode?: number
    frames: ServerFrame[] = []

    send(data: string) {
        this.frames.push(JSON.parse(data) as ServerFrame)
    }

    close(code?: number) {
        if (this.readyState !== this.OPEN) return
        this.closeCode = code
        this.readyState = 3
        this.emit('close')
    }

    receive(frame: ClientFrame) {
        this.emit('message', Buffer.from(JSON.stringify(frame)), false)
    }
}

class ThrowingSocket extends FakeSocket {
    throwOnSend = false

    send(data: string) {
        if (this.throwOnSend) throw new Error('send_failed')
        return super.send(data)
    }
}

class DeferredCloseSocket extends FakeSocket {
    close() {
        this.readyState = 2
    }

    finishClose() {
        this.readyState = 3
        this.emit('close')
    }
}

function createContext() {
    const events = new EventEmitter()
    let connect: (socket: WebSocket) => void
    const context = {
        server: {
            ws(_path: string, callback: (socket: WebSocket) => void) {
                connect = callback
                return { close() {} }
            }
        },
        on(name: string, listener: (...args: unknown[]) => void) {
            events.on(name, listener)
        },
        emit(name: string, ...args: unknown[]) {
            events.emit(name, ...args)
        },
        logger: {
            info() {},
            warn() {},
            debug() {}
        }
    } as unknown as Context

    return {
        context,
        connect(socket: FakeSocket) {
            connect(socket as unknown as WebSocket)
        },
        dispose() {
            events.emit('dispose')
        }
    }
}

const config: Config = {
    path: '/argus',
    token: 'secret',
    commandName: 'peek',
    blur: 40,
    blurMode: 'fast',
    minBlur: 10,
    maxImageKB: 8192,
    finalMaxKB: 200,
    timeout: 1000,
    cacheDuration: 60_000,
    registerAlias: false,
    enableChatLunaTool: false,
    chatLunaToolBlur: 40,
    authority: 1,
    forceAuthority: 3
}

describe('ArgusService', () => {
    it('reports when no client is online', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)

        await assert.rejects(service.peek(), (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'no_clients')
            return true
        })

        runtime.dispose()
    })

    it('requires an exact client name when more than one client is online', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const alice = new FakeSocket()
        const bob = new FakeSocket()
        runtime.connect(alice)
        runtime.connect(bob)
        alice.receive({ type: 'hello', name: 'alice', token: 'secret' })
        bob.receive({ type: 'hello', name: 'bob', token: 'secret' })

        await assert.rejects(service.peek(), (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'multiple_clients')
            assert.deepEqual(error.details.clients, ['alice', 'bob'])
            return true
        })
        await assert.rejects(service.peek('charlie'), (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'client_offline')
            assert.equal(error.details.client, 'charlie')
            return true
        })
        assert.equal(countPeekRequests(alice), 0)
        assert.equal(countPeekRequests(bob), 0)

        runtime.dispose()
    })

    it('reuses cached results, refreshes on force, and clears on disconnect', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const socket = new FakeSocket()
        runtime.connect(socket)
        socket.receive({
            type: 'hello',
            name: 'alice',
            token: 'secret',
            displays: [{ id: 'secondary', name: 'Second display' }],
            defaultDisplay: 'secondary'
        })

        assert.deepEqual(
            service.listClients().map((client) => ({
                name: client.name,
                displays: client.displays,
                defaultDisplay: client.defaultDisplay
            })),
            [
                {
                    name: 'alice',
                    displays: [{ id: 'secondary', name: 'Second display' }],
                    defaultDisplay: 'secondary'
                }
            ]
        )

        const first = service.peek('alice', {
            display: 'secondary',
            blur: 40
        })
        const firstRequest = lastPeekRequest(socket)
        socket.receive({
            type: 'peek_busy',
            id: firstRequest.id,
            app: 'game'
        })
        assert.equal((await first).kind, 'busy')

        const requestCount = countPeekRequests(socket)
        const cached = await service.peek('alice', {
            display: 'secondary',
            blur: 40
        })
        assert.equal(cached.kind, 'busy')
        assert.equal(countPeekRequests(socket), requestCount)
        assert.equal(typeof cached.expiresAt, 'number')

        const refreshed = service.peek('alice', {
            display: 'secondary',
            blur: 40,
            force: true
        })
        const refreshRequest = lastPeekRequest(socket)
        socket.receive({
            type: 'peek_busy',
            id: refreshRequest.id,
            app: 'game'
        })
        await refreshed
        assert.equal(countPeekRequests(socket), requestCount + 1)

        const refreshedCache = await service.peek('alice', {
            display: 'secondary',
            blur: 40
        })
        assert.equal(refreshedCache.kind, 'busy')
        assert.equal(countPeekRequests(socket), requestCount + 1)

        socket.close()
        const reconnected = new FakeSocket()
        runtime.connect(reconnected)
        reconnected.receive({
            type: 'hello',
            name: 'alice',
            token: 'secret'
        })

        const afterReconnect = service.peek('alice', {
            display: 'secondary',
            blur: 40
        })
        const reconnectRequest = lastPeekRequest(reconnected)
        reconnected.receive({
            type: 'peek_busy',
            id: reconnectRequest.id,
            app: 'game'
        })
        await afterReconnect
        assert.equal(countPeekRequests(reconnected), 1)

        runtime.dispose()
    })

    it('invalidates cache when a connected client is replaced', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const previous = new FakeSocket()
        runtime.connect(previous)
        previous.receive({
            type: 'hello',
            name: 'alice',
            token: 'secret',
            displays: [{ id: 'main', name: 'Primary' }],
            defaultDisplay: 'main'
        })

        const first = service.peek('alice', { display: 'main', blur: 40 })
        previous.receive({
            type: 'peek_busy',
            id: lastPeekRequest(previous).id,
            app: 'game'
        })
        await first

        const current = new FakeSocket()
        runtime.connect(current)
        current.receive({
            type: 'hello',
            name: 'alice',
            token: 'secret',
            displays: [{ id: 'main', name: 'Primary' }],
            defaultDisplay: 'main'
        })

        assert.equal(service.listClients().length, 1)

        const afterReplacement = service.peek('alice', {
            display: 'main',
            blur: 40
        })
        current.receive({
            type: 'peek_busy',
            id: lastPeekRequest(current).id,
            app: 'browser'
        })
        const result = await afterReplacement

        assert.equal(result.kind, 'busy')
        if (result.kind === 'busy') assert.equal(result.busy.app, 'browser')
        assert.equal(countPeekRequests(current), 1)

        previous.emit('close')
        assert.equal(service.listClients()[0]?.name, 'alice')

        runtime.dispose()
    })

    it('does not let a replaced socket disconnect the current client', () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const previous = new DeferredCloseSocket()
        runtime.connect(previous)
        previous.receive({ type: 'hello', name: 'alice', token: 'secret' })

        const current = new FakeSocket()
        runtime.connect(current)
        current.receive({ type: 'hello', name: 'alice', token: 'secret' })
        previous.finishClose()

        assert.deepEqual(
            service.listClients().map((client) => client.name),
            ['alice']
        )

        runtime.dispose()
    })

    it('keeps the current client when a replacement cannot be acknowledged', () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const current = new FakeSocket()
        runtime.connect(current)
        current.receive({ type: 'hello', name: 'alice', token: 'secret' })

        const replacement = new ThrowingSocket()
        replacement.throwOnSend = true
        runtime.connect(replacement)
        replacement.receive({
            type: 'hello',
            name: 'alice',
            token: 'secret'
        })

        assert.deepEqual(
            service.listClients().map((client) => client.name),
            ['alice']
        )
        assert.equal(current.readyState, current.OPEN)
        assert.equal(replacement.readyState, 3)

        runtime.dispose()
    })

    it('ignores frames from a replaced socket', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const previous = new DeferredCloseSocket()
        runtime.connect(previous)
        previous.receive({ type: 'hello', name: 'alice', token: 'secret' })

        const previousResult = service.peek('alice')
        const previousRequest = lastPeekRequest(previous)

        const current = new FakeSocket()
        runtime.connect(current)
        current.receive({ type: 'hello', name: 'alice', token: 'secret' })
        previous.receive({
            type: 'peek_busy',
            id: previousRequest.id,
            app: 'stale client'
        })

        await assert.rejects(previousResult, (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'client_offline')
            return true
        })
        assert.equal(service.listClients()[0]?.name, 'alice')

        runtime.dispose()
    })

    it('clears a pending request when sending fails', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const socket = new ThrowingSocket()
        runtime.connect(socket)
        socket.receive({ type: 'hello', name: 'alice', token: 'secret' })
        socket.throwOnSend = true

        await assert.rejects(service.peek('alice'), (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'capture_failed')
            assert.equal(error.details.reason, 'send_failed')
            return true
        })

        runtime.dispose()
    })

    it('fails immediately when the client socket is not open', async () => {
        const runtime = createContext()
        const service = new ArgusService(runtime.context, config)
        const socket = new FakeSocket()
        runtime.connect(socket)
        socket.receive({ type: 'hello', name: 'alice', token: 'secret' })
        socket.readyState = 2

        await assert.rejects(service.peek('alice'), (error: unknown) => {
            assert.ok(error instanceof ArgusPeekError)
            assert.equal(error.code, 'capture_failed')
            assert.equal(error.details.reason, 'socket_not_open')
            return true
        })

        runtime.dispose()
    })

    it('scales the frame size ceiling with maxImageKB instead of a fixed 4MB', () => {
        const runtime = createContext()

        // 5MB 文本超过旧的固定 4MB 硬上限，但低于 maxImageKB=8192 换算出的
        // 上限，应放行到协议层（此处因非 JSON 以 1003 关闭，而非 1009）
        new ArgusService(runtime.context, config)
        const withinBudget = new FakeSocket()
        runtime.connect(withinBudget)
        withinBudget.emit('message', Buffer.alloc(5 * 1024 * 1024, 0x78), false)
        assert.equal(withinBudget.closeCode, 1003)

        // 超过 maxImageKB 换算上限的帧仍在连接层被拒绝
        const beyondBudget = new FakeSocket()
        runtime.connect(beyondBudget)
        beyondBudget.emit(
            'message',
            Buffer.alloc(12 * 1024 * 1024, 0x78),
            false
        )
        assert.equal(beyondBudget.closeCode, 1009)

        // 预算很小时上限仍保底 4MB
        new ArgusService(runtime.context, { ...config, maxImageKB: 512 })
        const atFloor = new FakeSocket()
        runtime.connect(atFloor)
        atFloor.emit('message', Buffer.alloc(5 * 1024 * 1024, 0x78), false)
        assert.equal(atFloor.closeCode, 1009)

        runtime.dispose()
    })
})

function lastPeekRequest(socket: FakeSocket) {
    const frame = socket.frames.filter((frame) => frame.type === 'peek').at(-1)
    assert.ok(frame?.type === 'peek')
    return frame
}

function countPeekRequests(socket: FakeSocket) {
    return socket.frames.filter((frame) => frame.type === 'peek').length
}
