# koishi-plugin-argus

> 百眼巨人 Argus —— 让群友通过 `/peek` 命令偷窥你的电脑屏幕。

插件本体作为 WebSocket 服务，配套 CLI 客户端 [`argus-eye`](https://www.npmjs.com/package/argus-eye)
连接上来后，群里就能通过命令拉取实时模糊截图。

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
/peek --list          # 查看在线客户端
/dingyi               # registerAlias=true 时的别名（等价于 /peek dingyi）
```

## 配置项

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | `/argus` | WebSocket 挂载路径 |
| `token` | `string` | `''` | 客户端鉴权 token，必填 |
| `commandName` | `string` | `peek` | 顶层命令名 |
| `blur` | `number` | `40` | 默认模糊半径（pixel）|
| `blurMode` | `'gaussian' \| 'fast'` | `'fast'` | 模糊算法 |
| `minBlur` | `number` | `10` | 命令里调小模糊时不可低于此值 |
| `maxImageBytes` | `number` | `8 * 1024 * 1024` | 单张截图大小上限 |
| `timeout` | `number` | `15000` | 等待客户端响应超时（ms）|
| `registerAlias` | `boolean` | `true` | 是否给每个客户端注册同名别名 |
| `authority` | `number` | `1` | 命令所需权限等级 |
