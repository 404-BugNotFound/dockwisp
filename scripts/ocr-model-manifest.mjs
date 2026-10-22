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
    name: "PP-OCRv5_mobile_rec_infer.onnx",
    source: "recognition/PP-OCRv5_mobile_rec_infer.onnx",
    bytes: 16_559_278,
    sha256: "d253c3cbee6e507828a5271a30ab0ec8ae7c2a99d0cc8e6f844fe380809d22b3",
  },
  {
    name: "ppocrv5_dict.txt",
    source: "recognition/ppocrv5_dict.txt",
    bytes: 74_014,
    sha256: "9dfc80c50b6cb07399a47a7cf25d11db475fb4ad0e1fc96b2eff6467c8166ff3",
  },
];
