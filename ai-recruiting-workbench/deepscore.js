/* BARS 判定式初筛：LLM 只做「逐维证据提取 + 档位判定(L0-L3)」，分数与评级全部由代码算。
   这从根上消除评级飘：① 不给 LLM 打分权 ② 判定是离散档位而非连续分 ③ 强制先取证后定级。
   配合温度=0 + 多次采样取档位众数。 */

import { gradeFromScore } from './deepassess.js'
import { stackFit } from './skills.js'

/** 由评分卡构造 BARS 判定 Prompt */
// ===== 简历结构化：把裸文本整理成「分区清晰、保留换行、突出时间线」的文本再喂给 AI =====
// 这是"AI 读得准"的前提：模型需要看到"这是教育经历/这是工作经历/时间-职位-公司"的结构，
// 而不是一坨被压平、被截断的字符流句。
const RESUME_SECS = ['教育经历', '教育背景', '工作经历', '工作经验', '相关技能', '专业技能', '技能清单', '技能', '项目经历', '项目经验', '实习经历', '自我评价', '个人优势', '求职意向', '项目', '证书', '语言能力', '附加信息']
export function structureResume(resume, maxChars) {
  maxChars = maxChars || 9000
  let t = String(resume || '').replace(/［已丢弃］/g, '').replace(/\r/g, '')
  if (!t.trim()) return '（无简历文本）'
  const lines = t.split('\n')
  const secRe = new RegExp('^\\s*(' + RESUME_SECS.join('|') + ')\\s*[:：]?\\s*$')
  const out = []
  let curSec = ''
  const secParts = {}   // 分区名 → 行[]
  const order = []
  const head = []
  for (const raw of lines) {
    const ln = raw.replace(/\u3000/g, ' ').replace(/\s+$/g, '')
    if (secRe.test(ln)) {
      curSec = ln.trim().replace(/[:：]$/, '')
      if (!secParts[curSec]) { secParts[curSec] = []; order.push(curSec) }
      continue
    }
    if (!curSec) head.push(ln)
    else secParts[curSec].push(ln)
  }
  // 头部（姓名/联系方式）：压缩连续空行，但保留信息
  const headClean = head.join('\n').replace(/\n{2,}/g, '\n').trim()
  let body = ''
  if (order.length) {
    body = order.map(sec => {
      const ls = secParts[sec].join('\n').replace(/\n{2,}/g, '\n').trim()
      return ls ? ('【' + sec + '】\n' + ls) : ''
    }).filter(Boolean).join('\n\n')
  } else {
    // 无分区标题（平台导出）：保留换行，压缩多余空行
    body = t.replace(/\n{3,}/g, '\n\n').trim()
  }
  let full = (headClean ? headClean + '\n\n' : '') + body
  // 智能截断：不硬切在半个经历中间；超长时靠前保留（头部+核心经历），并提示截断
  if (full.length > maxChars) {
    full = full.slice(0, maxChars)
    const lastNl = full.lastIndexOf('\n')
    if (lastNl > maxChars * 0.8) full = full.slice(0, lastNl)
    full += '\n…（简历过长，已截断后段；核心经历已包含）'
  }
  return full
}

