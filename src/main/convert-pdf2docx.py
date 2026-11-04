"""Dockwisp PDF helper, run by the embedded Python of the PDF component.

  analyze <pdf> <workdir>            -> JSON on stdout: page count plus the
                                         scanned pages rendered to PNG for OCR
  convert <pdf> <docx> [ocr.json]    -> writes the docx; scanned pages are
                                         rebuilt from the OCR lines first
  render <pdf> <dir> <png|jpg>       -> one image per page at 150 DPI

Progress lines go to stdout as "PROGRESS <done> <total>".
"""

import json
import logging
import os
import sys

import pymupdf

# A page counts as scanned when it has almost no text layer but images cover
# most of it.
MIN_TEXT_CHARS = 20
MIN_IMAGE_COVERAGE = 0.5
OCR_MAX_SIDE = 1920


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(done, total):
    sys.stdout.write(f"PROGRESS {done} {total}\n")
    sys.stdout.flush()


def open_pdf(path):
    doc = pymupdf.open(path)
    if doc.needs_pass:
        raise SystemExit("PDF 已加密，请先移除密码后再转换")
    return doc


def image_coverage(page):
    area = abs(page.rect)
    if area <= 0:
        return 0.0
    covered = 0.0
    for info in page.get_image_info():
        bbox = pymupdf.Rect(info["bbox"]) & page.rect
        covered += abs(bbox)
    return min(1.0, covered / area)


def is_scanned(page):
    text = page.get_text("text").strip()
    if len(text) >= MIN_TEXT_CHARS:
        return False
    return image_coverage(page) >= MIN_IMAGE_COVERAGE


def analyze(pdf_path, workdir):
    doc = open_pdf(pdf_path)
    scanned = []
    for index, page in enumerate(doc):
        if not is_scanned(page):
            continue
        rect = page.rect
        zoom = OCR_MAX_SIDE / max(rect.width, rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        image = os.path.join(workdir, f"page-{index + 1}.png")
        pix.save(image)
        scanned.append({
            "index": index,
            "image": image,
            "imageWidth": pix.width,
            "imageHeight": pix.height,
        })
    emit({"pages": doc.page_count, "scanned": scanned})


def rebuild_scanned_pages(pdf_path, ocr, out_path):
    """Replace each scanned page with real text placed at the OCR line boxes."""
    src = open_pdf(pdf_path)
    by_index = {item["index"]: item for item in ocr}
    out = pymupdf.open()
    font = pymupdf.Font("china-s")
    for index, page in enumerate(src):
        item = by_index.get(index)
        if not item or not item.get("lines"):
            out.insert_pdf(src, from_page=index, to_page=index)
            continue
        rect = page.rect
        target = out.new_page(width=rect.width, height=rect.height)
        target.insert_font(fontname="dwcjk", fontbuffer=font.buffer)
        sx = rect.width / max(1, item["imageWidth"])
        sy = rect.height / max(1, item["imageHeight"])
        for line in item["lines"]:
            text = (line.get("text") or "").strip()
            box = line.get("box") or {}
            if not text:
                continue
            x = box.get("x", 0) * sx
            y = box.get("y", 0) * sy
            width = max(1.0, box.get("width", 0) * sx)
            height = max(1.0, box.get("height", 0) * sy)
            size = max(4.0, height * 0.8)
            # Shrink the size until the line fits its box width.
            natural = font.text_length(text, fontsize=size)
            if natural > width:
                size = max(4.0, size * width / natural)
            target.insert_text(
                (x, y + height * 0.8),
                text,
                fontname="dwcjk",
                fontsize=size,
            )
    out.save(out_path, garbage=3, deflate=True)
    return out_path


class ProgressHandler(logging.Handler):
    """Turn pdf2docx's "(i/n) Page i" log lines into PROGRESS output.

    Parsing and creating each walk all pages once, so the total is 2 * n.
    """

    def __init__(self):
        super().__init__()
        self.phase = 0
        self.done = 0

    def emit(self, record):
        message = record.getMessage()
        if "[3/4]" in message:
            self.phase = 1
        elif "[4/4]" in message:
            self.phase = 2
        elif message.startswith("(") and "/" in message and ")" in message:
            try:
                current, total = message[1:message.index(")")].split("/")
                current, total = int(current), int(total)
            except ValueError:
                return
            offset = total if self.phase == 2 else 0
            progress(offset + current, total * 2)


def convert(pdf_path, docx_path, ocr_path=None):
    from pdf2docx import Converter

    source = pdf_path
    if ocr_path:
        with open(ocr_path, "r", encoding="utf-8") as handle:
            ocr = json.load(handle)
        if ocr:
            rebuilt = os.path.join(os.path.dirname(ocr_path), "ocr-rebuilt.pdf")
            source = rebuild_scanned_pages(pdf_path, ocr, rebuilt)

    root = logging.getLogger()
    root.handlers = [ProgressHandler()]
    root.setLevel(logging.INFO)

    converter = Converter(source)
    try:
        converter.convert(docx_path)
    finally:
        converter.close()
    emit({"ok": True})


def render(pdf_path, out_dir, fmt, dpi=150):
    """Write every page as page-001.<fmt> into out_dir."""
    doc = open_pdf(pdf_path)
    total = doc.page_count
    digits = max(3, len(str(total)))
    zoom = dpi / 72
    for index, page in enumerate(doc):
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        name = os.path.join(out_dir, f"page-{index + 1:0{digits}d}.{fmt}")
        if fmt == "jpg":
            pix.save(name, output="jpeg", jpg_quality=90)
        else:
            pix.save(name)
        progress(index + 1, total)
    emit({"ok": True, "pages": total})


def main(argv):
    if len(argv) < 3:
        raise SystemExit(
            "usage: analyze <pdf> <workdir> | convert <pdf> <docx> [ocr.json] | render <pdf> <dir> <png|jpg>"
        )
    command = argv[0]
    if command == "analyze":
        analyze(argv[1], argv[2])
    elif command == "convert":
        convert(argv[1], argv[2], argv[3] if len(argv) > 3 else None)
    elif command == "render":
        render(argv[1], argv[2], argv[3] if len(argv) > 3 and argv[3] in ("png", "jpg") else "png")
    else:
        raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main(sys.argv[1:])
