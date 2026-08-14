import { strict as assert } from 'node:assert'
import { Context, type Session } from 'koishi'
import type { Config } from '../src'
import { applyChatLunaTools } from '../src/chatluna'
import { ArgusPeekError, type ArgusService } from '../src/service'
import type { ArgusPeekResult } from '../src/types'

interface RegisteredTool {
    description: string
    meta?: {
        defaultAvailability?: {
            enabled?: boolean
            main?: boolean
            chatluna?: boolean
            characterScope?: string
        }
    }
    createTool: () => {
        invoke: (input: unknown, config: unknown) => unknown
        schema: { shape: Record<string, unknown> }
    }
}

interface TestContext extends Context {
    chatluna_storage: {
        createTempFile: (image: Buffer) => Promise<{ url: string }>
    }
}

function createRuntime(result?: ArgusPeekResult, uploadError?: Error) {
    const tools = new Map<string, RegisteredTool>()
    const registeredTools: string[] = []
    const unregisteredTools: string[] = []
    const uploads: Buffer[] = []
    const peeks: Array<{
        client?: string
        options?: { display?: number | string; blur?: number; force?: boolean }
    }> = []
    const service = {
        listClients: () => [
            {
                name: 'alice',
                defaultDisplay: 'main',
                displays: [
                    {
                        id: 'main',
                        name: 'Primary',
                        width: 1920,
                        height: 1080
                    }
                ]
            }
        ],
        async peek(
            client?: string,
            options?: {
                display?: number | string
                blur?: number
                force?: boolean
            }
        ) {
            peeks.push({ client, options })
            return (
                result ?? {
                    kind: 'image',
                    client: 'alice',
                    image: Buffer.from('image'),
                    mime: 'image/jpeg'
                }
            )
        }
    } as ArgusService
    const context = new Context() as TestContext
    context.provide('chatluna', {
        platform: {
            registerTool(name: string, registered: RegisteredTool) {
                registeredTools.push(name)
                tools.set(name, registered)
                return () => {
                    unregisteredTools.push(name)
                    tools.delete(name)
                }
            }
        }
    })
    context.provide('chatluna_storage', {
        async createTempFile(image: Buffer) {
            uploads.push(image)
            if (uploadError) throw uploadError
            return { url: 'https://example.com/screenshot.jpg' }
        }
    })

    return {
        context,
        service,
        tools,
        registeredTools,
        unregisteredTools,
        uploads,
        peeks,
        async start() {
            applyChatLunaTools(context, config, service)
            await context.start()
        },
        async stop() {
            await context.stop()
        },
        dispose() {
            context.scope.reset()
        }
    }
}

const config: Config = {
    path: '/argus',
    token: 'secret',
    commandName: 'peek',
    blur: 80,
    blurMode: 'fast',
    minBlur: 10,
    maxImageKB: 8192,
    finalMaxKB: 200,
    timeout: 1000,
    cacheDuration: 60_000,
    registerAlias: false,
    enableChatLunaTool: true,
    chatLunaToolBlur: 0,
    authority: 1,
    forceAuthority: 3
}

function invoke(
    tool: RegisteredTool,
    input: unknown,
    authority = 3,
    model?: unknown
) {
    const session = {
        userId: 'user',
        async getUser() {
            return { authority }
        }
    } as Session
    return tool.createTool().invoke(input, {
        configurable: { session, model }
    })
}

function invokeWithAuthorityError(tool: RegisteredTool, input: unknown) {
    const session = {
        userId: 'user',
        async getUser() {
            throw new Error('database unavailable')
        }
    } as Session
    return tool.createTool().invoke(input, {
        configurable: { session }
    })
}

