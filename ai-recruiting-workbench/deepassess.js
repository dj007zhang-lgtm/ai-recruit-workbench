/* 深度适配性评估：LLM 按资深 HRBP 范式，穿透简历包装，做「业务场景对齐 + 证据链强制 + 双向证伪」。
   四层方法论：① 隐性上下文灌注 ② 评估逻辑重构（看证据链不看标签）③ 双向证伪（正向举证+反向排雷）④ 证据链强制。
   产出结构化诊断：评级 S/A/B/C + 结论 + 场景对齐 + 优势证据链 + Red Flags + 面试题。
   本模块只构造 prompt 与解析；LLM 调用在 index.js 端点（Host 侧有 ctx.llm）。 */

/** 构造深度评估 Prompt（按用户给的实操模板固化） */
export function buildDeepAssessPrompt(position, resume) {
  const ctx = position.context || {}
  const jd = position.jd || (position.jdObj ? (position.jdObj.raw || JSON.stringify(position.jdObj)) : '')
  const sc = position.scorecard
  const scText = sc && Array.isArray(sc.softDims)
    ? sc.softDims.map(d => d.name + '(' + d.weight + '%)').join('、')
    : (position.abilities || []).join('、')
  const gates = (position.gates || []).join('、')
  return [
    '# Role',
    '你是一位兼具业务经营视角与组织诊断能力的资深 HRBP。你的任务不是做简单的关键词匹配，而是穿透简历包装，评估候选人与当前业务场景的【真实适配度】。',
    '',
    '# Context（隐性业务上下文）',
    '1. 岗位名称：' + (position.title || ''),
    '2. 团队当前所处阶段与核心痛点：' + (ctx.stage || '（未特别说明，按常规业务阶段判断）'),
    '3. 团队汇报线与风格：' + (ctx.reportLine || '（未特别说明）'),
    '4. 团队短板与互补性需求：' + (ctx.teamGap || '（未特别说明）'),
    '5. 组织文化与工作节奏：' + (ctx.culture || '（未特别说明）'),
    '6. 绝对排雷项（Deal Breakers）：' + (ctx.dealBreakers || '（无，但请主动识别逻辑矛盾/权限错配/连续性断层）'),
    '',
    '# Input',
    '- 【标准 JD】：',
    (jd || '（无结构化 JD，请依据岗位名称与能力要求判断）'),
    '- 岗位核心评估维度（来自评分卡，用于对齐）：' + (scText || '（无）'),
    '- 硬性门槛：' + (gates || '（无）'),
    '',
    '- 【候选人简历】：',
    String(resume || '').replace(/［已丢弃］/g, '').replace(/\s{2,}/g, ' ').slice(0, 8000),
    '',
    '# Evaluation Rules（评估铁律）',
    '1. 证据原则：所有判断必须引用简历原文作为证据；简历未提及的一律视为"未知/存疑"，严禁替候选人脑补。',
    '2. 去水分：自动忽略"赋能、抓手、全面负责、精通、主导、显著提升"等空洞词，重点提取【具体动作 + 资源投入 + 量化结果】。',
    '3. 区分"平台光环"与"个人战功"：评估业绩有多少来自原公司品牌/流量红利，多少源于其个人机制设计或破局能力。',
    '4. 任务相似性：不看他 Title，看他过去解决的核心矛盾与我方当前业务痛点的重合度（注意业务形态差异，如高客单品牌自播 vs 低价白牌达人分销能力模型不同）。',
    '5. 能力迁移半径：无完全对口行业经验时，评估底层能力（如数据分析、渠道搭建、供应链协同）跨赛道迁移可行性，避免误杀高潜。',
    '6. 双向证伪：既找亮点（正向举证），更找反例（反向排雷：指标矛盾/权限错配/连续性断层/文化排异）。',
    '7. 硬门槛（学历/统招/专业/年限）由系统规则单独判定，你不要自行判定硬门槛是否通过；也不要推测院校性质（如"民办/公办"）、不得虚构简历未写的信息。学历/统招等只照简历原文陈述，不做好坏推断。',
    '',
    '# 评分锚（ribric，必须严格按此打分，不要凭感觉给评级）',
    '- 先算适配度总分 score（0-100），评分方法：以岗位核心评估维度为准，各维度按证据给分（0-100），再按权重加权。证据强、有量化成果、场景高度契合→高分；证据弱、只描述职责无成果、场景不符→低分。',
    '- 红牌（Red Flags）每条扣分：指标矛盾/权限错配/连续性断层/证据存疑/文化排异，每命中一条从 score 再扣 3-5 分。',
    '- 严禁凭整体印象给分，必须能指出每个分对应哪条证据。',
    '',
    '# Output Format（严格按以下 JSON 输出，不要额外文字；不需要你给 grade，系统会按分数推导）',
    '{',
    '  "conclusion": "一句话核心结论",',
    '  "score": 0-100 的适配度总分（必填，按评分锚计算）,',
    '  "alignment": [{ "dim": "维度名", "requirement": "岗位该维度要求", "candidate": "候选人对应情况(引原文)", "score": 0-100, "verdict": "匹配|部分|缺失" }],',
    '  "strengths": [{ "point": "优势点", "evidence": "简历原文依据" }],  // 2-3条，直击我方痛点',
    '  "redFlags": [{ "type": "指标矛盾|权限错配|连续性断层|文化排异|证据存疑", "detail": "具体疑点" }],',
    '  "interviewQuestions": ["刺穿包装的压力/行为面试题1", "题2", "题3"],',
    '  "stageFit": "候选人过往业务形态与我方当前阶段的对齐度分析"',
    '}',
  ].join('\n')
}

