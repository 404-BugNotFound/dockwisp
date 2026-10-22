# PP-OCR 混合精度模型

Dockwisp 使用 PP-OCRv5 Mobile 检测模型定位文字区域，并使用 PP-OCRv6 Small 识别模型进行中英文 OCR。v6 Small 识别模型对深色背景、小字号和浅灰色文字的识别明显好于 v5 Mobile，耗时基本持平。模型随安装包分发，运行时不联网。

模型源固定为 Hugging Face 仓库 `snowfluke/ppu-paddle-ocr-models` 的提交：

`bf1d5edb0335d3262be7caf13f766ba274b4cadd`

本地准备模型：

```powershell
npm run fetch:ocr-models
```

该命令下载并校验以下文件：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `PP-OCRv5_mobile_det_infer.onnx` | 4,748,769 | `d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924` |
| `PP-OCRv6_small_rec.ort` | 21,290,816 | `40bccd9fa3ae2d14d724bf9d020c8f0edfc801489477b92f7449162a538366df` |
| `ppocrv6_dict.txt` | 74,948 | `41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8` |

模型基于 PaddleOCR，按 Apache License 2.0 分发，许可文本见本目录 `LICENSE`。模型文件不提交到 Git。
