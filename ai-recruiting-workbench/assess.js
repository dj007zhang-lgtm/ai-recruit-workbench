/* 自动评估引擎：给一条简历、一个岗位评分卡，产出「逐维分数 + 可引用证据 + 未判定 + 疑点 + 建议 + 置信度」。
   原则：不是黑箱公式——每个维度必须抽到简历原句才给分，抽不到就判未判定；给的是建议，判断权在人和校准。 */

// 常见能力维度的语义锚（关键词 + 近义）。岗位评分卡里维度名命中即用，未命中走通用经验规则。
const DIM_SIGNALS = [
  { keys: ['排班', '调度', '人力', '用工'], words: ['排班', '早晚班', '轮班', '排休', '人力调配', '工时', '带教', '带过', '小组', '团队'], unit: '人' },
  { keys: ['目标', '拆解', '计划'], words: ['目标', '拆解', '复盘', '达成', 'KPI', '完成率', '增长', '%', '同比', '环比'], unit: '%' },
  { keys: ['客诉', '投诉', '服务', '售后', '客服'], words: ['客诉', '投诉', '售后', '客服', '满意度', '闭环', '处理', '响应'], unit: '' },
  { keys: ['运营', '店铺', '电商', '投放', 'ROI', '复盘'], words: ['运营', '店铺', '电商', '投放', 'ROI', '转化', 'GMV', '大促', '复盘', '商品结构', '活动'], unit: '' },
  { keys: ['前端', '组件', '工程', 'TypeScript', '性能'], words: ['前端', '组件', 'TypeScript', 'React', 'Vue', '性能', '工程化', '打包', 'Webpack', 'Vite', '模块化'], unit: '' },
  { keys: ['U3D', 'Unity', '游戏', '客户端'], words: ['U3D', 'Unity', '游戏', '客户端', '框架', 'Addressables', '资源管理', '渲染', 'Shader'], unit: '' },
  { keys: ['沟通', '协作', '跨部门'], words: ['沟通', '协作', '跨部门', '对接', '协调', '推动', '汇报'], unit: '' },
  { keys: ['管理', '团队', '负责人'], words: ['管理', '负责人', '主导', '带过', '团队', '组长', '主管', '领导'], unit: '人' },
  // —— 评分卡四类维度（双轨制软价值）——
  { keys: ['过往战绩', '量化', '成果', '业绩'], words: ['主导', '负责', '带', '提升', '降低', '增长', '完成', '实现', '从', '到', '增长', '翻', '%', '倍', 'GMV', 'QPS', '效率', '优化', '节省', '达成', '营收', '利润', '转化', '节省', '万', '亿'], unit: '' },
  { keys: ['技能', '专业深度', '专业'], words: ['精通', '熟练', '掌握', '熟悉', '擅长', '架构', '设计', '开发', '实现', '技术选型', '源码', '底层', '深入', 'Java', 'Spring', 'Redis', 'MySQL', 'Python', 'TypeScript', 'React', 'Vue', '微服务'], unit: '' },
  { keys: ['行业', '赛道', '匹配'], words: ['行业', '电商', '零售', '金融', 'SaaS', 'ToB', '互联网', '游戏', '制造', '物流', '医疗', '教育', '年经验', '同行业', '头部', '大厂'], unit: '' },
  { keys: ['职业成长', '经验积累', '成长'], words: ['晋升', '负责', '主导', '迭代', '演进', '从0', '搭建', '拓展', '跨域', '沉淀', '带教'], unit: '' },
]

const POSITIVE = ['主导', '负责', '独立', '从0', '搭建', '优化', '提升', '降低', '增长', '完成', '实现', '落地', '带领', '带领', '闭环', '达成']
const NEGATIVE_HINTS = ['未提供', '待确认', '不清楚']

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/[\n。；;！!？?]/)
    .map(s => s.trim())
    .filter(s => s.length >= 4 && s.length <= 120)
}

// 从简历文本估算总工作年限（取最早年份到今天）
function estimateYears(text) {
  const years = []
  const re = /(19|20)\d{2}/g
  let m
  while ((m = re.exec(text))) years.push(Number(m[0]))
  const grads = text.match(/(19|20)\d{2}\s*[年.]?\s*(毕业|至今|-) /g)
  if (!years.length) return null
  const now = new Date().getFullYear()
  const earliest = Math.min.apply(null, years.filter(y => y > 1990 && y <= now))
  // 用最早工作年份（排除出生年：出生年 +22 ≈ 工作起始，这里取 >= 出生+18 的年份当工作年）
  const workStart = Math.min.apply(null, years.filter(y => y >= 2005 && y <= now))
  if (!workStart || workStart > now) return null
  return now - workStart
}