export function buildBarsPrompt(position, resume) {
  const sc = position.scorecard || { softDims: [] }
  const dims = (sc.softDims || [])
  const ctx = position.context || {}
  const dimBlocks = dims.map((d, i) => {
    const anchors = (d.levels || []).map(l => `    - ${l.level}（${l.score}分）：${l.anchor}`).join('\n')
    return `${i + 1}. ${d.name}（权重 ${d.weight}%）\n${anchors}`
  }).join('\n')
  return [
    '# Role',
    '你是一个严格执行客观标准的「简历特征提取与分级引擎」。你不打分、不评级，只做两件事：① 从简历提取可引用原文证据；② 对照行为锚点(级别)判定该维度的档位。',
    '',
    '# 铁律',
    '1. 严禁推断或脑补：只有简历明确写出的事实才算证据。简历没写的，evidence 填"无"，level 判 L0。',
    '2. 严禁基于公司背景、职位 Title、行业常识做概率推断。',
    '3. 必须"先取证、后定级"：先摘录原文，再对照锚点判档位。',
    '4. 公平性铁律：**不得把跳槽频率、单段在职时长、空窗期作为任何维度的负面依据**（除非该维度锚点明确要求且岗位有法律/合规依据）。这类信号易构成对特定人群的隐性歧视。评价「职业成长」时看能力是否递进、经历与岗位的相关性，不看停留时间长短。',
    '4b. 时间常识（这些是正常现象，不得扣分或列为疑点）：国内本科一般 6-7 月毕业、硕士 3-4 月毕业，海外毕业时间不同；毕业前半年到一年在同公司实习后转正属正常；当月离职、次月入职是正常求职周期，断档 2 个月以内正常（≥2-3 个月且无合理解释才值得关注）；实习转正、同公司实习+正式、项目时间小幅重叠均正常。',
    '5. 只输出 JSON，不输出任何额外文字。',
    '',
    '# 业务上下文（辅助理解痛点，不作为加分依据）',
    '岗位：' + (position.title || '') + '｜阶段/痛点：' + (ctx.stage || '未说明') + '｜团队短板：' + (ctx.teamGap || '未说明'),
    '',
    '# 评估维度与行为锚点（每维只能选其中一个 level）',
    dimBlocks || '（无评分卡维度）',
    '',
    '# 候选人简历（已结构化：分区清晰、保留原始换行）',
    structureResume(resume, 9000),
    '',
    '# 输出（严格 JSON，键为维度名，按顺序，每个维度都要有）',
    '{',
    ...dims.map((d, i) => `  "${d.name}": { "evidence_quote": "简历原文摘录，无则填\"无\"", "reasoning": "对照锚点简述为何判此档", "level": "L0|L1|L2|L3" }${i < dims.length - 1 ? ',' : ''}`),
    '}',
  ].join('\n')
}

/** 解析 LLM 返回的逐维档位 JSON */
export function parseBarsResult(text, scorecard) {
  const t = String(text || '')
  let m = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/\{[\s\S]*\}/)
  let raw = m ? (m[1] || m[0]) : t
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}')
  if (i >= 0 && j > i) raw = raw.slice(i, j + 1)
  let obj
  try { obj = JSON.parse(raw) } catch (e) { return null }
  const dims = (scorecard.softDims || [])
  const verdicts = {}
  for (const d of dims) {
    const v = obj[d.name] || obj[Object.keys(obj).find(k => k.indexOf(d.name) >= 0 || d.name.indexOf(k) >= 0)] || null
    let level = v && /^L[0-3]$/.test(String(v.level).trim().toUpperCase()) ? String(v.level).trim().toUpperCase() : 'L0'
    verdicts[d.name] = {
      level,
      evidence: v ? String(v.evidence_quote || '无') : '无',
      reasoning: v ? String(v.reasoning || '') : '',
    }
  }
  return verdicts
}

/** 由档位判定（多采样取众数后）算分与评级 —— 纯代码，无 LLM */
/**
 * 判档为主的分档：由"维度档位分布"决定，而不是裸加权分。
 * 分数噪声撑不起细线（79/81 可能实质无差），所以档位看结构与短板，分数仅辅助。
 * 规则（以无硬伤为前提）：
 *   C：≥2 个维度 L0（明显缺证据/不合格），或全维 ≤L1
 *   S：无 L0，且 ≥2 个维度达 L3（突出），或 L3≥1 且高分
 *   A：无 L0，且多数维度 ≥L2（胜任）
 *   B：其余（有 1 个 L0，或多数停在 L1 —— 勉强/有短板，需面试排雷）
 */
