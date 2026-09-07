import type { Context } from 'koishi'
import type { Config } from '.'
import { blurImage } from './blur'
import { compressToBudget } from './compress'
import { decryptBuffer } from './crypto'
import { ArgusPeekError } from './errors'
import type { PeekResultFrame } from './types'

export function processImage(
    ctx: Context,
    config: Pick<Config, 'token' | 'blurMode' | 'finalMaxKB'>,
    frame: PeekResultFrame,
    radius: number
): Buffer {
    const buffer = decodeImage(frame, config.token)
    const blurStart = Date.now()
    const blurred = blurImage(buffer, { radius, mode: config.blurMode })
    const blurMs = Date.now() - blurStart
    const compressStart = Date.now()
    const targetBytes = config.finalMaxKB * 1024
    const output =
        targetBytes > 0 && blurred.length > targetBytes
            ? compressToBudget(blurred, { targetBytes })
            : blurred

    ctx.logger.debug(
        'peek pipeline: blur=%dms compress=%dms %dKB -> %dKB',
        blurMs,
        Date.now() - compressStart,
        Math.round(blurred.length / 1024),
        Math.round(output.length / 1024)
    )
    return output
}

function decodeImage(frame: PeekResultFrame, token: string): Buffer {
    try {
        if (!frame.enc || frame.enc === 'none') {
            return Buffer.from(frame.image, 'base64')
        }
        if (frame.enc === 'aes-256-gcm') {
            return decryptBuffer(frame.image, token)
        }
        throw new Error(`unsupported_enc:${frame.enc}`)
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new ArgusPeekError(
            'decrypt_failed',
            'failed to decrypt screenshot',
            { reason }
        )
    }
}
