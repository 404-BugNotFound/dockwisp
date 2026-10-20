# Dockwisp

一个面向 Windows 的快捷启动器。按下 `Alt+Space`，搜索应用和文件，或随手完成截图、OCR、翻译与计算。

无需账号，没有订阅，也不强制更新。搜索、截图、OCR 和文件预览均在本机完成，翻译也可接入本地 [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)。

![Dockwisp 启动器](docs/images/launcher.png)

## 功能

- 统一搜索应用、文件和 Windows 系统工具
- 基于 Everything 的全盘文件搜索，支持便携版与本地索引回退
- 截图、标注、OCR 与划词翻译
- 图片、文本、音视频及 PDF 预览
- 计算器、单位换算和常用文本工具
- 主题、结果固定与插件扩展

| 即时翻译 | 截图与 OCR |
| --- | --- |
| ![即时翻译](docs/images/translation.png) | ![截图编辑器](docs/images/screenshot-editor.png) |

## 安装

从 [Releases](../../releases) 下载 `Dockwisp-<version>-x64.exe`，退出旧版本后安装。

> 安装包暂未进行商业代码签名，Windows SmartScreen 可能提示“未知发布者”。确认下载来源无误后，可选择“更多信息 → 仍要运行”。

## 开发

环境要求：Windows 10/11、Node.js、Visual Studio C++ Build Tools。

```powershell
npm install
npm test
npm start
```

本地构建前，请按照 `native/sdk/README.md` 和 `native/portable/README.md` 放置 Everything SDK 与便携版所需的第三方二进制。

```powershell
npm run build
npm run dist
```

## 插件

Dockwisp 兼容常见的 `plugin.json` 插件和 `.upx/.upxs` 离线插件包。插件拥有 Node.js / Electron 能力，请只加载可信来源；兼容情况见 [docs/compatibility.md](docs/compatibility.md)。

## 许可证

Dockwisp 采用 [MIT License](LICENSE)。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