export function gradeFromAlignment(alignment, score) {
  const arr = (alignment || []).filter(a => a && a.level)
  if (!arr.length) return { grade: 'B', basis: '无判档数据，暂定 B（待复核）' }
  const cnt = { L0: 0, L1: 0, L2: 0, L3: 0 }
  for (const a of arr) if (cnt[a.level] != null) cnt[a.level]++
  const n = arr.length
  const strong = cnt.L2 + cnt.L3
  // C：严重不足（≥2 维无证据，或 L0 占多数）；只有 1 个 L0 属"有短板"，留 B 排雷，不直接淘汰
  if (cnt.L0 >= 2 || cnt.L0 > (n - cnt.L0)) return { grade: 'C', basis: 'C：' + cnt.L0 + ' 个维度无证据/L0，整体偏弱' }
  // S：突出
  if (cnt.L0 === 0 && (cnt.L3 >= 2 || (cnt.L3 >= 1 && strong === n && score >= 82)))
    return { grade: 'S', basis: 'S：无短板，' + cnt.L3 + ' 个维度达突出档' }
  // A：胜任
  if (cnt.L0 === 0 && strong >= Math.ceil(n * 0.6) && score >= 72)
    return { grade: 'A', basis: 'A：无短板，' + strong + '/' + n + ' 维达胜任及以上' }
  // B：有短板
  return { grade: 'B', basis: 'B：' + cnt.L0 + ' 个 L0、' + cnt.L1 + ' 个偏弱，需面试排雷' }
}

export function scoreFromVerdicts(scorecard, verdicts) {
  const dims = scorecard.softDims || []
  let wsum = 0, got = 0
  const alignment = []
  for (const d of dims) {
    const w = Number(d.weight) || 0
    wsum += w
    const v = verdicts[d.name] || { level: 'L0', evidence: '无' }
    const lv = (d.levels || []).find(x => x.level === v.level)
    const sc = lv ? lv.score : 0
    got += (sc / 100) * w
    alignment.push({ dim: d.name, requirement: lv ? lv.anchor : '', candidate: v.evidence || '无', level: v.level, score: sc, verdict: v.level === 'L0' ? '缺失' : (v.level === 'L3' ? '突出' : '部分') })
  }
  const total = wsum > 0 ? Math.round((got / wsum) * 100) : 0
  const _g = gradeFromAlignment(alignment, total)
  return { score: total, grade: _g.grade, gradeBasis: _g.basis, alignment }
}

/**
 * 真·置信度：不是按等级硬套，而是综合三个可量化信号
 *  1) 采样一致性：同一维度 3 次判档的一致程度（agree/3）
 *  2) 证据覆盖度：有事实引用（非"无"）的维度占比
 *  3) 门槛确定性：硬门槛全部明确(pass/fail)比含 pending 更可信
 * 返回 0-1；越低越该人来复核。
 */
export function computeConfidence(verdicts, alignment, gateResults, samples) {
  const dims = Object.keys(verdicts || {})
  const n = dims.length || 1
  // 1) 采样一致性
  let agreeSum = 0
  for (const k of dims) { const a = verdicts[k] && verdicts[k].agree; agreeSum += (a != null ? a : (samples || 3)) }
  const denom = (samples || 3) * n
  const consistency = denom > 0 ? agreeSum / denom : 0.6
  // 2) 证据覆盖度
  let evOk = 0
  for (const a of (alignment || [])) { const c = String(a.candidate || '').trim(); if (c && c !== '无' && c.length >= 6) evOk++ }
  const evidenceCov = (alignment && alignment.length) ? evOk / alignment.length : 0.5
  // 3) 门槛确定性
  const gr = gateResults || []
  const pend = gr.filter(g => g.verdict === 'pending').length
  const gateCertain = gr.length ? (1 - pend / gr.length) : 0.7
  // 加权（一致性最重要）
  const raw = consistency * 0.5 + evidenceCov * 0.3 + gateCertain * 0.2
  // 压到 0.4-0.95 合理区间，别给满仓自信
  const conf = Math.round((0.4 + raw * 0.55) * 100) / 100
  return Math.max(0.35, Math.min(0.95, conf))
}

