/* 技能抽取与岗位技能缺口（ESCO 分类思路：L语言/K知识/S技能/C证书）。
   LLM 不参与本模块：纯确定性词典匹配，输出可复现、可审计——用于证据增强与缺口展示，
   不替代 BARS 判档（判断仍由 Agent 读原文做出）。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

let CACHE = null
export function loadSkills() {
  if (CACHE) return CACHE
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    CACHE = JSON.parse(readFileSync(join(here, 'vendor', 'skills.json'), 'utf8'))
  } catch (e) { CACHE = { skills: [] } }
  return CACHE
}

/**
 * 从文本抽取技能。长别名优先并占用区间，避免「react」误吞「react native」。
 * 返回 [{ name, cat, group, hits }]，按 hits 降序。
 */
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g
/** 在文本中找 alias 的所有匹配位置。
 *  纯 ASCII alias 必须词边界（避免 od 命中 Xcode、java 命中 javascript）；
 *  含中文的 alias 直接子串匹配（中文无词边界）。 */
function aliasPositions(text, alias) {
  const isAscii = /^[\x00-\x7f]+$/.test(alias)
  const out = []
  if (isAscii) {
    const esc = alias.replace(RE_SPECIAL, '\\$&')
    let re
    try { re = new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])', 'g') } catch (e) { return out }
    let m
    while ((m = re.exec(text)) !== null) { out.push(m.index); if (m.index === re.lastIndex) re.lastIndex++ }
    return out
  }
  let from = 0
  for (;;) {
    const i = text.indexOf(alias, from)
    if (i < 0) break
    out.push(i)
    from = i + alias.length
  }
  return out
}

export function extractSkills(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return []
  const all = loadSkills().skills || []
  const items = []
  for (const s of all) {
    for (const a of (s.alias || [])) {
      const al = String(a).toLowerCase().trim()
      if (al.length < 2) continue
      items.push({ skill: s, alias: al, len: al.length })
    }
  }
  items.sort((x, y) => y.len - x.len)
  const taken = new Array(t.length).fill(false)
  const hitMap = {}
  for (const it of items) {
    for (const idx of aliasPositions(t, it.alias)) {
      let free = true
      for (let i = idx; i < idx + it.len; i++) if (taken[i]) { free = false; break }
      if (free) {
        for (let i = idx; i < idx + it.len; i++) taken[i] = true
        const key = it.skill.name
        hitMap[key] = hitMap[key] || { name: it.skill.name, cat: it.skill.cat, group: it.skill.group, hits: 0 }
        hitMap[key].hits += 1
      }
    }
  }
  return Object.values(hitMap).sort((a, b) => b.hits - a.hits)
}

/** 岗位技能需求：从 title/abilities/gates/JD/评分卡维度名 抽取 */
export function jobSkillDemand(position) {
  if (!position) return []
  const parts = [position.title || '', ...(position.abilities || []), ...(position.gates || []), position.jd || '']
  const dims = (position.scorecard && position.scorecard.softDims) || []
  for (const d of dims) parts.push(d.name || '')
  return extractSkills(parts.join('\n'))
}

/** 技能缺口：候选人技能 vs 岗位需求 → { matched, missing, rate } */
export function skillGap(candSkills, demand) {
  const have = new Set((candSkills || []).map(x => x.name))
  const matched = [], missing = []
  for (const d of (demand || [])) (have.has(d.name) ? matched : missing).push(d)
  const rate = demand && demand.length ? Math.round(matched.length / demand.length * 100) : null
  return { matched, missing, rate }
}

/** 岗位主技术栈组（从技能库需求推导，按命中数排序） */
export function techStackGroups(position) {
  const demand = jobSkillDemand(position).filter(x => x.group && x.group.indexOf('技术栈') === 0)
  const cnt = {}
  for (const d of demand) cnt[d.group] = (cnt[d.group] || 0) + 1
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map(g => ({ group: g, count: cnt[g] }))
}

/**
 * 技术栈对口判定（技能库驱动，唯一口径）：
 * 返回 { fit: 'match'|'mismatch'|'unknown', jobStack, jobStacks, candStacks, stackRate, reason }
 * 语义：岗位有明确主栈、简历几乎不含该栈技能却明显命中其他栈 → mismatch（硬否决）
 */
