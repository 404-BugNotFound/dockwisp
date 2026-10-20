import assert from "node:assert/strict";
import test from "node:test";
import { previewKindForExtension } from "../src/main/preview-controller";

test("classifies previewable file extensions", () => {
  assert.equal(previewKindForExtension(".png"), "image");
  assert.equal(previewKindForExtension(".SVG"), "image");
  assert.equal(previewKindForExtension(".txt"), "text");
  assert.equal(previewKindForExtension(".md"), "text");
  assert.equal(previewKindForExtension(".mp3"), "audio");
  assert.equal(previewKindForExtension(".mp4"), "video");
  assert.equal(previewKindForExtension(".pdf"), "pdf");
  assert.equal(previewKindForExtension(".docx"), "unsupported");
  assert.equal(previewKindForExtension(""), "unsupported");
});
