#!/usr/bin/env python3
"""招聘交付物生成：Offer 函 / 面试评估表 / 候选人评估报告。

用途：把工作台里的结构化结论变成 HR 可发、可归档的正式文档。
调用方式：由 index.js 通过 spawn 调用，传 JSON（stdin）→ 生成 docx 到指定路径。

设计原则：
- 不臆造数据：文档里每个字段都来自事件账本，缺失就留空/标注"待填"，绝不编造。
- 中文字体显式设置 eastAsia，否则 Word 里可能显示为默认西文字体。
"""
import io
import json
import sys
from datetime import datetime

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor


def set_cn_font(run, name='微软雅黑', size=None, bold=None, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)


def add_heading(doc, text, size=16, color=(31, 41, 55)):
    p = doc.add_paragraph()
    r = p.add_run(text)
    set_cn_font(r, size=size, bold=True, color=color)
    p.paragraph_format.space_after = Pt(8)
    return p


def add_kv(doc, key, val, size=11):
    p = doc.add_paragraph()
    r1 = p.add_run(key + '：')
    set_cn_font(r1, size=size, bold=True, color=(75, 85, 99))
    r2 = p.add_run(str(val) if val not in (None, '') else '—')
    set_cn_font(r2, size=size, color=(17, 24, 39))
    p.paragraph_format.space_after = Pt(2)
    return p


def add_para(doc, text, size=11, color=(17, 24, 39), indent=0):
    p = doc.add_paragraph()
    r = p.add_run(text)
    set_cn_font(r, size=size, color=color)
    if indent:
        p.paragraph_format.left_indent = Pt(indent)
    p.paragraph_format.space_after = Pt(3)
    return p


def gen_offer(doc, d):
    """Offer 函：正式录用通知。所有条款来自账本，缺失项标注待确认。"""
    add_heading(doc, '录用通知书', size=20)
    add_para(doc, 'OFFER OF EMPLOYMENT', size=9, color=(107, 114, 128))
    doc.add_paragraph()

    add_para(doc, '尊敬的 ' + (d.get('name') or '____') + ' 先生/女士：', size=12)
    doc.add_paragraph()
    add_para(doc, '感谢您对 ' + (d.get('company') or '我司') + ' 的关注与信任。经综合评估，我们很高兴邀请您加入，具体录用条件如下：', size=11)
    doc.add_paragraph()

    add_heading(doc, '一、录用信息', size=13, color=(37, 99, 235))
    add_kv(doc, '录用岗位', d.get('position'))
    add_kv(doc, '所属部门', d.get('dept'))
    add_kv(doc, '工作地点', d.get('city'))
    add_kv(doc, '汇报对象', d.get('reportTo'))
    add_kv(doc, '入职日期', d.get('startDate'))
    doc.add_paragraph()

    add_heading(doc, '二、薪酬待遇', size=13, color=(37, 99, 235))
    add_kv(doc, '月度薪资', d.get('salary'))
    add_kv(doc, '薪资结构', d.get('salaryStructure'))
    add_kv(doc, '试用期', d.get('probation'))
    add_kv(doc, '社会保险与公积金', d.get('insurance') or '按国家及当地规定缴纳')
    doc.add_paragraph()

    add_heading(doc, '三、其他约定', size=13, color=(37, 99, 235))
    add_kv(doc, '工作时间', d.get('workTime') or '标准工时制')
    add_kv(doc, '年假', d.get('annualLeave') or '按国家规定及公司制度执行')
    add_kv(doc, '保密与竞业', d.get('confidential') or '按入职时签署的保密协议执行')
    doc.add_paragraph()

    add_para(doc, '本录用通知自您签署确认之日起生效。请您于 ' + (d.get('replyBy') or '____') + ' 前回复确认。如逾期未回复，本通知自动失效。', size=11)
    doc.add_paragraph()
    add_para(doc, '期待与您共事。', size=11)
    doc.add_paragraph()
    doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = p.add_run((d.get('company') or '') + '\n人力资源部\n' + (d.get('issueDate') or datetime.now().strftime('%Y年%m月%d日')))
    set_cn_font(r, size=11)
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT


def gen_eval(doc, d):
    """面试评估表：供面试官现场填写/归档。BARS 档位 + STAR 取证。"""
    add_heading(doc, '面试评估表', size=20)
    add_para(doc, 'INTERVIEW EVALUATION FORM', size=9, color=(107, 114, 128))
    doc.add_paragraph()

    add_heading(doc, '一、基本信息', size=13, color=(37, 99, 235))
    add_kv(doc, '候选人', d.get('name'))
    add_kv(doc, '应聘岗位', d.get('position'))
    add_kv(doc, '面试轮次', d.get('round'))
    add_kv(doc, '面试时间', d.get('at'))
    add_kv(doc, '面试官', d.get('interviewer'))
    doc.add_paragraph()

    # AI 初筛结论（供面试官参考，非结论）
    ai = d.get('ai') or {}
    if ai:
        add_heading(doc, '二、AI 初筛参考（仅供面试官参考，不作为录用依据）', size=13, color=(107, 114, 128))
        add_kv(doc, 'AI 档位', ai.get('grade'))
        add_kv(doc, 'AI 评分', ai.get('score'))
        add_kv(doc, 'AI 结论', ai.get('route'))
        doc.add_paragraph()

    # 逐维评估表（BARS 档位 + 现场判定）
    add_heading(doc, '三、逐维评估（BARS 行为锚定）', size=13, color=(37, 99, 235))
    dims = d.get('dims') or []
    if dims:
        tbl = doc.add_table(rows=1, cols=4)
        tbl.style = 'Table Grid'
        hdr = tbl.rows[0].cells
        for i, h in enumerate(['评估维度', '行为锚点（判定标准）', 'AI 判档', '面试官判定']):
            hdr[i].text = ''
            r = hdr[i].paragraphs[0].add_run(h)
            set_cn_font(r, size=10, bold=True)
        for dm in dims:
            row = tbl.add_row().cells
            row[0].text = ''
            r = row[0].paragraphs[0].add_run(str(dm.get('name') or ''))
            set_cn_font(r, size=9.5, bold=True)
            row[1].text = ''
            r = row[1].paragraphs[0].add_run(str(dm.get('anchor') or ''))
            set_cn_font(r, size=9)
            row[2].text = ''
            r = row[2].paragraphs[0].add_run(str(dm.get('aiLevel') or '—'))
            set_cn_font(r, size=9.5)
            row[3].text = ''
            r = row[3].paragraphs[0].add_run('☐ L0  ☐ L1  ☐ L2  ☐ L3')
            set_cn_font(r, size=9)
    doc.add_paragraph()

    # STAR 取证记录（面试官填写）
    star = d.get('starTasks') or []
    if star:
        add_heading(doc, '四、STAR 取证记录（候选人可包装，具体行动难编造）', size=13, color=(37, 99, 235))
        for t in star:
            p = doc.add_paragraph()
            r = p.add_run('▸ ' + str(t.get('dim') or '') + '（AI 判 ' + str(t.get('aiLevel') or '缺') + '）')
            set_cn_font(r, size=10.5, bold=True)
            if t.get('evidence'):
                add_para(doc, '简历原文：' + str(t.get('evidence')), size=9, color=(107, 114, 128), indent=12)
            s = t.get('star') or {}
            for k, lb in [('S', '情境'), ('T', '任务'), ('A', '行动'), ('R', '结果')]:
                if s.get(k):
                    add_para(doc, k + ' ' + lb + '：' + str(s.get(k)), size=9.5, indent=12)
            add_para(doc, '候选人回答：________________________________________________', size=9.5, color=(107, 114, 128), indent=12)
            doc.add_paragraph()

    add_heading(doc, '五、面试结论', size=13, color=(37, 99, 235))
    add_para(doc, '综合评价：______________________________________________________________', size=11)
    doc.add_paragraph()
    add_para(doc, '☐ 推荐通过    ☐ 待定    ☐ 不通过', size=11)
    doc.add_paragraph()
    add_para(doc, '亮点：______________________________________________________________', size=10)
    add_para(doc, '顾虑：______________________________________________________________', size=10)
    doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = p.add_run('面试官签字：____________    日期：____________')
    set_cn_font(r, size=10)


