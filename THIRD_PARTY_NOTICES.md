# Third-Party Notices

Dockwisp 的原创代码按 MIT License 发布（见 `LICENSE`）。以下第三方组件保留各自许可证；本项目许可证不覆盖它们。

## 随应用分发的组件

| 组件 | 许可证 | 许可文本位置 |
| --- | --- | --- |
| Electron | MIT | 安装目录中的 `LICENSE.electron.txt`；https://github.com/electron/electron |
| Chromium | BSD-style 及第三方许可证 | 安装目录中的 `LICENSES.chromium.html`；https://www.chromium.org/ |
| Everything SDK | MIT + PCRE BSD | `native/sdk/License.txt`；安装包中的 `native/Everything-SDK-License.txt` |
| Everything 便携版 | MIT + PCRE BSD | `native/portable/License.txt`；安装包中的 `native/Everything-License.txt` |
| PP-OCRv5 ONNX 模型 | Apache-2.0 | `native/ocr-models/LICENSE`；安装包中的 `native/ocr-models/LICENSE` |
| ppu-paddle-ocr | MIT | npm 包内 `LICENSE`；https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr |
| ppu-ocv | MIT | npm 包内 `LICENSE`；https://github.com/PT-Perkasa-Pilar-Utama/ppu-ocv |
| ONNX Runtime | MIT | https://github.com/microsoft/onnxruntime/blob/main/LICENSE |
| OpenCV.js (@techstark/opencv-js) | Apache-2.0 | npm 包内 `LICENSE`；https://github.com/TechStark/opencv-js |
| @napi-rs/canvas | MIT | npm 包内 `LICENSE`；https://github.com/Brooooooklyn/canvas |
| sharp | Apache-2.0 | npm 包内 `LICENSE`；https://github.com/lovell/sharp |
| libvips 及其依赖（随 @img/sharp-win32-x64 分发） | Apache-2.0 AND LGPL-3.0-or-later | npm 包内 `LICENSE`；以独立 DLL 动态链接，可自行替换；https://github.com/libvips/libvips |
| pinyin-pro | MIT | 下方全文；Copyright (c) 2022-present zh-lx |
| @electron/asar | MIT | 下方全文；Copyright (c) 2014 GitHub Inc. |
| marked | MIT | npm 包内 `LICENSE.md`；https://github.com/markedjs/marked |
| yaml | ISC | npm 包内 `LICENSE`；https://github.com/eemeli/yaml |
| iconv-lite（含 safer-buffer） | MIT | npm 包内 `LICENSE`；https://github.com/pillarjs/iconv-lite |
| qrcode（含 dijkstrajs、pngjs 等依赖） | MIT | npm 包内 `license`；Copyright (c) 2012 Ryan Day；https://github.com/soldair/node-qrcode |

## 按需下载的组件

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| LibreOffice | MPL-2.0 | 首次使用文档转换时，经用户确认后从 The Document Foundation 官方站点下载并校验 SHA-256；不随安装包分发。https://www.libreoffice.org/about-us/licenses |
| PDF 转 Word 组件：CPython 嵌入版 3.14.10、pdf2docx 0.5.13、PyMuPDF 1.28.2、python-docx、lxml、fontTools、NumPy、opencv-python-headless、fire、termcolor、typing_extensions | PSF-2.0；PyMuPDF 为 AGPL-3.0（Artifex 双许可）；pdf2docx 及其余为 MIT / BSD / Apache-2.0 | 首次使用 PDF 转 Word 时，经用户确认后从 python.org 与 PyPI 官方地址下载并逐个校验 SHA-256，解压到用户数据目录，以独立进程调用；不随安装包分发。https://github.com/ArtifexSoftware/pdf2docx 、https://github.com/pymupdf/PyMuPDF |

## pinyin-pro

```text
MIT License

Copyright (c) 2022-present zh-lx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @electron/asar

```text
Copyright (c) 2014 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
