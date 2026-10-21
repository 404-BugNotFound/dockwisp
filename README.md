# Dockwisp

一个面向 Windows 的快捷启动器。按下 `Alt+Space`，搜索应用和文件，或随手完成截图、OCR、翻译、文件转换与文本对比。

无需账号，没有订阅，也不强制更新。搜索、截图、OCR、文件预览和格式转换均在本机完成，翻译也可接入本地 [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)。

![Dockwisp 启动器](docs/images/launcher.png)

## 功能

- **启动器**：快捷键呼出，搜索并启动应用、商店应用和系统工具
- **模糊搜索**：支持拼音、首字母，常用项自动排前
- **主页固定**：常用应用、文件、功能可固定到首页
- **文件搜索**：基于 Everything 全盘秒搜，可直接预览
- **窗口切换**：搜索并切换到已打开的窗口
- **系统命令**：锁屏、关机、打开系统设置等
- **快捷计算**：计算器、单位和汇率换算，结果一键复制
- **文本工具**：JSON 格式化、Base64、时间戳、哈希、正则
- **划词翻译**：中键长按翻译选中的文字
- **翻译窗口**：输入英文即可翻译，支持编辑和多语种
- **截图 OCR**：区域截图、标注、离线识别文字并翻译
- **hosts 切换**：管理多套 hosts 方案，一键应用
- **文本对比**：左右对比两段文本，高亮显示差异
- **文件转换**：图片、文档、数据格式互转，可粘贴文件直接转换
- **插件扩展**：兼容 uTools 风格插件，可安装插件包
- **应用内更新**：设置里一键检查、下载并安装新版本
- **个性化设置**：主题、透明度、快捷键、开机自启

| 即时翻译 | 截图与 OCR |
| --- | --- |
| ![即时翻译](docs/images/translation.png) | ![截图编辑器](docs/images/screenshot-editor.png) |

### 文件转换说明

- 图片（png / jpg / webp / avif / tiff / gif / bmp / ico）互转与图片转 PDF，开箱即用。
- Markdown / HTML / 文本转 PDF，JSON / YAML / CSV / XML 互转，开箱即用。
- Word / Excel / PPT 与 PDF 互转需要 LibreOffice。首次使用时会提示下载官方便携组件（约 358 MB，仅需一次，无需管理员权限），不依赖本机已安装的 Office。
- PDF 转 Word 的版式还原度有限，适合提取内容后再编辑。

## 安装

从 [Releases](../../releases) 下载 `Dockwisp-<version>-x64.exe`，退出旧版本后安装。0.1.4 起可在“设置”中检查并安装更新。

> 安装包暂未进行商业代码签名，Windows SmartScreen 可能提示“未知发布者”。确认下载来源无误后，可选择“更多信息 → 仍要运行”。

## 开发

环境要求：Windows 10/11、Node.js、Visual Studio C++ Build Tools。

```powershell
npm install
npm test
npm start
```

本地构建前，请按照 `native/sdk/README.md` 和 `native/portable/README.md` 放置 Everything SDK 与便携版所需的第三方二进制，并准备固定版本的本地 OCR 模型：

```powershell
npm run fetch:ocr-models
```

```powershell
npm run build
npm run dist
```

`npm run dist` 会运行测试与冒烟检查，并把安装包输出到 `release/Dockwisp-<version>-x64.exe`。

## 插件

Dockwisp 兼容常见的 `plugin.json` 插件和 `.upx/.upxs` 离线插件包。插件拥有 Node.js / Electron 能力，请只加载可信来源；兼容情况见 [docs/compatibility.md](docs/compatibility.md)。

## 许可证

Dockwisp 采用 [MIT License](LICENSE)。第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