def gen_report(doc, d):
    """候选人评估报告：给用人经理看的完整画像。"""
    add_heading(doc, '候选人评估报告', size=20)
    add_para(doc, 'CANDIDATE ASSESSMENT REPORT', size=9, color=(107, 114, 128))
    add_para(doc, '生成时间：' + datetime.now().strftime('%Y-%m-%d %H:%M'), size=9, color=(107, 114, 128))
    doc.add_paragraph()

    add_heading(doc, '一、基本信息', size=13, color=(37, 99, 235))
    add_kv(doc, '姓名', d.get('name'))
    add_kv(doc, '应聘岗位', d.get('position'))
    add_kv(doc, '来源渠道', d.get('source'))
    add_kv(doc, '当前阶段', d.get('stage'))
    add_kv(doc, '接入时间', d.get('receivedAt'))
    doc.add_paragraph()

    ai = d.get('ai') or {}
    if ai:
        add_heading(doc, '二、AI 初筛结论', size=13, color=(37, 99, 235))
        add_kv(doc, '档位', ai.get('grade'))
        add_kv(doc, '加权得分', ai.get('score'))
        add_kv(doc, '置信度', ai.get('conf'))
        add_kv(doc, '结论', ai.get('route'))
        if ai.get('conclusion'):
            add_para(doc, '判定说明：' + str(ai.get('conclusion')), size=10, color=(75, 85, 99))
        doc.add_paragraph()

    # 逐维判档 + 证据（核心价值：每个结论可追到原文）
    al = d.get('alignment') or []
    if al:
        add_heading(doc, '三、逐维判档与证据', size=13, color=(37, 99, 235))
        tbl = doc.add_table(rows=1, cols=4)
        tbl.style = 'Table Grid'
        hdr = tbl.rows[0].cells
        for i, h in enumerate(['维度', '档位', '锚点要求', '简历证据']):
            hdr[i].text = ''
            r = hdr[i].paragraphs[0].add_run(h)
            set_cn_font(r, size=10, bold=True)
        for a in al:
            row = tbl.add_row().cells
            row[0].text = ''
            r = row[0].paragraphs[0].add_run(str(a.get('dim') or ''))
            set_cn_font(r, size=9.5, bold=True)
            row[1].text = ''
            r = row[1].paragraphs[0].add_run(str(a.get('level') or '—'))
            set_cn_font(r, size=9.5, bold=True, color=(37, 99, 235))
            row[2].text = ''
            r = row[2].paragraphs[0].add_run(str(a.get('requirement') or ''))
            set_cn_font(r, size=8.5, color=(107, 114, 128))
            row[3].text = ''
            r = row[3].paragraphs[0].add_run(str(a.get('candidate') or '无'))
            set_cn_font(r, size=8.5)
        doc.add_paragraph()

    gates = d.get('gates') or []
    if gates:
        add_heading(doc, '四、硬门槛判定', size=13, color=(37, 99, 235))
        for g in gates:
            v = str(g.get('verdict') or '')
            mark = '✓' if v == 'pass' else ('✗' if v == 'fail' else '?')
            add_para(doc, mark + ' ' + str(g.get('gate') or '') + '：' + str(g.get('reason') or ''), size=9.5)
        doc.add_paragraph()

    doubts = d.get('doubts') or []
    if doubts:
        add_heading(doc, '五、面试需核实', size=13, color=(37, 99, 235))
        for x in doubts:
            add_para(doc, '· ' + str(x), size=9.5)
        doc.add_paragraph()

    add_heading(doc, '六、可追溯性声明', size=11, color=(107, 114, 128))
    add_para(doc, '本报告所有结论均由事件账本派生，每个判定可追溯至原始简历文本与评分卡版本。AI 结论仅为建议，最终录用决策由人做出。', size=9, color=(107, 114, 128))


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'invalid json: ' + str(e)}))
        return
    kind = req.get('kind') or 'report'
    out = req.get('out')
    data = req.get('data') or {}
    if not out:
        print(json.dumps({'ok': False, 'error': 'out path required'}))
        return
    try:
        doc = Document()
        # 页面边距
        for sec in doc.sections:
            sec.left_margin = Pt(72)
            sec.right_margin = Pt(72)
            sec.top_margin = Pt(64)
            sec.bottom_margin = Pt(64)
        if kind == 'offer':
            gen_offer(doc, data)
        elif kind == 'eval':
            gen_eval(doc, data)
        else:
            gen_report(doc, data)
        doc.save(out)
        # 回读校验：确认文件可打开且非空
        d2 = Document(out)
        n = len(d2.paragraphs)
        print(json.dumps({'ok': True, 'path': out, 'paragraphs': n}, ensure_ascii=False))
    except Exception as e:
        import traceback
        print(json.dumps({'ok': False, 'error': str(e), 'trace': traceback.format_exc()[-600:]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
