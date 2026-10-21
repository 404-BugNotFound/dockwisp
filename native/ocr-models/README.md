# PP-OCRv5 混合精度模型

Dockwisp 使用 PP-OCRv5 Mobile 检测模型定位文字区域，并使用 PP-OCRv5 Server 识别模型进行中英文 OCR。该组合在应用截图上比全 Server 检测更稳定。模型随安装包分发，运行时不联网。

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
| `PP-OCRv5_server_rec_infer.onnx` | 84,176,681 | `c8cff87fd83a76b97178250653924598593088c6bb71b2d2d942ef13b9a2d2ec` |
| `ppocrv5_dict.txt` | 74,014 | `9dfc80c50b6cb07399a47a7cf25d11db475fb4ad0e1fc96b2eff6467c8166ff3` |

模型基于 PaddleOCR，按 Apache License 2.0 分发，许可文本见本目录 `LICENSE`。模型文件不提交到 Git。
