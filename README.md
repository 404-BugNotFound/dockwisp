# Dockwisp

Dockwisp 是一个面向 Windows 的快捷启动器和插件主机。项目采用 clean-room 方式实现，兼容常见的插件 `plugin.json`、preload 和常用插件 API，同时保留可继续扩展的独立架构。

> 本项目不包含第三方产品的商标、图标、界面资源或专有源码。

## 当前 MVP

- `Alt+Space` 全局呼出（冲突时回退到 `Ctrl+Space`）
- 单输入框快捷启动器，结果向下展开，无窗口阴影
- 开始菜单、桌面和自定义路径索引，应用显示真实图标
- 中文、拼音、首字母和模糊搜索，相关性优先排序
- 拖入 `.exe` 即可把便携应用加入索引
- 右键结果可固定到主页（应用、插件、文件）
- 应用/文件右键：打开、打开所在目录、复制路径/文件名、以管理员身份运行
- 内置计算器/单位/汇率、JSON/Base64/时间戳/哈希/正则工具
- 使用频率/最近排序，设置页可清空统计
- 系统命令：锁屏、睡眠、清空回收站、音量、关机/重启、任务管理器、设置、资源管理器
- `窗口 关键词` / `win 关键词` 搜索并切换可见窗口
- `文件 关键词` 或“搜索文件”结果进入全盘文件搜索（Everything，内置便携版回退）
- 插件 `base`、`regex`、`over`、`files`、`img`、`window` 指令模型
- 标准 gzip-ASAR `.upx/.upxs` 离线包安全导入
- 插件生命周期、基础系统 API、`db` / `dbStorage`、动态 feature
- 全局长按中键取词翻译
- MyMemory 免 Key 翻译和可配置 LibreTranslate
- 原创 Win32 低级鼠标钩子 helper

## 文件搜索

文件搜索依赖 [Everything](https://www.voidtools.com/)：Dockwisp 通过 `native/bin/everything-search.exe` 调用 Everything SDK 查询全盘索引，速度通常在 100 ms 内。优先使用本机安装的 Everything；未安装时使用打包的便携版 Everything。Everything 不可用时会回退到桌面、下载、文档和自定义目录的本地索引。

Everything SDK（`native/sdk`）按 MIT 许可分发，详见 `native/sdk/License.txt`。SDK 的二进制文件和便携版 `Everything.exe/.lng` 不提交到仓库，按 `native/sdk/README.md` 与 `native/portable/README.md` 的说明放置。

## 项目结构与构建产物

- `src/`：Electron/TypeScript 源码；`native/src/`：Win32 helper 源码
- `native/sdk/`：Everything SDK 头文件、许可和说明（二进制需按 README 放置）
- `native/portable/`：便携版 Everything 放置目录（二进制不提交）
- `dist/`、`dist-test/`：TypeScript 编译和测试输出，已被 git 忽略
- `release/`：**唯一的打包输出目录**（安装包 + `win-unpacked`），已被 git 忽略；`npm run dist` 会覆盖它
- `temp/`：临时/历史构建目录，已被 git 忽略（仅保留 README）
- `node_modules/`、`native/bin/`、`native/obj/`：依赖与本地构建产物，忽略

不要创建 `release-*` 之类的新输出目录；需要暂存中间产物时放到 `temp/`。安装包和 exe 不进入 git，发布时作为 GitHub Release 附件上传。


## 开发

要求：Windows 10/11、Node.js、Visual Studio C++ Build Tools。

```powershell
npm install
npm test
npm run build
npm start
```

开发模式会自动加载 `fixtures/plugins/compat-smoke` 测试插件。

首次构建前，请按 `native/sdk/README.md` 与 `native/portable/README.md` 放置第三方二进制（Everything SDK 的 lib/dll、便携版 `Everything.exe/.lng`）；它们不提交到 git，但本地构建和打包需要。

## 插件目录

设置页可添加一个含 `plugin.json` 的插件目录。插件 preload 拥有 Node/Electron 能力，因此只应加载可信插件。当前兼容状态见 `docs/compatibility.md`。

## 许可证

Dockwisp 原创代码采用 [MIT License](LICENSE)。第三方组件（Electron/Chromium、Everything SDK/便携版、pinyin-pro、@electron/asar）保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