// 学历层级
const EDU_LEVEL = { '博士': 5, '硕士': 4, '研究生': 4, '本科': 3, '学士': 3, '大专': 2, '专科': 2, '高中': 1, '中专': 1, '初中': 0 }
function maxEduLevel(text) {
  let lv = -1
  for (const k in EDU_LEVEL) if (text.indexOf(k) >= 0) lv = Math.max(lv, EDU_LEVEL[k])
  // 未显式写学历词：从「学院/大学 + 起止年份学制」推断
  if (lv < 0 && /(大学|学院|学校)/.test(text)) {
    const spans = [...text.matchAll(/(19|20)\d{2}\s*[年.\-/]?\s*\d{0,2}\s*月?\s*[-–~至到]+\s*((19|20)\d{2})/g)]
    let maxSpan = 0
    for (const m of spans) {
      const y1 = Number(m[0].match(/(19|20)\d{2}/)[0])
      const y2 = Number(m[2])
      if (y2 > y1) maxSpan = Math.max(maxSpan, y2 - y1)
    }
    if (maxSpan >= 3) lv = 3        // 4 年制（含 3 年以上）→ 本科
    else if (maxSpan >= 2) lv = 2   // 2-3 年 → 大专/专升本
    else lv = 3                     // 有大学/学院但无年份，先按本科（待核会兜底）
  }
  return lv
}
const EDU_NAMES = { 5: '博士', 4: '硕士', 3: '本科', 2: '大专', 1: '高中及以下', 0: '初中及以下' }

/**
 * 智能判定一条硬门槛：尽量从简历事实判 通过/不通过，判不了才待核。
 * 返回 { verdict: 'pass'|'fail'|'pending', reason }
 */
import { extractSkills } from './skills.js'