describe('ChatLuna tools', () => {
    it('registers the tools for ChatLuna and every Character scope', async () => {
        const runtime = createRuntime()
        await runtime.start()

        assert.deepEqual(
            [...runtime.tools.keys()],
            ['argus_list_screens', 'argus_peek_screen']
        )
        assert.deepEqual(runtime.registeredTools, [
            'argus_list_screens',
            'argus_peek_screen'
        ])
        for (const registered of runtime.tools.values()) {
            assert.deepEqual(registered.meta?.defaultAvailability, {
                enabled: true,
                main: true,
                chatluna: true,
                characterScope: 'all'
            })
        }
        assert.deepEqual(
            Object.keys(
                runtime.tools.get('argus_peek_screen')!.createTool().schema
                    .shape
            ),
            ['client', 'display', 'force']
        )

        await runtime.stop()
        assert.equal(runtime.tools.size, 0)
        assert.deepEqual(runtime.unregisteredTools, [
            'argus_list_screens',
            'argus_peek_screen'
        ])
    })

    it('lists only client and display identity fields', async () => {
        const runtime = createRuntime()
        await runtime.start()

        const output = await invoke(
            runtime.tools.get('argus_list_screens')!,
            {}
        )
        assert.deepEqual(JSON.parse(String(output)), {
            clients: [
                {
                    name: 'alice',
                    defaultDisplay: 'main',
                    displays: [{ id: 'main', name: 'Primary' }]
                }
            ]
        })

        await runtime.stop()
    })

    it('uses the agent blur and returns the Storage URL as text content', async () => {
        const runtime = createRuntime()
        await runtime.start()

        const output = await invoke(runtime.tools.get('argus_peek_screen')!, {
            client: 'alice',
            display: 'main',
            force: true
        })
        assert.deepEqual(output, [
            { type: 'text', text: 'https://example.com/screenshot.jpg' }
        ])
        assert.deepEqual(runtime.peeks, [
            {
                client: 'alice',
                options: { display: 'main', blur: 0, force: true }
            }
        ])
        assert.equal(runtime.uploads.length, 1)

        await runtime.stop()
    })

    it('attaches the screenshot as image content for models with image input', async () => {
        const runtime = createRuntime()
        await runtime.start()
        const tool = runtime.tools.get('argus_peek_screen')!
        const expected = [
            { type: 'text', text: 'https://example.com/screenshot.jpg' },
            {
                type: 'image_url',
                image_url: { url: 'https://example.com/screenshot.jpg' }
            }
        ]

        // 未声明 fileHandlingConfig 时视为不限 mime
        assert.deepEqual(
            await invoke(tool, { client: 'alice' }, 3, {
                modelInfo: { capabilities: ['image_input'] }
            }),
            expected
        )

        // 声明了 fileHandlingConfig 且包含 image/jpeg
        assert.deepEqual(
            await invoke(tool, { client: 'alice' }, 3, {
                modelInfo: { capabilities: ['image_input', 'text_input'] },
                fileHandlingConfig: {
                    supportedMimeTypes: new Set(['image/jpeg'])
                }
            }),
            expected
        )
        assert.equal(runtime.uploads.length, 2)

        await runtime.stop()
    })

    it('omits the image content when the model cannot handle it', async () => {
        const runtime = createRuntime()
        await runtime.start()
        const tool = runtime.tools.get('argus_peek_screen')!

        // 模型不具备图片输入能力
        assert.deepEqual(
            await invoke(tool, { client: 'alice' }, 3, {
                modelInfo: { capabilities: ['text_input'] }
            }),
            [{ type: 'text', text: 'https://example.com/screenshot.jpg' }]
        )

        // 具备图片能力但声明的 mime 不包含 image/jpeg
        assert.deepEqual(
            await invoke(tool, { client: 'alice' }, 3, {
                modelInfo: { capabilities: ['image_input'] },
                fileHandlingConfig: {
                    supportedMimeTypes: new Set(['image/png'])
                }
            }),
            [{ type: 'text', text: 'https://example.com/screenshot.jpg' }]
        )

        await runtime.stop()
    })

    it('uses the dedicated agent blur even when command blur settings differ', async () => {
        const runtime = createRuntime()
        await runtime.start()

        await invoke(runtime.tools.get('argus_peek_screen')!, {
            client: 'alice'
        })
        assert.equal(runtime.peeks[0].options?.blur, config.chatLunaToolBlur)
        assert.notEqual(runtime.peeks[0].options?.blur, config.blur)
        assert.notEqual(runtime.peeks[0].options?.blur, config.minBlur)

        await runtime.stop()
    })

    it('does not upload busy responses', async () => {
        const runtime = createRuntime({
            kind: 'busy',
            client: 'alice',
            busy: { type: 'peek_busy', id: 'request', app: 'game' }
        })
        await runtime.start()

        const output = await invoke(runtime.tools.get('argus_peek_screen')!, {
            client: 'alice'
        })
        assert.equal(output, 'Client "alice" is busy: game.')
        assert.equal(runtime.uploads.length, 0)

        await runtime.stop()
    })

    it('does not upload screenshot failures', async () => {
        const runtime = createRuntime()
        runtime.service.peek = async () => {
            throw new ArgusPeekError('client_offline', 'offline', {
                client: 'alice'
            })
        }
        await runtime.start()

        const output = await invoke(runtime.tools.get('argus_peek_screen')!, {
            client: 'alice'
        })
        assert.equal(
            output,
            'Argus client "alice" is not connected. Do not capture another client\'s screen.'
        )
        assert.equal(runtime.uploads.length, 0)

        await runtime.stop()
    })

    it('does not call the service when force authority is insufficient', async () => {
        const runtime = createRuntime()
        await runtime.start()

        const output = await invoke(
            runtime.tools.get('argus_peek_screen')!,
            { client: 'alice', force: true },
            2
        )
        assert.equal(output, 'Permission denied: authority 3 is required.')
        assert.equal(runtime.peeks.length, 0)
        assert.equal(runtime.uploads.length, 0)

        await runtime.stop()
    })

    it('does not call either tool dependency when base authority is insufficient', async () => {
        const runtime = createRuntime()
        await runtime.start()

        const listOutput = await invoke(
            runtime.tools.get('argus_list_screens')!,
            {},
            0
        )
        const peekOutput = await invoke(
            runtime.tools.get('argus_peek_screen')!,
            { client: 'alice' },
            0
        )

        assert.equal(listOutput, 'Permission denied: authority 1 is required.')
        assert.equal(peekOutput, 'Permission denied: authority 1 is required.')
        assert.equal(runtime.peeks.length, 0)
        assert.equal(runtime.uploads.length, 0)

        await runtime.stop()
    })

    it('fails closed when authority cannot be verified', async () => {
        const runtime = createRuntime()
        await runtime.start()

        const listOutput = await invokeWithAuthorityError(
            runtime.tools.get('argus_list_screens')!,
            {}
        )
        const peekOutput = await invokeWithAuthorityError(
            runtime.tools.get('argus_peek_screen')!,
            { client: 'alice' }
        )

        assert.equal(
            listOutput,
            'Failed to list Argus clients: database unavailable'
        )
        assert.equal(
            peekOutput,
            'Failed to capture or publish screenshot: database unavailable'
        )
        assert.equal(runtime.peeks.length, 0)
        assert.equal(runtime.uploads.length, 0)

        await runtime.stop()
    })

    it('reports Storage failures without returning an invalid URL', async () => {
        const runtime = createRuntime(
            undefined,
            new Error('storage unavailable')
        )
        await runtime.start()

        const output = await invoke(runtime.tools.get('argus_peek_screen')!, {
            client: 'alice'
        })
        assert.equal(
            output,
            'Failed to capture or publish screenshot: storage unavailable'
        )
        assert.equal(runtime.peeks.length, 1)
        assert.equal(runtime.uploads.length, 1)

        await runtime.stop()
    })

    it('unregisters the tools when its scope is disposed', async () => {
        const runtime = createRuntime()
        await runtime.start()

        assert.equal(runtime.tools.size, 2)
        runtime.dispose()
        assert.equal(runtime.tools.size, 0)
    })
})
