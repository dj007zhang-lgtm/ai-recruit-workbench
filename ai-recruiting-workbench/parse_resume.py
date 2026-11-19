#!/usr/bin/env python3
"""简历原件 → 纯文本 + ATS 可读性评分。输出到 stdout 一行 JSON，不写任何业务数据。

支持：.docx / .doc / .rtf / .html / .htm / .txt / .pdf / .md / .csv / .json
OCR：图片与扫描件 PDF 走 macOS Vision（vendor/ocr/ocr，本地、免费、中文准确率高）。
ATS 可读性：借鉴开源 ATS 的 readability 思路，给排版质检分与问题清单。
"""
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

MAX_CHARS = 20000
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tiff", ".tif", ".bmp", ".heic"}
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".log", ".xml", ".yaml", ".yml"}
TEXTUTIL_EXT = {".doc", ".rtf", ".rtfd", ".html", ".htm", ".webarchive"}


# OCR 噪音：二维码/水印/条形码被识别成的超长无空格字母数字串、Base64、重复行
_NOISE_LINE = re.compile(r"^[A-Za-z0-9+/=_\-]{24,}$")          # 超长连续字母数字（无空格）→ 二维码/编码噪音
_HEX_LIKE = re.compile(r"^[0-9a-fA-F]{16,}$")                   # 纯十六进制串
_PLACEHOLDER = re.compile(r"[\[［【(（]\s*已丢弃\s*[\]］】)）]")  # 脱敏占位统一


