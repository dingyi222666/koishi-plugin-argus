# koishi-plugin-argus

> 百眼巨人 Argus —— 让群友通过 `/peek` 命令偷窥你的电脑屏幕。

插件本体作为 WebSocket 服务，配套 CLI 客户端 [`argus-eye`](https://www.npmjs.com/package/argus-eye)
连接上来后，群里就能通过命令拉取实时模糊截图。

## 安全说明

- 客户端连接时必须带 `token`，错的直接踢。
- 截图 buffer 在 CLI 端用 `AES-256-GCM` 加密后才上 WebSocket，
  key 由 token 通过 scrypt 派生，IV 每帧随机。换句话说**抓包只能拿到密文**，
  插件这边解出来再做模糊处理。token 写错或者被改包都会被 GCM 校验拒绝。
- 默认 `authority: 1`，可调高到只允许特定群友 peek。

## 安装

```bash
npm i koishi-plugin-argus
```

依赖 `@koishijs/plugin-server`（需要在 koishi 配置中先启用并指定端口）。

## 使用

### 1. 启用插件

在 koishi 中加载 `argus` 插件，至少配置 `token`：

```yaml
plugins:
    server:
        port: 5140
    argus:
        token: 'a-strong-secret'
        path: '/argus'
        blur: 40
```

### 2. 在你自己的电脑跑 CLI

```bash
npx argus-eye -s ws://your-koishi-host:5140/argus -t a-strong-secret -n dingyi
```

### 3. 群里偷窥

```
/peek                 # 在线只有一个客户端时直接截
/peek dingyi          # 指定客户端
/peek dingyi -d 1     # 指定客户端的某块显示器
/peek dingyi -b 80    # 临时加大模糊（不能低于 minBlur）
/peek dingyi -f       # 强制重新截图，绕过 5 分钟缓存（需要 forceAuthority）
/peek --list          # 查看在线客户端
/dingyi               # registerAlias=true 时的别名（等价于 /peek dingyi）
```

群友连按 `/peek` 时不会让你电脑反复截图：默认 5 分钟内的同一客户端 + 同一显示器，
插件会复用上一次的图（消息后面带 `(缓存，剩余 4m12s)` 之类的提示）。
如果当时正在玩全屏游戏 / 全屏视频，CLI 会直接返回程序名，群里只会看到一行
「客户端「dingyi」正忙：League of Legends」，不会真的把画面发出去。

## ChatLuna / Character Agent 工具

安装并启用 ChatLuna 与
[`chatluna-storage-service`](https://www.npmjs.com/package/koishi-plugin-chatluna-storage-service)
后，可显式开启 Agent 截图资源工具：

```yaml
plugins:
    argus:
        token: 'a-strong-secret'
        enableChatLunaTool: true
        chatLunaToolBlur: 40
```

插件会注册 `argus_list_screens` 和 `argus_peek_screen`，供 ChatLuna 与
Character Agent 调用。Agent 会先查询在线客户端及其显示器，只在目标名称确实
在线时截取对应客户端，不会用其他在线客户端代替。截图工具通过 Koishi authority
检查权限，并与 `/peek` 共用客户端连接、图像处理和缓存管线。ChatLuna Storage
会将处理后的 JPEG 发布为临时 URL；截图工具始终在结果文本中返回该 URL。
当前模型具备图片输入能力时，同一张截图还会作为 `image_url` 内容块附在结果里，
模型可以直接识图；模型不支持图片输入（或不接受该图片格式）时，可借助 ChatLuna
多模态服务的 `read_files` 工具按 URL 读取（该工具默认关闭，需在
`chatluna-multimodal-service` 中显式配置 `enableImageReadTool: true`）：
`read_files` 会把图片交给当前模型原生读取，当前模型不支持图片输入时，则使用
多模态服务配置的图像理解模型生成描述。

Agent 截图始终使用 `chatLunaToolBlur`，不受 `blur` 和 `minBlur` 影响，
也不允许模型在工具调用中更改模糊值；配置为 `0` 时不进行模糊处理。`force`
参数仅用于明确要求最新截图的场景，并仍需满足 `forceAuthority`。Argus 的
`cacheDuration` 只管理截图 Buffer 缓存，Storage 临时 URL 的有效期由 Storage
插件管理。

## 配置项

| 字段                 | 类型                   | 默认     | 说明                                                                             |
| -------------------- | ---------------------- | -------- | -------------------------------------------------------------------------------- |
| `path`               | `string`               | `/argus` | WebSocket 挂载路径                                                               |
| `token`              | `string`               | `''`     | 客户端鉴权 token，必填                                                           |
| `commandName`        | `string`               | `peek`   | 顶层命令名                                                                       |
| `blur`               | `number`               | `40`     | 默认模糊半径（pixel）                                                            |
| `blurMode`           | `'gaussian' \| 'fast'` | `'fast'` | 模糊算法                                                                         |
| `minBlur`            | `number`               | `10`     | 命令里调小模糊时不可低于此值                                                     |
| `maxImageKB`         | `number`               | `8192`   | 单张截图大小上限（KB）                                                           |
| `finalMaxKB`         | `number`               | `200`    | 发到群里的最终图片体积上限（KB），插件会做二次压缩；0 = 关闭                     |
| `timeout`            | `number`               | `15000`  | 等待客户端响应超时（ms）                                                         |
| `cacheDuration`      | `number`               | `300000` | 截图缓存时长（ms），同一客户端、显示器和模糊半径分别缓存，0 = 关闭缓存           |
| `registerAlias`      | `boolean`              | `true`   | 是否给每个客户端注册同名别名                                                     |
| `enableChatLunaTool` | `boolean`              | `false`  | 是否向 ChatLuna 与 Character 注册客户端查询与截图资源工具；需要 ChatLuna Storage |
| `chatLunaToolBlur`   | `number`               | `40`     | Agent 截图使用的模糊半径，不受 `blur` 和 `minBlur` 影响；0 = 不模糊              |
| `authority`          | `number`               | `1`      | 命令所需权限等级                                                                 |
| `forceAuthority`     | `number`               | `3`      | 使用 `-f` 绕过缓存所需权限等级                                                   |
