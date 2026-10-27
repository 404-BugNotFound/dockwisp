# Dockwisp

**按一下 `Alt+Space`，想打开的、想查的、想顺手处理的，都在这一个输入框里。**

Dockwisp 是一个 Windows 桌面启动器：搜应用、搜文件、切窗口，也能截图识字、翻译、换算、转格式。不用注册账号，没有订阅，大部分功能完全在本机完成。

> **English** — Dockwisp is a keyboard-first launcher for Windows 10/11. Press `Alt+Space` to launch apps, find files instantly (via Everything), switch windows, and run quick tools: offline screenshot OCR, translation, calculator and unit/currency conversion, file format conversion, text diff and hosts switching. It also runs uTools-style plugins. No account, no subscription, local-first. Free and open source under the MIT License.

![Dockwisp 启动器](docs/images/launcher.png)

## 它能帮你做什么

### 找东西，几乎不用等

- **打开应用**：开始菜单程序、商店应用、桌面快捷方式和系统工具都能搜到。支持拼音和首字母，`wx` 就能找到微信，越常用的越靠前。
- **全盘找文件**：输入 `文件 关键词`，用 Everything 秒级检索整块硬盘，结果可以直接预览或打开所在目录。
- **切换窗口**：输入 `窗口 关键词`，从一堆打开的窗口里直接跳过去。
- **系统操作**：锁屏、睡眠、关机、清空回收站、任务管理器、设备管理器、控制面板……打几个字就到。
- **常用置顶**：把常用的应用、文件或功能固定到首页，呼出就能点。

### 截图，顺手识字和翻译

按 `Alt+Shift+S` 框选区域，可以直接标注（矩形、箭头、画笔、马赛克），一键复制或保存。点「识别」提取图中文字，点「翻译」把识别出来的内容直接翻译（中英自动互译）。文字识别使用内置的 PP-OCR 模型，**全程离线**，截图不会离开你的电脑。

![截图编辑器](docs/images/screenshot-editor.png)

### 翻译，随叫随到

- **划词翻译**：在任何程序里选中文字，**长按鼠标中键**，译文就在旁边弹出来。
- **搜索框翻译**：直接在输入框里打英文句子，第一条结果就是译文。
- **翻译窗口**：需要处理长段落时，打开独立的翻译窗口编辑和切换语种。

默认使用 MyMemory 在线翻译。介意隐私的话，可以在设置中改成自己部署的 [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)。

![即时翻译](docs/images/translation.png)

### 输入框里的小工具

不用打开别的软件，直接在搜索框里输入，回车即可复制结果：

| 想做的事 | 输入示例 |
| --- | --- |
| 计算 | `(12+8)*3.5` |
| 单位换算 | `10 km to mi`、`100 km/h mph` |
| 汇率换算 | `100 USD to CNY` |
| 时间戳互转 | `1735660800`、`2026-01-01 08:00` |
| 格式化 JSON | 直接粘贴 JSON |
| Base64 编解码 | `b64 文本`、`b64d 编码` |
| 计算哈希 | `md5 文本`、`sha1 …`、`sha256 …` |
| 测试正则 | `regex 表达式` |

### 文件与文本处理

- **文件转换**：把文件拖进搜索框，或者在资源管理器里复制后粘贴进来，就会列出可以转换的目标格式。
  - 图片之间互转（png / jpg / webp / avif / tiff / gif / bmp / ico），图片转 PDF
  - Markdown / HTML / 纯文本转 PDF，JSON / YAML / CSV / XML 互转
  - Word / Excel / PPT 与 PDF 互转：首次使用时会提示下载一次 LibreOffice 便携组件（约 358 MB，无需管理员权限，不依赖本机 Office）。PDF 转 Word 适合提取内容再编辑，复杂版式无法完全还原。
- **文本对比**：左右两栏对比两段文本，差异高亮。
- **hosts 切换**：保存多套 hosts 方案，开发、测试环境一键切换。

### 插件

兼容 uTools 风格的 `plugin.json` 插件，也可以直接安装 `.upx` / `.upxs` 离线插件包。插件可以使用 Node.js 和 Electron 的能力，**请只安装来源可信的插件**。具体兼容情况见 [插件兼容矩阵](docs/compatibility.md)。

## 安装

1. 到 [Releases](../../releases/latest) 下载最新的 `Dockwisp-<版本号>-x64.exe`。
2. 运行安装程序。如果 Windows SmartScreen 提示「未知发布者」，确认是从本仓库下载的之后，点「更多信息 → 仍要运行」。安装包目前还没有做商业代码签名。
3. 安装完成后按 `Alt+Space` 开始使用。

以后在「设置 → 检查更新」里就能一键下载并安装新版本，安装包会先校验完整性。

**系统要求**：Windows 10 / 11（64 位）。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+Space` | 呼出 / 隐藏启动器 |
| `Alt+Shift+S` | 截图 |
| 长按鼠标中键 | 翻译选中的文字 |
| `↑` `↓` / `Enter` | 选择 / 打开结果 |
| `Esc` | 关闭启动器 |
| 结果上右键 | 以管理员身份运行、打开所在目录、复制路径等 |

快捷键、长按时长、主题、窗口透明度和开机自启，都可以在设置里调整。

## 隐私

- 应用搜索、文件搜索、截图、文字识别、文件预览和大多数格式转换都在本机完成，不会上传。
- 只有这几项会联网：在线翻译（默认 MyMemory，可改为自建 LibreTranslate）、汇率换算获取最新汇率、检查更新访问 GitHub、首次使用 Office 转换时下载 LibreOffice。
- 不需要账号，不收集使用数据。

## 从源码构建

需要 Windows 10/11、Node.js 和 Visual Studio C++ Build Tools。

```powershell
npm install
npm run fetch:ocr-models   # 下载固定版本的 OCR 模型
npm test                   # 单元测试
npm start                  # 构建并运行
npm run dist               # 完整校验后打包到 release/Dockwisp-<version>-x64.exe
```

构建前还需要按照 [native/sdk/README.md](native/sdk/README.md) 和 [native/portable/README.md](native/portable/README.md) 放好 Everything SDK 和便携版的第三方文件，这些文件不随仓库提交。

## 许可证

Dockwisp 基于 [MIT License](LICENSE) 开源。所用第三方组件及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
