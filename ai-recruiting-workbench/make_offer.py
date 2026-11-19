#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成正式 Offer 函（.docx）。用法: make_offer.py <out.docx> '<json>'
json: { name, position, salary, startDate, reportTo, company, note, date }
"""
import json
import sys
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: make_offer.py <out.docx> <json>"}))
        return
    out, raw = sys.argv[1], sys.argv[2]
    try:
        d = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "bad json: %s" % e}))
        return
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Songti SC"
    style.font.size = Pt(11)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("录 用 通 知 书")
    run.bold = True
    run.font.size = Pt(20)

    doc.add_paragraph()
    p = doc.add_paragraph()
    p.add_run("%s 先生/女士：" % (d.get("name") or "")).bold = True

    doc.add_paragraph()
    doc.add_paragraph(
        "您好！经过面试评估与综合考量，我们很高兴邀请您加入「%s」，担任「%s」一职。"
        % (d.get("company") or "本公司", d.get("position") or "")
    )

    doc.add_paragraph()
    doc.add_paragraph("具体录用信息如下：").bold = True
    rows = [
        ("岗位名称", d.get("position") or ""),
        ("薪酬标准", d.get("salary") or ""),
        ("入职日期", d.get("startDate") or ""),
        ("汇报对象", d.get("reportTo") or ""),
    ]
    for k, v in rows:
        if v:
            doc.add_paragraph("  · %s：%s" % (k, v), style="List Bullet")

    if d.get("note"):
        doc.add_paragraph()
        doc.add_paragraph("补充说明：%s" % d["note"])

    doc.add_paragraph()
    doc.add_paragraph("本通知自发出之日起 5 个工作日内有效，请您书面确认是否接受。")
    doc.add_paragraph("如接受，请于入职当日携带身份证、学历证明、离职证明及近期免冠照片办理报到手续。")

    doc.add_paragraph()
    doc.add_paragraph("期待与您共事！")

    doc.add_paragraph()
    doc.add_paragraph()
    sign = doc.add_paragraph()
    sign.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    sign.add_run("%s\n%s" % (d.get("company") or "本公司", d.get("date") or ""))

    doc.save(out)
    print(json.dumps({"ok": True, "file": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
