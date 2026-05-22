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
    defaultDisplay?: number
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
    /** PNG/JPEG base64（不带 data: 前缀）。*/
    image: string
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
    | PingFrame
    | PongFrame
    | ByeFrame

export type ServerFrame =
    | HelloAckFrame
    | PeekRequestFrame
    | PingFrame
    | PongFrame