// 从简历中切出「项目/工作经历」段落（硬证据区）与「技能栏」段落（软证据区）。
// 存在理由：技能栏可以随便自述"熟练掌握 Java"，项目经历编不了。
// 技术栈判断必须以项目/工作经历为准；自述与项目矛盾时，以项目为准判 mismatch。
export function splitResumeSections(resume) {
  const t = String(resume || '')
  const lines = t.split('\n')
  const projRe = /(项目经历|项目经验|工作经历|工作经验|实习经历|实践经历|主要项目|项目背景|职业经历|工作履历)/
  const skillRe = /(专业技能|技能特长|技能清单|技术栈|技能|能力|擅长|掌握)/
  const proj = [], skill = [], other = []
  let cur = 'other'
  // 任意段落标题（教育/项目/工作/技能/证书/自我评价…）：用于终止当前段
  const anyHead = /^(教育|学习经历|项目|工作|实习|实践|技能|专业|证书|资质|获奖|荣誉|自我|个人|语言|培训|社会|校园|其他)/
  // 无标题简历的识别：日期区间行（2019.09-2022.08 xxx 公司 职位）视为工作/项目经历起点
  const dateLine = /^(19|20)\d{2}[\.\-\/年]\s*\d{0,2}.*(-|–|—|~|至)\s*((19|20)\d{2}|至今|现在)/
  // 行内「技能：xxx」直接归技能段
  const inlineSkill = /^(技能|专业技能|技术栈|擅长|掌握)\s*[：:]/
  for (const raw of lines) {
    const ln = String(raw || '').trim()
    if (!ln) { continue }
    const isProjHead = projRe.test(ln) && ln.length < 40
    const isSkillHead = skillRe.test(ln) && ln.length < 30 && !isProjHead
    if (isProjHead) { cur = 'proj'; continue }
    if (isSkillHead) { cur = 'skill'; continue }
    if (inlineSkill.test(ln)) { skill.push(ln.replace(inlineSkill, '')); cur = 'skill'; continue }
    // 其他段落标题 → 结束当前段（关键：避免技能栏内容被算进项目段）
    if (anyHead.test(ln) && ln.length < 30 && !/[，。；]/.test(ln)) { cur = 'other'; continue }
    // 无标题简历：日期行开启工作/项目段（这是硬证据区）
    if (dateLine.test(ln) && cur === 'other') { cur = 'proj'; proj.push(ln); continue }
    if (cur === 'proj') proj.push(ln)
    else if (cur === 'skill') skill.push(ln)
    else other.push(ln)
  }
  return { projText: proj.join('\n'), skillText: skill.join('\n'), otherText: other.join('\n'), hasProj: proj.length > 0 }
}