/** 多采样：对每维 level 取众数（平票取较高频、再取较低档更保守）*/
export function consensusVerdicts(scorecard, samples) {
  const dims = (scorecard.softDims || []).map(d => d.name)
  const out = {}
  for (const name of dims) {
    const levels = samples.map(s => (s && s[name] ? s[name].level : 'L0'))
    const cnt = {}
    levels.forEach(l => { cnt[l] = (cnt[l] || 0) + 1 })
    // 众数；平票时取较低档（保守，避免误高判）
    const order = ['L0', 'L1', 'L2', 'L3']
    let best = 'L0', bestN = -1
    for (const l of order) { const n = cnt[l] || 0; if (n > bestN) { bestN = n; best = l } }
    const pick = samples.find(s => s && s[name]) || {}
    out[name] = { level: best, evidence: (pick[name] || {}).evidence || '无', reasoning: (pick[name] || {}).reasoning || '', agree: bestN }
  }
  return out
}

// ===== 技术栈对齐闸门：防跨栈错配（如 U3D 简历评 Java 岗还给高分）=====
function toArr(x){ if(Array.isArray(x)) return x; if(x==null) return []; return String(x).split(/[、,，\n>]/).map(s=>s.trim()).filter(Boolean) }

// 岗位族 → 关键词（简历含这些说明是对口技术栈）
const STACK_GROUPS = {
  java: ['java', 'spring', 'springboot', 'spring cloud', 'springcloud', 'mybatis', 'jvm', '微服务', 'dubbo', 'kafka', 'rocketmq', 'tomcat', 'maven', 'jpa', 'hibernate'],
  frontend: ['前端', 'react', 'vue', 'typescript', 'javascript', 'html', 'css', 'webpack', 'vite', 'node.js', 'next.js', '前端框架'],
  u3d: ['u3d', 'unity', 'c#', '游戏客户端', '游戏开发', 'addressables', 'shader', '渲染', '游戏引擎', 'unreal', 'unreal engine', 'ios', 'cocos', 'spine'],
  data_ai: ['python', 'pytorch', 'tensorflow', '机器学习', '深度学习', '大模型', 'llm', '算法', '数据处理', 'pandas', 'numpy', '模型训练', 'nlp', 'cv'],
  backend_other: ['go', 'golang', 'c++', 'node', 'php', 'python', 'ruby', 'gRPC'],
  ops: ['运维', 'linux', 'k8s', 'kubernetes', 'docker', 'ci/cd', '自动化运维', 'devops'],
  mobile: ['android', 'ios', 'flutter', 'react native', 'swift', 'kotlin', '移动端', '小程序'],
}

// 从文本提取命中的技术栈组
function detectStacks(text) {
  const t = String(text || '').toLowerCase()
  const hit = {}
  for (const [g, words] of Object.entries(STACK_GROUPS)) {
    hit[g] = words.filter(w => t.indexOf(w) >= 0).length
  }
  return hit
}

/**
 * 判断候选人技术栈与岗位是否对口。
 * 返回 { fit: 'match'|'mismatch'|'unknown', jobStacks, candStacks, reason }
 * 仅当岗位有明确技术栈、且简历明显命中「其他栈」但完全不含「岗位栈」时判 mismatch。
 */
// 技术栈对口：统一走技能库（skills.js）单一口径，不再维护第二套手写词典
export function techStackFit(position, resume) {
  return stackFit(position, resume)
}

// 供评分卡引用：岗位技术栈的中文名 + 关键词（来自上面 STACK_GROUPS）
export const STACK_LABELS = {
  java: { name: 'Java/Spring 后端', words: STACK_GROUPS.java },
  frontend: { name: '前端（React/Vue/TS）', words: STACK_GROUPS.frontend },
  u3d: { name: 'U3D/Unity 游戏客户端', words: STACK_GROUPS.u3d },
  data_ai: { name: '数据/算法/AI', words: STACK_GROUPS.data_ai },
  ops: { name: '运维/DevOps', words: STACK_GROUPS.ops },
  mobile: { name: '移动端（Android/iOS）', words: STACK_GROUPS.mobile },
}
// 检测岗位的主技术栈 group（若有明确者）
export function detectJobStackGroup(position) {
  const jobText = [position.title, position.dept, toArr(position.abilities).join(' '), toArr(position.gates).join(' '), position.jd || ''].join(' ').toLowerCase()
  const hits = detectStacks(jobText)
  const groups = Object.keys(hits).filter(g => hits[g] > 0).sort((a, b) => hits[b] - hits[a])
  return groups[0] || null
}
