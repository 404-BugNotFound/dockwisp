export const OCR_MODEL_REVISION = "bf1d5edb0335d3262be7caf13f766ba274b4cadd";
export const OCR_MODEL_BASE =
  `https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/${OCR_MODEL_REVISION}`;

export const OCR_MODEL_FILES = [
  {
    name: "PP-OCRv5_mobile_det_infer.onnx",
    source: "detection/PP-OCRv5_mobile_det_infer.onnx",
    bytes: 4_748_769,
    sha256: "d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924",
  },
  {
    name: "PP-OCRv6_small_rec.ort",
    source: "recognition/ort/PP-OCRv6_small_rec.ort",
    bytes: 21_290_816,
    sha256: "40bccd9fa3ae2d14d724bf9d020c8f0edfc801489477b92f7449162a538366df",
  },
  {
    name: "ppocrv6_dict.txt",
    source: "recognition/ppocrv6_dict.txt",
    bytes: 74_948,
    sha256: "41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8",
  },
];