export function evaluateGate(gate, text) {
  const g = String(gate || '')
  const t = String(text || '')
  // 学历 / 统招本科 类
  const eduMatch = g.match(/(博士|硕士|研究生|本科|学士|大专|专科)/)
  if (eduMatch) {
    const needWord = eduMatch[1]
    const needLv = /博士/.test(needWord) ? 5 : /硕士|研究生/.test(needWord) ? 4 : /本科|学士/.test(needWord) ? 3 : 2
    const has = maxEduLevel(t)
    if (has < 0) return { verdict: 'pending', reason: '简历未写学历/院校信息' }
    if (has < needLv) return { verdict: 'fail', reason: '学历低于要求（要求' + needWord + '，实为' + (EDU_NAMES[has] || '未知') + '）' }
    // 统招限定：需区分全日制/统招 vs 非全日制
    if (/统招|全日制/.test(g)) {
      if (/自考|成人|函授|网络教育|电大|专升本|在职/.test(t) && !/统招|全日制/.test(t)) {
        return { verdict: 'fail', reason: '学历非统招/全日制（简历含自考/成人/函授/专升本）' }
      }
      if (/统招|全日制/.test(t)) return { verdict: 'pass', reason: '统招全日制' + (EDU_NAMES[has] || '') }
      // 未显式标统招：按常识判断——4 年制本科（大学/学院 + 4 年学制）视为统招；否则提示核对
      const spanMatch = [...t.matchAll(/(19|20)\d{2}\s*[年.\-/]?\s*\d{0,2}\s*月?\s*[-–~至到]+\s*((19|20)\d{2})/g)]
      let fullSpan = 0
      for (const m of spanMatch) { const y1 = Number(m[0].match(/(19|20)\d{2}/)[0]); const y2 = Number(m[2]); if (y2 > y1) fullSpan = Math.max(fullSpan, y2 - y1) }
      if (has >= 3 && fullSpan >= 3) return { verdict: 'pass', reason: '统招' + (EDU_NAMES[has] || '本科') + '（' + fullSpan + ' 年制全日制，推断为统招）' }
      return { verdict: 'pass', reason: (EDU_NAMES[has] || '') + '学历达标（未显式标注统招；如有专升本/非全日制请核对）' }
    }
    return { verdict: 'pass', reason: '学历达标（' + (EDU_NAMES[has] || '') + ' ≥ ' + needWord + '）' }
  }
  // 专业类
  const majorMatch = g.match(/(计算机|软件工程|电子信息|数学|统计|自动化|相关专业)/)
  if (majorMatch) {
    const majors = ['计算机', '软件工程', '软件', '信息工程', '电子信息', '信息技术', '自动化', '数学', '统计', '通信', '网络工程', '人工智能', '数据']
    const found = majors.find(m => t.indexOf(m) >= 0)
    if (found) return { verdict: 'pass', reason: '专业命中（含「' + found + '」）' }
    const otherMajor = t.match(/(?:专业|系)[:：]?\s*([\u4e00-\u9fa5]{2,10})/)
    if (otherMajor) return { verdict: 'pending', reason: '专业为「' + otherMajor[1] + '」，与计算机相关专业需人工确认' }
    return { verdict: 'pending', reason: '简历未写明专业' }
  }
  // 年限类
  const yrMatch = g.match(/(\d+)\s*年以上|(\d+)\s*年.*经验/)
  if (yrMatch) {
    const need = Number(yrMatch[1] || yrMatch[2])
    const est = estimateYears(t)
    if (est == null) return { verdict: 'pending', reason: '简历无法估算工作年限' }
    if (est >= need) return { verdict: 'pass', reason: '工作年限约 ' + est + ' 年 ≥ ' + need + ' 年' }
    return { verdict: 'pending', reason: '按时间估算约 ' + est + ' 年，接近但需核对' + need + '年要求' }
  }
  // 核心技术栈对口：技能库单一口径（从门槛文本提取要求技能，简历命中任一即过）
  if (/核心技术栈|技术栈/.test(g)) {
    const req = extractSkills(g).filter(x => x.group && x.group.indexOf('技术栈') === 0)
    const have = extractSkills(text)
    if (req.length) {
      const hit = req.filter(r => have.some(hh => hh.name === r.name))
      if (hit.length) return { verdict: 'pass', reason: '技术栈对口（命中 ' + hit.map(x => x.name).join('/') + '）' }
      return { verdict: 'fail', reason: '技术栈不对口：要求「' + req.map(x => x.name).join('/') + '」，简历未体现' }
    }
  }
  // 无法识别的门槛：退回关键词命中
  const key = g.replace(/[0-9]+|年以上|以上|可接受|熟悉|本地/g, '').trim()
  if (key && key.split(/[\s、,，]/).some(k => k && t.indexOf(k) >= 0)) return { verdict: 'pass', reason: '简历命中关键词' }
  return { verdict: 'pending', reason: '需人工核对' }
}

// 评估一段证据的质量等级：0=仅提及, 1=有动作无量化, 2=有量化成果, 3=突出且规模化
function gradeEvidence(quote) {
  const q = String(quote || '')
  const hasNum = /\d/.test(q)                                  // 有数字
  const strongNum = /(\d+\s*[%倍万]|从\s*\d+\s*到\s*\d+|提升|降低|增长|翻\d|\d+\s*(万|亿|人|家|个))/i.test(q) // 量化变化
  const scale = /(\d+\s*人团队|带\s*\d+|\d+\s*(万|亿)|\d+\s*家|全|主导|独立负责|从0|搭建)/i.test(q)       // 规模/主导
  const action = POSITIVE.some(p => q.indexOf(p) >= 0)
  if (strongNum && scale) return 3
  if (strongNum || (hasNum && action)) return 2
  if (action) return 1
  return 0
}

function findEvidence(text, dimension, used) {
  const sents = splitSentences(text).filter(s => !used || !used.has(s))
  if (!sents.length) return null
  let anchors = null
  for (const d of DIM_SIGNALS) {
    if (d.keys.some(k => dimension.indexOf(k) >= 0 || k.indexOf(dimension) >= 0)) { anchors = d.words; break }
  }
  const pool = anchors || dimension.split(/[\s/,，、]/).filter(Boolean)
  let best = null, bestScore = -1, bestGrade = -1
  for (const s of sents) {
    let hit = 0
    for (const a of pool) if (s.indexOf(a) >= 0) hit++
    if (hit < 1) continue   // 必须命中该维度锚词才算这条维度的证据
    const grade = gradeEvidence(s)
    // 综合：质量等级优先，其次锚词命中数
    const score = grade * 10 + Math.min(hit, 5)
    if (score > bestScore) { bestScore = score; best = s; bestGrade = grade }
  }
  if (best == null) return null
  return { quote: best, strength: bestGrade, grade: bestGrade }
}