export function stackFit(position, resume) {
  const groups = techStackGroups(position)
  if (!groups.length) return { fit: 'unknown', jobStacks: [], candStacks: [], stackRate: null, reason: '岗位未体现明确技术栈，跳过栈匹配' }
  const primary = groups[0].group
  const demand = jobSkillDemand(position).filter(x => x.group === primary)
  const jobNames = demand.slice(0, 4).map(x => x.name).join('/')

  // 关键：分别提取「项目/工作经历」与「技能自述」的技能，判断依据以项目为主
  const sec = splitResumeSections(resume)
  const projSkills = extractSkills(sec.projText)
  const skillSelf = extractSkills(sec.skillText + '\n' + sec.otherText)
  const projInPrimary = projSkills.filter(x => x.group === primary)
  const selfInPrimary = skillSelf.filter(x => x.group === primary)
  const projGroups = {}
  for (const x of projSkills) if (x.group && x.group.indexOf('技术栈') === 0) projGroups[x.group] = (projGroups[x.group] || 0) + 1
  const projOthers = Object.keys(projGroups).filter(g => g !== primary)

  // 语言级证据门槛：对「后端」这类多语言共存的栈，必须有语言级关键词（如 java/spring），
  // 只有 kafka/redis/mysql 等通用中间件不算证明该语言能力（Python/Go 项目同样会用这些）。
  const LANG_LEVEL = {
    '技术栈-后端': ['java', 'spring', 'springboot', 'mybatis', 'jvm', 'dubbo', 'jpa', 'hibernate'],
    '技术栈-前端': ['react', 'vue', 'typescript', 'javascript', 'webpack', 'vite'],
    '技术栈-数据/AI': ['python', 'pytorch', 'tensorflow'],
    '技术栈-移动端': ['android', 'ios', 'swift', 'kotlin', 'flutter', 'react native'],
    '技术栈-运维': ['kubernetes', 'docker', 'jenkins', 'terraform', 'ansible'],
    '技术栈-U3D/游戏': ['unity', 'u3d', 'unreal', 'shader'],
  }
  // 同栈内不同语言互斥：主栈=后端 时，要区分 Java 生态 vs Python/Go/Node 等其他后端语言
  const ALT_LANG = {
    '技术栈-后端': [
      { lang: 'Python', words: ['python', 'flask', 'django', 'fastapi'] },
      { lang: 'Go', words: ['golang', 'go语言', ' gin', 'beego'] },
      { lang: 'Node.js', words: ['node.js', 'nodejs', 'express', 'nestjs', 'koa'] },
      { lang: 'PHP', words: ['php', 'laravel', 'thinkphp'] },
      { lang: 'C#/.NET', words: ['c#', '.net', 'asp.net', 'dotnet'] },
    ],
    '技术栈-前端': [
      { lang: 'Vue', words: ['vue'] },
      { lang: 'React', words: ['react'] },
      { lang: 'Angular', words: ['angular'] },
    ],
  }
  // 判断技能里是否出现"与主栈语言不同的替代语言"（含 backend_other 组的 go/python/php 等）
  const altHits = (skills) => {
    const out = []
    const alts = ALT_LANG[primary] || []
    for (const a of alts) {
      // 主栈本身若就是该语言（如岗位是 Python 岗），则跳过
      const primaryIsThis = (langWords || []).some(w => a.words.some(aw => aw.indexOf(w) >= 0 || w.indexOf(aw) >= 0))
      if (primaryIsThis) continue
      const hit = skills.find(x => a.words.some(w => String(x.name || '').toLowerCase().indexOf(w.trim()) >= 0))
      if (hit) out.push(a.lang)
    }
    // 非 Java 生态的后端语言（Go/Node/PHP/Python/Ruby/C++）：不论归在哪个组，对 Java 主栈都是替代语言
    if (primary === '技术栈-后端') {
      for (const o of skills) {
        const nm = String(o.name || '').toLowerCase()
        if ((langWords || []).some(w => nm.indexOf(w) >= 0)) continue   // 属于主栈生态则跳过
        let label = null
        if (/^(go|golang)$/.test(nm)) label = 'Go'
        else if (/node(\.js)?|nodejs|express|nestjs|koa/.test(nm)) label = 'Node.js'
        else if (/^php$|laravel|thinkphp/.test(nm)) label = 'PHP'
        else if (/^python$|flask|django|fastapi/.test(nm)) label = 'Python'
        else if (/^ruby$|rails/.test(nm)) label = 'Ruby'
        else if (/^c\+\+$/.test(nm)) label = 'C++'
        else if (/^c#$|\.net|dotnet/.test(nm)) label = 'C#/.NET'
        if (label && out.indexOf(label) < 0) out.push(label)
      }
    }
    return out
  }

  const langWords = LANG_LEVEL[primary] || null
  const hasLangLevel = (skills) => {
    if (!langWords) return skills.length > 0
    return skills.some(x => {
      const n = String(x.name || '').toLowerCase()
      return langWords.some(w => n.indexOf(w) >= 0)
    })
  }

  // ① 项目里有主栈「语言级」证据 → match（真材实料）
  if (projInPrimary.length && hasLangLevel(projInPrimary)) {
    const rate = Math.min(100, Math.round(projInPrimary.length / Math.max(1, demand.length) * 100))
    return { fit: 'match', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: rate,
      reason: '项目/工作经历中命中岗位主栈「' + primary + '」' + projInPrimary.length + ' 项（栈覆盖 ' + rate + '%）' }
  }

  // ①b 项目里只有通用中间件（kafka/mysql 等），无语言级证据 → 不算命中主栈
  const projOnlyGeneric = projInPrimary.length > 0 && !hasLangLevel(projInPrimary)

  // ② 项目里出现「其他语言」实现（如岗位要 Java，项目全是 Python/Flask）→ mismatch，这是明确的证据矛盾
  const alts = altHits(projSkills)
  if (!hasLangLevel(projInPrimary) && (alts.length || projOthers.length)) {
    const actual = alts.length ? alts.join('/') : projOthers.join('/')
    const selfNote = selfInPrimary.length ? '（技能栏虽自述含 ' + selfInPrimary.map(x => x.name).slice(0, 3).join('/') + '，但项目经历无对应实践，自述不足以采信）' : ''
    return { fit: 'mismatch', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: alts.length ? alts : projOthers, stackRate: 0,
      reason: '岗位要求「' + primary + '」技术栈（' + jobNames + '），但项目/工作经历中的后端实现实际是「' + actual + '」，未见 ' + (langWords || []).slice(0, 3).join('/') + ' 项目证据' + selfNote + '——技术方向不对口' }
  }

  // ③ 项目里既无主栈也无其他技术栈（项目写得空）→ 看自述，但只算 unknown 需核实
  if (!sec.hasProj) {
    if (selfInPrimary.length) {
      return { fit: 'unknown', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: null,
        reason: '简历无项目/工作经历可判断实际技术使用；技能栏自述含「' + primary + '」相关（' + selfInPrimary.map(x => x.name).slice(0, 3).join('/') + '），需面试核实' }
    }
    return { fit: 'unknown', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: 0,
      reason: '简历未体现岗位主栈「' + primary + '」相关技能（' + jobNames + '）' }
  }

  // ④ 有项目但没命中任何已知技术栈（可能是文字描述不含技术名）
  if (selfInPrimary.length) {
    return { fit: 'unknown', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: null,
      reason: '项目经历未出现明确技术栈名称，技能栏自述含「' + primary + '」相关，需面试核实实际使用情况' }
  }
  return { fit: 'unknown', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: 0,
    reason: '简历未明确体现岗位主栈「' + primary + '」相关技能（' + jobNames + '）' }
}

/**
 * AI 代写 / 过度润色检测（标记，不淘汰）。
 *
 * 存在理由：本系统的核心是「BARS 判档 + 引用原文证据」。如果简历本身是 AI 润色
 * 甚至重写的，那么被引用的「原文证据」可能是漂亮话而非事实——整条证据链的可信度被动摇。
 *
 * 检测不追求判定「是否 AI 写的」（这不可靠），只标记「文本特征异常」，
 * 提示面试时重点核实量化数据是否真实。宁可误标，不可漏标——因为漏标代价更高。
 *
 * 返回 { level, score, signals[], note }：
 *   level=clean    未见异常
 *   level=suspect  有 1-2 项特征，面试时留意
 *   level=likely   有 3+ 项特征，量化数据需重点核实
 */
export function detectAiPolish(text) {
  const t = String(text || '')
  const signals = []
  if (t.length < 100) return { level: 'clean', score: 0, signals: [], note: '' }

  // 1) 空洞的企业黑话密度（有词无数）
  const JARGON = ['赋能', '闭环', '抓手', '打法', '组合拳', '生态位', '护城河', '飞轮', '第二曲线',
    '底层逻辑', '顶层设计', '方法论', '颗粒度', '对齐', '拉通', '沉淀', '复用', '范式', '势能',
    'leveraging', 'synergy', 'paradigm shift', 'best-in-class', 'cutting-edge', 'seamless']
  const jargonHits = JARGON.filter(w => t.indexOf(w) >= 0)
  if (jargonHits.length >= 3) {
    signals.push('企业黑话密集（' + jargonHits.slice(0, 4).join('、') + '）')
  }

  // 2) 排比/对仗结构密度（AI 润色的典型痕迹）
  const parallelPatterns = [
    /不仅[^。；\n]{4,40}而且/g, /一方面[^。；\n]{4,40}另一方面/g,
    /既[^。；\n]{4,30}又[^。；\n]{4,30}/g, /从[^。；\n]{2,15}到[^。；\n]{2,15}/g,
  ]
  let parallelCount = 0
  for (const re of parallelPatterns) { const m = t.match(re); if (m) parallelCount += m.length }
  if (parallelCount >= 3) signals.push('排比句式密集（' + parallelCount + ' 处）')

  // 3) 形容词堆砌但缺数字
  const ADJ = ['深入', '全面', '显著', '大幅', '有效', '充分', '高度', '极大', '卓越', '优异', '出色', '完善']
  const adjCount = ADJ.reduce((n, w) => n + (t.split(w).length - 1), 0)
  const numCount = (t.match(/\d+(\.\d+)?\s*(%|万|千|亿|ms|s|qps|tps|人|倍)/gi) || []).length
  if (adjCount >= 5 && numCount <= 2) {
    signals.push('形容词多（' + adjCount + ' 处）但量化数据少（' + numCount + ' 处）')
  }

  // 4) 段落结构过度工整（每段长度高度一致 + 都以短句总结收尾）
  const paras = t.split(/\n\s*\n|\n(?=[•·\-*\d])/).map(x => x.trim()).filter(x => x.length > 30)
  if (paras.length >= 4) {
    const lens = paras.map(p => p.length)
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length
    const variance = lens.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / lens.length
    const cv = Math.sqrt(variance) / (avg || 1)
    if (cv < 0.28) signals.push('段落长度高度一致（变异系数 ' + cv.toFixed(2) + '），人工写作通常更参差')
  }

  // 5) 过度完美的标点与格式（全角半角统一、无错字痕迹在短文本上无意义，这里看符号密度）
  const emojiOrBullet = (t.match(/[✅🎯📌🔹🔸▶●◆]/g) || []).length
  if (emojiOrBullet >= 6) signals.push('装饰符号密集（' + emojiOrBullet + ' 个）')

  // 评分与分级
  const score = signals.length
  let level = 'clean', note = ''
  if (score >= 3) { level = 'likely'; note = '文本特征高度接近 AI 生成/重度润色，面试须核实量化数据真实性' }
  else if (score >= 1) { level = 'suspect'; note = '有 AI 润色痕迹，建议面试时重点核实项目数据' }
  return { level, score, signals, note }
}
