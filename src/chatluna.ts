import { StructuredTool } from '@langchain/core/tools'
import { Context, type Session } from 'koishi'
import type {} from 'koishi-plugin-chatluna'
import type { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { z } from 'zod'
import type { Config } from '.'
import { formatRemaining } from './cache'
import {
    ArgusPeekError,
    type ArgusPeekResult,
    type ArgusPeekService
} from './peek'

const LIST_TOOL_NAME = 'argus_list_screens'
const LIST_TOOL_DESCRIPTION = `List the Argus clients that are currently online and the displays reported by each client.
Always call this tool first when the user asks to view someone's computer. Match the requested person against the returned client names. If the target client is absent, report that the person is offline and do not capture another client's screen.`

const PEEK_TOOL_NAME = 'argus_peek_screen'
const PEEK_TOOL_DESCRIPTION = `Capture a screenshot from a specific remote computer connected to Argus.
Call argus_list_screens first for the current request, then use the exact client name and display ID returned by that tool. The client must match the person requested by the user; never substitute another online client. Omit display only to use that client's default display. Use force only when the user explicitly requests a fresh screenshot.`

const listScreensSchema = z.object({})

const peekSchema = z.object({
    client: z
        .string()
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
            'Bypass the screenshot cache. Requires the configured force authority.'
        )
})

export function applyChatLunaTool(
    ctx: Context,
    config: Config,
    peekService: ArgusPeekService
) {
    ctx.on('ready', () => {
        ctx.effect(() =>
            ctx.chatluna.platform.registerTool(LIST_TOOL_NAME, {
                description: LIST_TOOL_DESCRIPTION,
                selector: () => true,
                meta: {
                    source: 'extension',
                    group: 'argus',
                    tags: ['argus', 'remote-screen', 'discovery'],
                    defaultAvailability: {
                        enabled: true,
                        main: true,
                        chatluna: true,
                        characterScope: 'all'
                    }
                },
                createTool() {
                    return new ArgusListScreensTool(peekService, config)
                }
            })
        )

        ctx.effect(() =>
            ctx.chatluna.platform.registerTool(PEEK_TOOL_NAME, {
                description: PEEK_TOOL_DESCRIPTION,
                selector: () => true,
                meta: {
                    source: 'extension',
                    group: 'argus',
                    tags: ['argus', 'remote-screen', 'screenshot'],
                    defaultAvailability: {
                        enabled: true,
                        main: true,
                        chatluna: true,
                        characterScope: 'all'
                    }
                },
                createTool() {
                    return new ArgusPeekTool(peekService, config)
                }
            })
        )
    })
}

class ArgusListScreensTool extends StructuredTool {
    name = LIST_TOOL_NAME
    description = LIST_TOOL_DESCRIPTION
    schema = listScreensSchema

    constructor(
        private peekService: ArgusPeekService,
        private config: Config
    ) {
        super()
    }

    async _call(
        _input: z.infer<typeof listScreensSchema>,
        _runManager: unknown,
        runnable?: ChatLunaToolRunnable
    ) {
        const denied = await checkAuthority(runnable, this.config.authority)
        if (denied) return denied

        const clients = this.peekService.listClients().map((client) => ({
            name: client.name,
            defaultDisplay: client.defaultDisplay,
            displays: client.displays.map((display) => ({
                id: display.id,
                name: display.name
            }))
        }))
        return JSON.stringify({ clients })
    }
}

class ArgusPeekTool extends StructuredTool {
    name = PEEK_TOOL_NAME
    description = PEEK_TOOL_DESCRIPTION
    schema = peekSchema

    constructor(
        private peekService: ArgusPeekService,
        private config: Config
    ) {
        super()
    }

    async _call(
        input: z.infer<typeof peekSchema>,
        _runManager: unknown,
        runnable?: ChatLunaToolRunnable
    ) {
        const requiredAuthority = Math.max(
            this.config.authority,
            input.force ? this.config.forceAuthority : this.config.authority
        )
        const denied = await checkAuthority(runnable, requiredAuthority)
        if (denied) return denied

        try {
            const result = await this.peekService.peek(input.client, {
                display: input.display,
                blur: this.config.chatLunaToolBlur,
                force: input.force
            })
            return formatToolResult(result)
        } catch (error) {
            return formatToolError(error)
        }
    }
}

async function checkAuthority(
    runnable: ChatLunaToolRunnable | undefined,
    requiredAuthority: number
) {
    const session = runnable?.configurable.session
    if (!session) {
        return 'Session context is unavailable; Argus access was denied.'
    }

    try {
        const authority = await getAuthority(session)
        if (authority < requiredAuthority) {
            return `Permission denied: authority ${requiredAuthority} is required.`
        }
    } catch {
        return 'Unable to verify the current user authority; Argus access was denied.'
    }
}

async function getAuthority(session: Session) {
    const user = await session.getUser(session.userId, ['authority'])
    return user?.authority ?? 0
}

function formatToolResult(result: ArgusPeekResult) {
    if (result.kind === 'busy') {
        const app = result.busy.app || result.busy.title || 'unknown app'
        const cacheNote =
            result.expiresAt !== undefined
                ? ` Cached for ${formatRemaining(result.expiresAt - Date.now())}.`
                : ''
        return `Client "${result.client}" is busy: ${app}.${cacheNote}`
    }

    const cacheNote =
        result.expiresAt !== undefined
            ? ` The cached screenshot expires in ${formatRemaining(result.expiresAt - Date.now())}.`
            : ''
    return [
        {
            type: 'text',
            text: `Captured a screenshot from client "${result.client}".${cacheNote}`
        },
        {
            type: 'image_url',
            image_url: {
                url: `data:${result.mime};base64,${result.image.toString('base64')}`,
                detail: 'low'
            }
        }
    ]
}

function formatToolError(error: unknown) {
    if (!(error instanceof ArgusPeekError)) {
        const message = error instanceof Error ? error.message : String(error)
        return `Failed to capture screenshot: ${message}`
    }

    switch (error.code) {
        case 'no_clients':
            return 'No Argus clients are connected.'
        case 'multiple_clients':
            return `Multiple Argus clients are connected. Call the tool again with one of these client names: ${error.details.clients?.join(', ') ?? ''}.`
        case 'client_offline':
            return `Argus client "${error.details.client ?? 'unknown'}" is not connected.`
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
