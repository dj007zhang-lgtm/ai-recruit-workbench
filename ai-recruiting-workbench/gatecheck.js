import { structureResume } from './deepscore.js'
/* 硬门槛 AI 分析：让模型读简历原文，对每条硬门槛给出「是否满足 + 人话依据 + 置信」。
   这不是关键词匹配——模型要理解简历里的事实（学历/专业/年限/技术栈/资质），
   判断候选人是否真的满足门槛，并说明"看到了什么 → 所以判定什么"。
   证据不足时明确标 pending 请人核实，绝不编造。 */

export function buildGatePrompt(position, resume) {
  const gates = (position && position.gates) || []
  const sc = position && position.scorecard
  const hardGates = (sc && Array.isArray(sc.hardGates) && sc.hardGates.length)
    ? sc.hardGates.map(g => (typeof g === 'string' ? g : g.item)).filter(Boolean)
    : gates
  const list = (hardGates.length ? hardGates : ['（无明确硬门槛）']).map((g, i) => (i + 1) + '. ' + g).join('\n')
  return [
    '# Role',
    '你是资深招聘官，正在核对候选人是否满足岗位的「硬性门槛」。你要读简历原文，做出真实判断，而不是找关键词。',
    '',
    '# 岗位',
    '名称：' + ((position && position.title) || '未命名'),
    '硬门槛（逐条核对）：',
    list,
    '',
    '# 判断原则（重要）',
    '- 读懂简历的实际含义：例如「2018-2022 就读于XX大学软件工程」= 全日制本科计算机相关专业；「专升本/自考/函授/成人教育」≠ 统招全日制。',
    '- 不要因为"没写某些字"就判不通过；要看简历里的事实能否推出结论。',
    '- 证据确实不足以判断时，标 pending，并说明缺什么信息，不要猜。',
    '- verdict：pass=明确满足 / fail=明确不满足 / pending=信息不足需核实。',
    '',
    '# 候选人简历原文',
    structureResume(resume, 8000),
    '',
    '# 输出（严格 JSON，对每条门槛都要有，顺序与上面一致）',
    '{',
    '  "gates": [',
    '    { "gate": "门槛原文", "verdict": "pass|fail|pending", "reason": "人话说明：从简历看到什么（引用事实），所以是否满足", "evidence": "引用的简历原文片段（无则空字符串）" }',
    '  ],',
    '  "summary": "一句话总评：候选人整体是否过门槛、关键短板/亮点"',
    '}',
    '只输出 JSON，不要额外文字。',
  ].join('\n')
}

/** 解析模型返回的门槛分析 */
export function parseGateResult(text) {
  const t = String(text || '')
  const m = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/\{[\s\S]*\}/)
  let raw = m ? (m[1] || m[0]) : t
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}')
  if (i >= 0 && j > i) raw = raw.slice(i, j + 1)
  try {
    const o = JSON.parse(raw)
    if (!o || !Array.isArray(o.gates)) return null
    // 规范化 verdict
    for (const g of o.gates) {
      const v = String(g.verdict || '').toLowerCase()
      g.verdict = (v === 'pass' || v === 'fail' || v === 'pending') ? v : 'pending'
      g.reason = String(g.reason || '').slice(0, 300)
      g.evidence = String(g.evidence || '').slice(0, 300)
    }
    return o
  } catch (e) { return null }
}
