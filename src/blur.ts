import {
    PhotonImage,
    box_blur,
    resize,
    SamplingFilter
} from '@cf-wasm/photon/node'

export type BlurMode = 'gaussian' | 'fast'

export interface BlurOptions {
    /** 模糊半径，越大越糊。0 = 不模糊。 */
    radius: number
    /** 兼容旧字段；photon 实现里 'gaussian' 会多过一次 box_blur。 */
    mode?: BlurMode
}

/**
 * 模糊算法（photon WASM 实现）：
 *
 * 把图缩到 1/N 尺寸（N 由 radius 决定），不做 upsample 直接编 JPEG。
 * 缩小本身就是强力模糊（细节都被平均掉了），同时 JPEG 编码体积小、耗时短，
 * 整体在 100ms 量级完成。聊天客户端展示时会自动放大，看起来就是糊图。
 *
 * - radius 0      → 直接编 JPEG（不模糊）
 * - radius 1..50  → factor = round(radius / 4) + 2 ≈ 2-15 倍下采样
 * - radius 51..200 → factor = round(radius / 6) + 4 ≈ 12-37 倍下采样
 *
 * `mode='gaussian'` 时多过一次 box_blur 让边缘柔和。
 */
export function blurImage(input: Buffer, options: BlurOptions): Buffer {
    const radius = clamp(Math.round(options.radius), 0, 200)
    const img = PhotonImage.new_from_byteslice(new Uint8Array(input))
    try {
        if (radius === 0) {
            return Buffer.from(img.get_bytes_jpeg(85))
        }

        const factor =
            radius <= 50
                ? Math.round(radius / 4) + 2
                : Math.round(radius / 6) + 4

        const w = img.get_width()
        const h = img.get_height()
        const sw = Math.max(2, Math.round(w / factor))
        const sh = Math.max(2, Math.round(h / factor))

        const small = resize(img, sw, sh, SamplingFilter.Triangle)
        try {
            if (options.mode === 'gaussian') box_blur(small)
            return Buffer.from(small.get_bytes_jpeg(85))
        } finally {
            small.free()
        }
    } finally {
        img.free()
    }
}

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
}
