import {
    PhotonImage,
    gaussian_blur,
    resize,
    SamplingFilter
} from '@cf-wasm/photon/node'

export type BlurMode = 'gaussian' | 'fast'

export interface BlurOptions {
    /** 模糊半径，越大越糊。0 = 不模糊。 */
    radius: number
    /** 兼容旧字段；当前实现都按 gaussian 处理。 */
    mode?: BlurMode
}

/**
 * 真高斯模糊（photon WASM 实现）。
 *
 * 流程：
 *   1. 把图缩到一半尺寸，减少模糊本身的计算量
 *   2. 对缩小图做 gaussian_blur(半径按 radius 派生)
 *   3. 放大回原尺寸（Triangle 让放大过程平滑，模糊就不会因放大变锯齿）
 *   4. 编码 JPEG q=80
 *
 * 这种"先缩半 → 真高斯 → 拉回"的方式能在 ~500ms 内做出真正高斯模糊，
 * 而不是简单的马赛克 / 像素化。
 */
export function blurImage(input: Buffer, options: BlurOptions): Buffer {
    const radius = clamp(Math.round(options.radius), 0, 200)
    const img = PhotonImage.new_from_byteslice(new Uint8Array(input))
    try {
        if (radius === 0) {
            return Buffer.from(img.get_bytes_jpeg(85))
        }

        const w = img.get_width()
        const h = img.get_height()
        const halfW = Math.max(2, Math.round(w / 2))
        const halfH = Math.max(2, Math.round(h / 2))

        // 缩半后用一半的半径做高斯，等效于原图上 2 倍的模糊范围
        const halfRadius = Math.max(1, Math.round(radius / 2))

        const half = resize(img, halfW, halfH, SamplingFilter.Triangle)
        try {
            gaussian_blur(half, halfRadius)
            const back = resize(half, w, h, SamplingFilter.Triangle)
            try {
                return Buffer.from(back.get_bytes_jpeg(80))
            } finally {
                back.free()
            }
        } finally {
            half.free()
        }
    } finally {
        img.free()
    }
}

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
}
