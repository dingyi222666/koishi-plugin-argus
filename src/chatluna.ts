import { tool } from '@langchain/core/tools'
import type { MessageContentComplex } from '@langchain/core/messages'
import { Context, type Session } from 'koishi'
import {
    type ChatLunaToolRunnable,
    ModelCapabilities
} from 'koishi-plugin-chatluna/llm-core/platform/types'
import type {} from 'koishi-plugin-chatluna/services/chat'
import type {} from 'koishi-plugin-chatluna-storage-service'
import { z } from 'zod'
import type { Config } from '.'
import { isArgusPeekError } from './errors'

export const inject = ['argus', 'chatluna', 'chatluna_storage']

const peekScreenSchema = z.object({
    client: z
        .string()
        .trim()
        .min(1)
        .describe(
            'Exact Argus client name returned by argus_list_screens for the person requested by the user. Never guess or substitute another client.'
        ),
    display: z
        .union([z.number().int().nonnegative(), z.string().min(1)])
        .optional()
        .describe(
            "Exact display ID returned by argus_list_screens. Omit only to use the selected client's default display."
        ),
    force: z
        .boolean()
        .optional()
        .describe(
            'Bypass the screenshot cache. Use only when the user explicitly requests a fresh screenshot. Requires the configured force authority.'
        )
})

export function apply(ctx: Context, config: Config) {
    const listScreensTool = tool(
        async (
            _input: Record<string, never>,
            runConfig: ChatLunaToolRunnable
        ) => {
            try {
                const denied = await checkAuthority(
                    runConfig.configurable.session,
                    config.authority
                )
                if (denied) return denied

                return JSON.stringify({
                    clients: ctx.argus.listClients().map((client) => ({
                        name: client.name,
                        defaultDisplay: client.defaultDisplay,
                        displays: client.displays.map((display) => ({
                            id: display.id,
                            name: display.name
                        }))
                    }))
                })
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                return `Failed to list Argus clients: ${message}`
            }
        },
        {
            name: 'argus_list_screens',
            description: `List the Argus clients that are currently online and the displays reported by each client.
Always call this tool first for the current request when the user asks to view someone's computer.
Match the requested person against the returned client names.
If the target client is absent, report that the person is offline and do not capture another client's screen.`,
            schema: z.object({})
        }
    )

    const peekScreenTool = tool(
        async (
            input: z.infer<typeof peekScreenSchema>,
            runConfig: ChatLunaToolRunnable
        ) => {
            try {
                const requiredAuthority = input.force
                    ? Math.max(config.authority, config.forceAuthority)
                    : config.authority
                const denied = await checkAuthority(
                    runConfig.configurable.session,
                    requiredAuthority
                )
                if (denied) return [denied, []] as const

                const result = await ctx.argus.peek(input.client, {
                    display: input.display,
                    blur: config.chatLunaToolBlur,
                    force: input.force
                })

                if (result.kind === 'busy') {
                    const app =
                        result.busy.app || result.busy.title || 'unknown app'
                    return [
                        `Client "${result.client}" is busy: ${app}.`,
                        []
                    ] as const
                }

                const file = await ctx.chatluna_storage.createTempFile(
                    result.image,
                    'argus-screenshot.jpg',
                    undefined,
                    result.mime
                )

                // URL 始终作为文本返回；当前模型具备原生识图能力且接受该
                // mime 时，额外附带 image_url 内容块：视觉模型直接读图，
                // 非视觉模型仍只拿到 URL，可交给多模态插件按 URL 读取。
                const content: MessageContentComplex[] = [
                    { type: 'text', text: file.url }
                ]

                const model = runConfig.configurable.model
                const supportsImage =
                    model != null &&
                    model.modelInfo.capabilities.includes(
                        ModelCapabilities.ImageInput
                    ) &&
                    (model.fileHandlingConfig == null ||
                        model.fileHandlingConfig.supportedMimeTypes.has(
                            result.mime
                        ))

                if (supportsImage) {
                    content.push({
                        type: 'image_url',
                        image_url: { url: file.url }
                    })
                }

                return [content, []] as const
            } catch (error) {
                return [formatToolError(error), []] as const
            }
        },
        {
            name: 'argus_peek_screen',
            description: `Capture a screenshot from a specific remote computer connected to Argus.
For the current request, call argus_list_screens first and use the exact client name and display ID returned by it.
The client must match the person requested by the user; never substitute another online client.
Omit display only to use that client's default display.
Use force only when the user explicitly requests a fresh screenshot.
A successful call always returns the screenshot URL.
When the current model supports image input, the screenshot is also attached as image content you can inspect directly.
Otherwise, call read_files with the returned URL to inspect the image before answering the user.`,
            responseFormat: 'content_and_artifact',
            schema: peekScreenSchema
        }
    )

    for (const [registeredTool, tag] of [
        [listScreensTool, 'discovery'],
        [peekScreenTool, 'screenshot']
    ] as const) {
        ctx.effect(() =>
            ctx.chatluna.platform.registerTool(registeredTool.name, {
                description: registeredTool.description,
                selector() {
                    return true
                },
                meta: {
                    source: 'extension',
                    group: 'argus',
                    tags: ['argus', 'remote-screen', tag],
                    defaultAvailability: {
                        enabled: true,
                        main: true,
                        chatluna: true,
                        characterScope: 'all'
                    }
                },
                createTool() {
                    return registeredTool
                }
            })
        )
    }
}

async function checkAuthority(session: Session, requiredAuthority: number) {
    const user = await session.getUser(session.userId, ['authority'])
    if (
        !user ||
        typeof user.authority !== 'number' ||
        user.authority < requiredAuthority
    ) {
        return `Permission denied: authority ${requiredAuthority} is required.`
    }
}

function formatToolError(error: unknown): string {
    if (!isArgusPeekError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        return `Failed to capture or publish screenshot: ${message}`
    }

    switch (error.code) {
        case 'no_clients':
            return 'No Argus clients are connected.'
        case 'multiple_clients':
            return 'Multiple Argus clients are connected. Call argus_list_screens and provide the exact target client name.'
        case 'client_offline':
            return `Argus client "${error.details.client ?? 'unknown'}" is not connected. Do not capture another client's screen.`
        case 'timeout':
            return `Argus client "${error.details.client ?? 'unknown'}" timed out.`
        case 'image_too_large':
            return 'The screenshot exceeded the configured image size limit.'
        case 'decrypt_failed':
            return 'The screenshot could not be decrypted.'
        case 'capture_failed':
            return `Failed to capture screenshot: ${error.details.reason ?? error.message}`
    }
}
