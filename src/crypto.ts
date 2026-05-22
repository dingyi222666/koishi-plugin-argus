import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    scryptSync
} from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
/** 固定 salt：CLI / 插件双方都拿到同一个 token 就能推同一把 key。 */
const SALT = Buffer.from('argus.peek.v1', 'utf8')

const keyCache = new Map<string, Buffer>()

function deriveKey(token: string) {
    let key = keyCache.get(token)
    if (key) return key
    key = scryptSync(token, SALT, KEY_LEN)
    keyCache.set(token, key)
    return key
}

/**
 * AES-256-GCM 加密。返回 base64(iv | tag | ciphertext)。
 */
export function encryptBuffer(plain: Buffer, token: string): string {
    const key = deriveKey(token)
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv(ALGO, key, iv)
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ct]).toString('base64')
}

/**
 * 解密 encryptBuffer 的输出。token 不对 / 数据被改 / 格式不匹配都会抛错。
 */
export function decryptBuffer(payloadBase64: string, token: string): Buffer {
    const buf = Buffer.from(payloadBase64, 'base64')
    if (buf.length < IV_LEN + TAG_LEN) {
        throw new Error('ciphertext_too_short')
    }
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct = buf.subarray(IV_LEN + TAG_LEN)
    const key = deriveKey(token)
    const decipher = createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** 协议字段：标识 image 字段使用何种加密。当前只用一种。 */
export const ENC_ALGO = 'aes-256-gcm' as const
export type EncAlgo = typeof ENC_ALGO