function scoreEvidence(ev, allTextLen) {
  // 按证据质量等级给分，区间拉开：
  //   grade 0 仅提及：35-50   grade 1 有动作无量化：50-68
  //   grade 2 有量化成果：68-84   grade 3 突出且规模化：84-96
  const g = ev.grade != null ? ev.grade : 1
  const q = String(ev.quote || '')
  const ranges = [[35, 50], [50, 68], [68, 84], [84, 96]]
  const [lo, hi] = ranges[Math.max(0, Math.min(3, g))]
  // 区间内位置：证据越长、越具体，越靠上
  let pos = 0.5
  if (q.length >= 30) pos += 0.2
  if (q.length < 14) pos -= 0.2
  if (/\d/.test(q)) pos += 0.15
  pos = Math.max(0, Math.min(1, pos))
  const v = lo + Math.round((hi - lo) * pos)
  return Math.max(30, Math.min(96, v))
}

/**
 * 运行自动评估。返回 payload 供 recruit_record_assessment / assessment.recorded 使用。
 * @param {string} resume 脱敏后的简历正文
 * @param {object} position { abilities, gates, standard }
 * @param {string[]} forbidden 禁问字段（此处不入分）
 */
export function autoAssess(resume, position) {
  const text = String(resume || '')
  // 「是否关联岗位」看岗位是否存在（有 title），而不是看能力项是否非空——岗位存在但没填能力项 ≠ 未关联
  const linked = !!(position && (position.title || position.id))
  // 评估维度以「评分卡」为准（口径一致）；无评分卡再退回 JD/能力项/通用
  const sc = (position && position.scorecard) || null
  let abilities = []
  let weights = null
  if (sc && Array.isArray(sc.softDims) && sc.softDims.length) {
    abilities = sc.softDims.map(d => d.name)
    weights = {}
    sc.softDims.forEach(d => { weights[d.name] = Number(d.weight) || 0 })
  } else if (position && position.abilities && position.abilities.length) {
    abilities = position.abilities.slice()
  } else if (linked) {
    const jd = position.jdObj || null
    if (jd && jd.qualifications && Array.isArray(jd.qualifications.skills) && jd.qualifications.skills.length) {
      abilities = jd.qualifications.skills.slice(0, 6)
    } else if (jd && Array.isArray(jd.responsibilities) && jd.responsibilities.length) {
      abilities = jd.responsibilities.slice(0, 5).map(r => (String(r.action || '') + String(r.content || '')).slice(0, 10)).filter(Boolean)
    }
  }
  if (!abilities.length) abilities = ['专业能力', '业绩达成', '沟通协作', '带团队']
  // 硬门槛：优先取评分卡的 hardGates，其次岗位 gates
  let gates = (position && position.gates) || []
  if (sc && Array.isArray(sc.hardGates) && sc.hardGates.length) gates = sc.hardGates.map(g => (typeof g === 'string' ? g : g.item)).filter(Boolean)

  const scores = {}, evidence = {}, undetermined = [], doubts = []
  const used = new Set()
  let evidenceCount = 0

  for (const dim of abilities) {
    const ev = findEvidence(text, dim, used)
    if (!ev) { undetermined.push(dim); continue }
    used.add(ev.quote)
    scores[dim] = scoreEvidence(ev, text.length)
    evidence[dim] = ev.quote
    evidenceCount++
  }

  // 闸门智能判定：尽量从简历事实判 通过/不通过，判不了才标待核
  const gateResults = []
  for (const g of gates) {
    const r = evaluateGate(g, text)
    gateResults.push({ gate: g, verdict: r.verdict, reason: r.reason })
    if (r.verdict === 'pending') doubts.push('闸门待核：' + g + '（' + r.reason + '）')
    else if (r.verdict === 'fail') doubts.push('闸门可能不通过：' + g + '（' + r.reason + '）')
  }

  // 三条疑点：未判定维度优先，其次闸门待核
  for (const u of undetermined) { if (doubts.length < 3) doubts.push('缺证据：' + u) }

  // 文本过薄/像扫描件
  if (text.length < 80) doubts.push('简历文本过少，可能解析不全')

  // 证据覆盖 + 文本厚度
  const coverage = abilities.length ? evidenceCount / abilities.length : 0
  const avg = evidenceCount ? Object.values(scores).reduce((a, b) => a + b, 0) / evidenceCount : 0
  const hasPosition = linked

  // 有评分卡权重时，加权总分（0-100）作为统一评分口径；无则用均分
  let weighted = avg
  if (weights) {
    let wsum = 0, got = 0
    for (const d of abilities) {
      const w = weights[d] || 0
      wsum += w
      if (scores[d] != null) got += (scores[d] / 100) * w
    }
    if (wsum > 0) weighted = Math.round((got / wsum) * 100)
  }
  const score = Math.round(weighted)

  // 关键：找出「高权重却缺证据」的维度——这才是真正需要补的材料
  const highWeightMissing = []
  for (const d of abilities) {
    if (scores[d] == null) {
      const w = weights ? (weights[d] || 0) : Math.round(100 / abilities.length)
      highWeightMissing.push({ dim: d, weight: w })
    }
  }
  highWeightMissing.sort((a, b) => b.weight - a.weight)

  // 硬门槛是否有明确不通过
  const gateFail = gateResults.filter(g => g.verdict === 'fail')

  // 判断可信度 conf：只反映「证据是否充分/文本是否可读」，不掺分数高低。
  //   证据覆盖是主因，文本过薄扣分。
  let conf = 0.55 + coverage * 0.4
  if (text.length < 120) conf -= 0.2
  if (!hasPosition) conf -= 0.05
  conf = Math.max(0.3, Math.min(0.95, Number(conf.toFixed(2))))

  // 明确结论：给出可执行的判断与下一步，不和稀泥
  let route, action, conclusion
  if (!hasPosition) {
    route = '无法评估 · 未关联岗位'; action = '先在职位管理为该候选人绑定岗位'; conclusion = 'blocked'
  } else if (gateFail.length) {
    route = '不推荐 · 未过硬门槛'; conclusion = 'reject'
    action = '硬门槛未过：' + gateFail.map(g => g.gate + '（' + g.reason + '）').join('；') + '。如属破格需人工确认'
  } else if (highWeightMissing.length && highWeightMissing[0].weight >= 20) {
    const m = highWeightMissing.slice(0, 2)
    conclusion = 'need_info'
    route = '待补充 · 缺关键维度证据'
    action = '简历缺「' + m.map(x => x.dim + '(' + x.weight + '%)').join('、') + '」的可引用证据；请向候选人索取该维度的具体经历/量化结果，或补充作品集/背调'
  } else if (score >= 80) {
    route = '推荐 · 进入初试'; conclusion = 'recommend'
    action = '加权 ' + score + ' 分，硬门槛全过，证据覆盖 ' + Math.round(coverage * 100) + '%；安排初试（HR/业务初面），初试通过后进复试'
  } else if (score >= 65) {
    route = '可议 · 建议安排初试进一步判断'; conclusion = 'interview'
    action = '加权 ' + score + ' 分，中等水平' + (highWeightMissing.length ? '，初试重点核实「' + highWeightMissing.map(x => x.dim).join('、') + '」' : '') + '；安排初试后据表现决定是否进复试'
  } else {
    route = '不推荐'; conclusion = 'reject'
    action = '加权 ' + score + ' 分，明显低于岗位要求；如坚持可人工复核'
  }

  if (!hasPosition) doubts.unshift('未关联岗位，请先绑定岗位')
  else if (position && (!position.abilities || !position.abilities.length) && !position.scorecard && !(position.jdObj && (position.jdObj.qualifications || position.jdObj.responsibilities))) {
    doubts.unshift('岗位「' + (position.title || '') + '」暂无评分卡/能力项，建议在职位管理补充后重评更准')
  }
  return {
    scores, evidence, undetermined, doubts: doubts.slice(0, 3),
    conf, route, action, conclusion,
    summary: `维度依据${sc ? '评分卡' : '通用口径'}｜加权 ${score} 分｜证据覆盖 ${Math.round(coverage * 100)}%｜判断可信度 ${conf}`,
    gateChecked: gates.length, gateResults, abilities: abilities, weights: weights || null, weighted,
    highWeightMissing,
  }
}
