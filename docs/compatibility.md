# 插件兼容矩阵

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `plugin.json` / `features` / `cmds` | 支持 | 覆盖常见字段，严格阻止路径逃逸 |
| `base`、`regex`、`over` | 支持 | 正则在受限 VM 中执行 |
| `files`、`img`、`window` | 部分支持 | 文件拖放已接通；图片/当前窗口入口待补充 UI |
| 插件 preload（CommonJS） | 支持 | 可信模式，独立插件窗口 |
| `.upx` / `.upxs` 离线包 | 支持/部分 | 支持标准 gzip-ASAR；拒绝链接、越界、超限和未知私有格式 |
| `onPluginReady/Enter/Out` | 部分支持 | Ready/Enter 已接通，Out 行为继续完善 |
| 主窗口、路径、shell、dialog、通知 | 支持/部分 | 高频方法已实现，未实现项返回明确错误 |
| `dbStorage`、`db` | 支持/部分 | 本地 JSON 文档存储；不含云同步与附件 |
| 动态 `setFeature/removeFeature/getFeatures` | 支持 | 仅当前运行期保存 |
| `createBrowserWindow` | 部分支持 | 限制为安全方法白名单 |
| `ubrowser` | 未实现 | 后续兼容层 |
| AI、账号、支付、团队、云同步 | 不支持 | 属于官方私有服务边界 |
| 原生 Node 模块 | 条件兼容 | 取决于 Electron/Node ABI |

## 安全边界

现有插件 preload 通常需要 Node.js 和 Electron API。Dockwisp 使用 wrapper preload 提供兼容对象，但这类插件仍可访问本机能力。请只加载可信目录；后续版本将增加逐插件权限提示和更细粒度隔离。