/** 从 LLM 返回文本中稳健提取 JSON */
export function parseDeepAssess(text) {
  const t = String(text || '')
  // 优先 ```json ... ``` 代码块
  let m = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/```\s*([\s\S]*?)```/)
  let raw = m ? m[1] : t
  // 截取第一个 { 到最后一个 }
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}')
  if (i >= 0 && j > i) raw = raw.slice(i, j + 1)
  try {
    const o = JSON.parse(raw)
    return normalizeDeepAssess(o)
  } catch (e) {
    return null
  }
}

export function normalizeDeepAssess(o) {
  if (!o || typeof o !== 'object') return null
  const scoreVal = typeof o.score === 'number' ? Math.max(0, Math.min(100, Math.round(o.score))) : null
  // 评级由分数按 rubric 推导，不采信 LLM 自评 grade
  const grade = gradeFromScore(scoreVal == null ? 0 : scoreVal)
  return {
    grade,
    conclusion: String(o.conclusion || ''),
    score: typeof o.score === 'number' ? Math.max(0, Math.min(100, Math.round(o.score))) : null,
    alignment: Array.isArray(o.alignment) ? o.alignment.map(a => ({
      dim: String(a.dim || ''), requirement: String(a.requirement || ''), candidate: String(a.candidate || ''),
      score: typeof a.score === 'number' ? a.score : null, verdict: String(a.verdict || ''),
    })) : [],
    strengths: Array.isArray(o.strengths) ? o.strengths.map(s => ({ point: String(s.point || ''), evidence: String(s.evidence || '') })) : [],
    redFlags: Array.isArray(o.redFlags) ? o.redFlags.map(f => ({ type: String(f.type || '证据存疑'), detail: String(f.detail || '') })) : [],
    interviewQuestions: Array.isArray(o.interviewQuestions) ? o.interviewQuestions.map(x => String(x)) : [],
    stageFit: String(o.stageFit || ''),
    engine: 'llm-hrbp',
  }
}

// 评级统一由「总分」按固定 rubric 推导（不让 LLM 自由给 grade，消除评级飘）
export function gradeFromScore(score) {
  const s = typeof score === 'number' ? score : 0
  if (s >= 85) return 'S'
  if (s >= 75) return 'A'
  if (s >= 60) return 'B'
  return 'C'
}

// 评级 → 建议下一步（供流程推进）
export function gradeToAction(grade) {
  if (grade === 'S') return { route: 'S 级 · 高度契合，推荐进初试', conclusion: 'recommend' }
  if (grade === 'A') return { route: 'A 级 · 基本胜任，建议进初试', conclusion: 'recommend' }
  if (grade === 'B') return { route: 'B 级 · 勉强匹配，建议面试中重点排雷', conclusion: 'interview' }
  return { route: 'C 级 · 不建议推进', conclusion: 'reject' }
}