def clean(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    # 脱敏占位规范化（保留一个可读标记，不显示裸占位）
    text = _PLACEHOLDER.sub("", text)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    out, blank = [], False
    prev = None
    for ln in lines:
        if not ln:
            if not blank:
                out.append("")
                blank = True
            continue
        compact = re.sub(r"\s", "", ln)
        # 丢弃 OCR 噪音行：超长无空格字母数字串 / 纯十六进制串
        if len(compact) >= 24 and (_NOISE_LINE.match(compact) or _HEX_LIKE.match(compact)):
            continue
        # 合并连续重复行（二维码常被 OCR 成同一串重复多行）
        if ln == prev:
            continue
        out.append(ln)
        prev = ln
        blank = False
    return "\n".join(out).strip()[:MAX_CHARS]


OCR_BIN = os.path.join(HERE, "vendor", "ocr", "ocr")


def ocr_text(path, max_pages=10):
    """调 macOS Vision OCR（图片或扫描 PDF）。失败返回 None。"""
    if not os.path.isfile(OCR_BIN):
        return None
    try:
        r = subprocess.run([OCR_BIN, path, str(max_pages)], capture_output=True, timeout=120)
        if r.returncode != 0:
            return None
        txt = r.stdout.decode("utf-8", "replace").strip()
        return txt or None
    except Exception:
        return None


def readability(text):
    """ATS 可读性：简历排版对机器解析的友好度（0-100）+ 问题清单。"""
    issues = []
    score = 100
    t = text or ""
    compact = re.sub(r"\s", "", t)
    n = len(compact)
    if n < 200:
        score -= 25
        issues.append("文本过少（%d 字），解析器能读到的信息有限" % n)
    elif n < 400:
        score -= 10
        issues.append("文本偏少（%d 字）" % n)
    # 分节标题
    secs = ["教育", "工作经历", "工作经验", "项目", "技能", "自我评价", "求职意向", "实习"]
    hits = [x for x in secs if x in t]
    if len(hits) < 2:
        score -= 15
        issues.append("缺少可识别的分节标题（教育/工作/项目/技能），ATS 难以结构化")
    # 日期格式
    if not re.search(r"(19|20)\d{2}\s*[./年-]\s*\d{1,2}", t):
        score -= 15
        issues.append("工作/教育经历缺少规范日期（如 2021.07-2023.05）")
    # 超长行（无换行/被压成一行）
    long_lines = [ln for ln in t.split("\n") if len(ln) > 220]
    if long_lines:
        score -= 10
        issues.append("存在 %d 行超长文本（>220 字），可能是表格/多栏排版导致阅读顺序错乱" % len(long_lines))
    # 联系方式
    has_phone = bool(re.search(r"1[3-9]\d{9}", re.sub(r"[\s-]", "", t)))
    has_mail = bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", t))
    if not (has_phone or has_mail):
        score -= 10
        issues.append("未识别到手机号/邮箱，需人工核对")
    # 表格行
    pipe_rows = [ln for ln in t.split("\n") if ln.count("|") >= 3]
    if len(pipe_rows) > 10:
        score -= 5
        issues.append("表格行较多（%d 行），部分 ATS 会读乱" % len(pipe_rows))
    # 乱码
    bad = len(re.findall(r"[\ufffd\u25a1]", t))
    if n and bad / max(n, 1) > 0.02:
        score -= 10
        issues.append("存在乱码字符（%d 处），可能是字体嵌入问题" % bad)
    score = max(0, min(100, score))
    return {"score": score, "issues": issues, "sections": hits,
            "hasPhone": has_phone, "hasEmail": has_mail, "chars": n}


def parse(path):
    ext = os.path.splitext(path)[1].lower()
    warnings = []

    if ext in IMG_EXT:
        txt = ocr_text(path)
        if txt:
            text = clean(txt)
            return {"ok": True, "text": text, "format": ext, "needsOcr": False, "ocr": True,
                    "readability": readability(text), "warnings": ["图片经 Vision OCR 文本化（自动识别，供核对）"]}
        return {
            "ok": True, "text": "", "format": ext, "needsOcr": True,
            "warnings": ["图片 OCR 失败（Vision 不可用）；原件已留档，需人工补录文本"],
        }

    if ext == ".docx":
        import docx
        doc = docx.Document(path)
        parts = [p.text for p in doc.paragraphs]
        for tb in doc.tables:
            for row in tb.rows:
                parts.append(" | ".join(c.text for c in row.cells))
        text = clean("\n".join(parts))
        if len(text) < 30:
            warnings.append("docx 可提取文本过少，可能是扫描件或图片版")
        return {"ok": True, "text": text, "format": ext, "needsOcr": False,
                "readability": readability(text), "warnings": warnings}

    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        pages = []
        for i, page in enumerate(reader.pages):
            try:
                pages.append(page.extract_text() or "")
            except Exception as e:
                warnings.append("第 %d 页提取失败：%s" % (i + 1, e))
        text = clean("\n".join(pages))
        if len(text) < 30:
            warnings.append("PDF 无文本层，转为 Vision OCR 识别")
            txt = ocr_text(path)
            if txt:
                text = clean(txt)
                return {"ok": True, "text": text, "format": ext, "needsOcr": False, "ocr": True,
                        "readability": readability(text), "warnings": warnings + ["扫描件经 Vision OCR 文本化（自动识别，供核对）"]}
            return {"ok": True, "text": "", "format": ext, "needsOcr": True, "warnings": warnings}
        return {"ok": True, "text": text, "format": ext, "needsOcr": False,
                "readability": readability(text), "warnings": warnings}

    if ext in TEXTUTIL_EXT:
        try:
            r = subprocess.run(
                ["textutil", "-convert", "txt", "-stdout", path],
                capture_output=True, timeout=30,
            )
            if r.returncode != 0:
                raise RuntimeError(r.stderr.decode("utf-8", "replace")[:200])
            text = clean(r.stdout.decode("utf-8", "replace"))
            return {"ok": True, "text": text, "format": ext, "needsOcr": False,
                    "readability": readability(text), "warnings": warnings}
        except Exception as e:
            warnings.append("textutil 转换失败：%s" % e)
            return {"ok": False, "error": str(e), "format": ext, "warnings": warnings}

    # 纯文本类及其他：按 utf-8 读，失败再试常见中文编码
    raw = open(path, "rb").read()
    text = None
    for enc in ("utf-8", "gb18030", "big5", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        return {"ok": False, "error": "无法解码文件", "format": ext, "warnings": warnings}
    text = clean(text)
    return {"ok": True, "text": text, "format": ext, "needsOcr": False,
            "readability": readability(text), "warnings": warnings}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: parse_resume.py <file>"}, ensure_ascii=False))
        return
    path = sys.argv[1]
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "file not found: " + path}, ensure_ascii=False))
        return
    try:
        print(json.dumps(parse(path), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
