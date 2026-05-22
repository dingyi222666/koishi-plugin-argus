import { createJimp } from '@jimp/core'
import { defaultFormats, defaultPlugins } from 'jimp'

const Jimp = createJimp({
    formats: [...defaultFormats],
    plugins: defaultPlugins
})

export type BlurMode = 'gaussian' | 'fast'

export interface BlurOptions {
    /** 模糊半径，越大越糊。 */
    radius: number
    /** 模糊算法。`gaussian` 质量好但慢；`fast` 用 jimp.blur，速度快。 */
    mode?: BlurMode
}

/**
 * 加载任意常见格式（png/jpg/webp 等）的图片，应用模糊后输出 PNG buffer。
 */
export async function blurImage(
    input: Buffer,
    options: BlurOptions
): Promise<Buffer> {
    const radius = clamp(Math.round(options.radius), 0, 200)
    const image = await Jimp.read(input)

    if (radius > 0) {
        if (options.mode === 'gaussian') {
            // jimp gaussian 接受 1-10 之间较合理；映射 1-200 → 1-10
            const r = Math.max(1, Math.min(10, Math.round(radius / 20)))
            image.gaussian(r)
        } else {
            // jimp.blur 半径上限大约 100；继续放大也意义不大
            const r = Math.max(1, Math.min(100, radius))
            image.blur(r)
        }
    }

    return await image.getBuffer('image/png')
}

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
}
