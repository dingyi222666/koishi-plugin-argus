// WebSocket 协议帧类型与运行时类型定义。
// 客户端 / 服务端共用此协议，注意保持向后兼容。

export interface DisplayInfo {
    id: number | string
    name?: string
    width?: number
    height?: number
    primary?: boolean
}

/** Client → Server: 上线握手 */
export interface HelloFrame {
    type: 'hello'
    name: string
    token: string
    version?: string
    displays?: DisplayInfo[]
    defaultDisplay?: number | string
}

/** Server → Client: 握手响应 */
export interface HelloAckFrame {
    type: 'hello_ack'
    ok: boolean
    error?: string
}

/** Server → Client: 请求一次截图 */
export interface PeekRequestFrame {
    type: 'peek'
    id: string
    display?: number | string
}

/** Client → Server: 截图结果 */
export interface PeekResultFrame {
    type: 'peek_result'
    id: string
    /**
     * 图片 buffer，base64 编码。
     * `enc` 为 `aes-256-gcm` 时为 base64(iv|tag|ciphertext)，token 派生 key 解密。
     * `enc` 缺省 / 为 `none` 时为图片原始字节的 base64（向后兼容旧 CLI）。
     */
    image: string
    /** 加密算法。新版客户端始终发 `aes-256-gcm`。 */
    enc?: 'aes-256-gcm' | 'none'
    mime?: string
    width?: number
    height?: number
    display?: number | string
}

/** Client → Server: 截图失败 */
export interface PeekErrorFrame {
    type: 'peek_error'
    id: string
    error: string
}

/**
 * Client → Server: 客户端拒绝截图（例如正在全屏游戏 / 全屏应用）。
 * Plugin 收到此帧时不再返回截图，而是返回一段文字提示。
 */
export interface PeekBusyFrame {
    type: 'peek_busy'
    id: string
    /** 当前活动应用程序名（如 "League of Legends" / "explorer.exe"） */
    app?: string
    /** 窗口标题 */
    title?: string
    /** 自定义原因（默认 fullscreen） */
    reason?: 'fullscreen' | string
}

/** 双向心跳 */
export interface PingFrame {
    type: 'ping'
    t?: number
}

export interface PongFrame {
    type: 'pong'
    t?: number
}

/** Client → Server: 优雅断线 */
export interface ByeFrame {
    type: 'bye'
    reason?: string
}

export type ClientFrame =
    | HelloFrame
    | PeekResultFrame
    | PeekErrorFrame
    | PeekBusyFrame
    | PingFrame
    | PongFrame
    | ByeFrame

export type ServerFrame =
    | HelloAckFrame
    | PeekRequestFrame
    | PingFrame
    | PongFrame
