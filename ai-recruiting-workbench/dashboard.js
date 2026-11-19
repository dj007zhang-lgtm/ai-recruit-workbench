import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 阶段枚举与 ledger 保持一致（曾因旧枚举导致漏斗统计整体落「未归档」的 bug）
import { STAGES, SOURCES } from './ledger.js'
export { STAGES, SOURCES }

/* 流程节点：每个节点挂一组 AI 能力，并统计自动推进 */
export const NODES = [
  { id: 'intake', label: '接入', stages: ['待评估'], ai: ['简历解析', '入口脱敏', '三键去重'], auto: '自动评估' },
  { id: 'screen', label: '评估', stages: ['待评估'], ai: ['BARS 判档', '技术栈硬门槛', '证据校验'], auto: '自动评估' },
  { id: 'interview', label: '面试', stages: ['待初试', '初试中', '待复试', '复试中'], ai: ['邀约文案', '结构化面评'], auto: '阶段' },
  { id: 'bgcheck', label: '背调', stages: ['待背调'], ai: ['背调提醒'], auto: '决策' },
  { id: 'decision', label: '决策', stages: ['待发 Offer'], ai: ['终面决策'], auto: '决策' },
  { id: 'offer', label: 'Offer 全周期', stages: ['Offer已发', 'Offer已接受', '待入职'], ai: ['Offer 表单', '接受跟踪'], auto: '决策' },
  { id: 'hire', label: '入职', stages: ['已入职'], ai: ['入职确认'], auto: '阶段' },
]

function readJSON(p, fb) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { return fb } }
function readRows(p) { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch (e) { return [] } }
function readText(p) { try { return readFileSync(p, 'utf8') } catch (e) { return '' } }
function writeRows(p, rows) { writeFileSync(p, rows.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8') }
function shift(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10) }
function typeOf(line) { const p = line.split(' | '); return (p[2] || '').trim() }
function dayOf(line) { return String(line).slice(0, 10) }
function cnt(lines, type) { return lines.filter(l => typeOf(l) === type).length }
function inRange(line, a, b) { const k = dayOf(line); return k >= a && k <= b }

function delta(value, prev) {
  if (prev == null) return { delta: null, pct: null, trend: 'flat', deltaLabel: '暂无上期' }
  const d = value - prev
  const p = prev === 0 ? (d === 0 ? 0 : null) : Math.round(d / prev * 100)
  return {
    delta: d, pct: p,
    trend: d > 0 ? 'up' : (d < 0 ? 'down' : 'flat'),
    deltaLabel: d === 0 ? '持平' : (d > 0 ? `+${d}` : `${d}`) + (p == null ? '' : ` (${p > 0 ? '+' : ''}${p}%)`),
  }
}

const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000 * 10) / 10)

/**
 * 实时看板：所有数字从事件账本与快照重算。
 * 数据结构对标主流招聘工作台概览：
 *  - kpis：核心 4 卡带「洞察句」（不只是裸计数）
 *  - pipeline：6 环节「累计到达漏斗」+ 相邻转化率（从事件算累计，不是瞬时分布）
 *  - cycle：平均处理周期（接入→进面试 / 接入→终态）
 *  - sourceQuality：渠道质量（总量 × 通过率）
 */
export function buildDashboard(d, opts) {
  opts = opts || {}
  const PERIOD = opts.period === 'week' || opts.period === 'month' ? opts.period : 'all'
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  const ps = readJSON(join(d, 'positions.json'), [])
  const cs = readRows(join(d, 'candidates.jsonl'))
  const ev = readText(join(d, 'events.log')).split('\n').filter(Boolean)
  const evs = readRows(join(d, 'events.jsonl'))
  const cal = readRows(join(d, 'calibration.jsonl'))

  const byStage = {}, bySource = {}
  for (const s of STAGES) byStage[s] = 0
  for (const s of SOURCES) bySource[s] = 0
  for (const c of cs) {
    const stage = STAGES.indexOf(c.stage) >= 0 ? c.stage : '其他'
    // 来源按实际值聚合（规范渠道/历史渠道/自定义渠道各自成项，不吞进"其他"）
    const source = String(c.source || '').trim() || '其他'
    byStage[stage] = (byStage[stage] || 0) + 1
    bySource[source] = (bySource[source] || 0) + 1
  }

  const today = shift(0), curStart = shift(6), prevStart = shift(13), prevEnd = shift(7)
  const cur = ev.filter(l => inRange(l, curStart, today))
  const prev = ev.filter(l => inRange(l, prevStart, prevEnd))

  // ===== 事件结构化聚合：按候选人归组 =====
  const byCand = {}
  for (const e of evs) {
    const id = (e.subject || {}).id
    if (!id) continue
    byCand[id] = byCand[id] || { receivedTs: null, firstAssessTs: null, latestGrade: null, entered: {}, decidedTs: null, decision: null, source: '', lastTs: null }
    const g = byCand[id], ts = e.ts
    if (!g.lastTs || ts > g.lastTs) g.lastTs = ts
    if (e.type === 'resume.received') { if (!g.receivedTs) g.receivedTs = ts; g.source = (e.payload || {}).source || g.source }
    if (e.type === 'assessment.recorded' && !g.firstAssessTs) g.firstAssessTs = ts
    if (e.type === 'assessment.recorded' && (e.payload || {}).deep) g.latestGrade = (e.payload || {}).deep.grade
    if (e.type === 'stage.advanced') g.entered[(e.payload || {}).to] = ts
    if (e.type === 'resume.received') g.pid = (e.payload || {}).pid || ''
    if (e.type === 'hire.confirmed') g.hiredTs = ts
    if (e.type === 'decision.made' && !g.decidedTs) { g.decidedTs = ts; g.decision = (e.payload || {}).decision }
    if (e.type === 'offer.sent') g.offerSent = true
    if (e.type === 'offer.accepted') g.offerAccepted = true
    if (e.type === 'offer.declined') g.offerDeclined = true
    if (e.type === 'hire.confirmed') g.hiredTs = ts
    if (e.type === 'onboarding.scheduled') g.onboardTs = ts
  }

  // ===== 6 环节累计管道（到达过该环节的候选人数，事件语义）=====
  const reached = {
    pool: Object.keys(byCand).length,
    screened: Object.values(byCand).filter(g => g.firstAssessTs).length,
    passed: Object.values(byCand).filter(g => g.latestGrade && g.latestGrade !== 'C').length,
    failed: Object.values(byCand).filter(g => g.latestGrade === 'C').length,
    interview: Object.values(byCand).filter(g => g.entered['初试中']).length,
    second: Object.values(byCand).filter(g => g.entered['复试中']).length,
    offer: Object.values(byCand).filter(g => g.offerSent || g.entered['Offer已发'] || g.entered['Offer已接受'] || g.entered['待入职'] || g.entered['已入职']).length,
  }
  const pipeline = [
    { id: 'pool', label: '简历池', count: reached.pool, hint: '累计接入' },
    { id: 'screen', label: 'AI 初筛', count: reached.screened, hint: '评估完成' },
    { id: 'passed', label: '初筛通过', count: reached.passed, hint: 'S/A/B 级' },
    { id: 'interview', label: '进入面试', count: reached.interview, hint: '初试中' },
    { id: 'second', label: '复试', count: reached.second, hint: '复试中' },
    { id: 'offer', label: 'Offer/入职', count: reached.offer, hint: '录用' },
  ]
  for (let i = 1; i < pipeline.length; i++) {
    const prevN = pipeline[i - 1].count
    pipeline[i].conv = prevN ? Math.round(pipeline[i].count / prevN * 100) + '%' : '—'
  }
  pipeline[0].conv = '100%'

  // ===== 处理周期 =====
  const done = Object.values(byCand).filter(g => g.decidedTs && g.receivedTs)
  const toInterview = Object.values(byCand).filter(g => g.entered['初试中'] && g.receivedTs)
  const cycle = {
    resolvedAvgDays: done.length ? Math.round(done.reduce((a, g) => a + daysBetween(g.receivedTs, g.decidedTs), 0) / done.length * 10) / 10 : null,
    resolvedCount: done.length,
    toInterviewAvgDays: toInterview.length ? Math.round(toInterview.reduce((a, g) => a + daysBetween(g.receivedTs, g.entered['初试中']), 0) / toInterview.length * 10) / 10 : null,
    toInterviewCount: toInterview.length,
  }

  // ===== 渠道端到端转化：简历 → 初筛 → 初面 → Offer → 入职 =====
  const sf = {}
  for (const [cid, g] of Object.entries(byCand)) {
    // 按实际来源聚合（自定义/历史渠道不吞进"其他"）
    const s0 = String(g.source || '').trim() || '其他'
    sf[s0] = sf[s0] || { source: s0, total: 0, screened: 0, interview: 0, offer: 0, hired: 0 }
    const o = sf[s0]
    o.total++
    if (g.firstAssessTs) o.screened++
    if (g.entered['初试中']) o.interview++
    if (g.entered['Offer'] || g.entered['已入职'] || g.decision === 'Offer' || g.offerSent) o.offer++
    if (g.hiredTs || g.entered['已入职']) o.hired++
  }
  const sourceFunnel = Object.values(sf).sort((a, b) => b.total - a.total).map(o => ({
    ...o,
    toInterview: o.total ? Math.round(o.interview / o.total * 100) : null,
    toOffer: o.interview ? Math.round(o.offer / o.interview * 100) : null,
    toHire: o.offer ? Math.round(o.hired / o.offer * 100) : null,
    hireRate: o.total ? Math.round(o.hired / o.total * 100) : null,
  }))

  // ===== 即将入职（Offer 已发、待报到）：招聘的兑现信号 =====
  const arrivals = []
  for (const [cid, g] of Object.entries(byCand)) {
    if (g.entered['已入职']) continue
    if (!(g.offerSent || g.decision === 'Offer' || g.entered['Offer'])) continue
    const c2 = cs.find(x => x.id === cid)
    if (!c2) continue
    arrivals.push({ id: cid, name: c2.name, stage: c2.stage, decidedTs: g.decidedTs || g.lastTs })
  }

  // ===== 渠道质量：总量 × 通过率 =====
  const sq = {}
  for (const g of Object.values(byCand)) {
    const s = SOURCES.indexOf(g.source) >= 0 ? g.source : '其他'
    sq[s] = sq[s] || { total: 0, passed: 0 }
    sq[s].total++
    if (g.latestGrade && g.latestGrade !== 'C') sq[s].passed++
  }
  const sourceQuality = SOURCES.map(s => ({
    source: s, total: sq[s] ? sq[s].total : 0,
    passRate: sq[s] && sq[s].total ? Math.round(sq[s].passed / sq[s].total * 100) + '%' : '—',
    passed: sq[s] ? sq[s].passed : 0,
  })).filter(x => x.total > 0).sort((a, b) => b.total - a.total)

  const active = ps.filter(p => p.status === '在招').length
  const evaluatedCount = cs.filter(c => c.scores || c.deep).length
  const pendingDecision = byStage['待发 Offer'] || 0
  const hired = byStage['已入职'] || 0
  const autoCount = cnt(cur, '自动评估') + cnt(cur, '阶段')
  const humanCount = cnt(cur, '决策')
  const autoRate = (autoCount + humanCount) ? Math.round(autoCount / (autoCount + humanCount) * 100) : 0
  const undetermined = cs.filter(c => c.undetermined && c.undetermined.length).length
  const traceable = evaluatedCount ? Math.round((evaluatedCount - undetermined) / evaluatedCount * 100) : 100

  // ===== 招聘业务指标（招聘负责人的决策数据，不是过程量）=====
  const FLOW_STAGES = ['待评估', '待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职']
  // ① 职位招聘进度：需求 / 已入职 / 在途 / 缺口 / 在途分布 / 均到岗 / 复开轮次 / 上轮对比 / 可关闭
  const computePos = (p) => {
    const mine = cs.filter(c => c.pid === p.id)
    const hiredN = mine.filter(c => c.stage === '已入职').length
    const flow = mine.filter(c => FLOW_STAGES.indexOf(c.stage) >= 0)
    const stageDist = {}
    for (const c of flow) stageDist[c.stage] = (stageDist[c.stage] || 0) + 1
    const hc = Number(p.hc) || 1
    const createdTs = (function () {
      const ev = evs.find(e => e.type === 'position.created' && ((e.subject || {}).id === p.id))
      return ev ? ev.ts : null
    })()
    const hireDays = []
    if (createdTs) for (const g of Object.values(byCand)) {
      if (g.pid === p.id && g.hiredTs) hireDays.push(daysBetween(createdTs, g.hiredTs))
    }
    // 岗位级漏斗：简历→评估→面试→Offer→入职（口径与全局漏斗一致）
    const mineCand = Object.values(byCand).filter(g => g.pid === p.id)
    const fun = {
      resume: mine.length,
      screened: mine.filter(c => c.deep || (c.scores && Object.keys(c.scores).length)).length,
      interview: mineCand.filter(g => g.entered && (g.entered['初试中'] || g.entered['复试中'] || g.entered['待复试'])).length,
      offer: mineCand.filter(g => g.entered && (g.entered['Offer已发'] || g.entered['Offer已接受'] || g.entered['待入职']) || g.offerSent).length,
      hired: hiredN,
    }
    // 周期：已入职均到岗；无入职 → 在途平均已停留天数（真实等待成本）
    const inflowDays = flow.map(c => { const g = byCand[c.id]; return (g && g.receivedTs) ? Math.max(0, Math.round((Date.now() - new Date(g.receivedTs).getTime()) / 86400000)) : null }).filter(x => x != null)
    return {
      id: p.id, title: p.title, hc, hired: hiredN, inFlow: flow.length,
      gap: Math.max(0, hc - hiredN),
      progress: Math.min(100, Math.round(hiredN / hc * 100)),
      stageDist, status: p.status || '在招', parentId: p.parentId || '',
      funnel: fun,
      inflowAvgDays: inflowDays.length ? Math.round(inflowDays.reduce((a, b) => a + b, 0) / inflowDays.length * 10) / 10 : null,
    }
  }
  const allPosStats = ps.map(computePos)
  const avgById = {}
  for (const x of allPosStats) avgById[x.id] = x.avgDays
  // 复开轮次：沿 parentId 链计数（第 N 轮招聘）
  const roundOf = (p) => {
    let n = 1, cur = p
    const seen = new Set([p.id])
    while (cur && cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId)
      const par = ps.find(x => x.id === cur.parentId)
      if (!par) break
      n++
      cur = par
    }
    return n
  }
  const hiring = allPosStats.filter(x => x.status === '在招').map(x => {
    const p0 = ps.find(p => p.id === x.id) || {}
    return {
      ...x,
      round: roundOf(p0),
      prevAvgDays: p0.parentId ? (avgById[p0.parentId] != null ? avgById[p0.parentId] : null) : null,
      canClose: x.gap === 0 && x.inFlow === 0,
    }
  }).sort((a, b) => (b.hc - b.hired) - (a.hc - a.hired))
  const closableCount = hiring.filter(x => x.canClose).length

  // ② 环节平均停留天数（找瓶颈）
  const ORDER = ['待评估', '待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职', '已入职']
  const stageTime = ORDER.map((st, i) => {
    const ds = []
    for (const g of Object.values(byCand)) {
      const t0 = g.entered[st]
      if (!t0) continue
      let t1 = null
      for (let k = i + 1; k < ORDER.length; k++) if (g.entered[ORDER[k]]) { t1 = g.entered[ORDER[k]]; break }
      if (!t1 && g.decidedTs) t1 = g.decidedTs
      if (t1 && t1 > t0) ds.push(daysBetween(t0, t1))
    }
    return { stage: st, avg: ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length * 10) / 10 : null, n: ds.length }
  })

  // ③ Offer 接受率：到达 Offer → 实际入职
  // Offer 接受率（真实口径）：发出 N 个 → 接受 / 拒绝 / 待响应
  const offerSentN = Object.values(byCand).filter(g => g.offerSent).length
  const offerAcceptedN = Object.values(byCand).filter(g => g.offerAccepted).length
  const offerDeclinedN = Object.values(byCand).filter(g => g.offerDeclined).length
  const hiredTotal = Object.values(byCand).filter(g => g.hiredTs || g.entered['已入职']).length
  const offerResponded = offerAcceptedN + offerDeclinedN
  const offerAccept = {
    sent: offerSentN, accepted: offerAcceptedN, declined: offerDeclinedN, hired: hiredTotal,
    rate: offerResponded ? Math.round(offerAcceptedN / offerResponded * 100) : null,
    pending: Math.max(0, offerSentN - offerResponded),
    declineRate: offerResponded ? Math.round(offerDeclinedN / offerResponded * 100) : null,
  }

  // ④ AI 初筛分布 + 人工改判
  const gradeDist = { S: 0, A: 0, B: 0, C: 0 }
  for (const g of Object.values(byCand)) if (g.latestGrade && gradeDist[g.latestGrade] != null) gradeDist[g.latestGrade]++
  const aiPerf = {
    gradeDist, screened: Object.values(byCand).filter(g => g.firstAssessTs).length,
    corrections: cal.length,
    correctionRate: reached.screened ? Math.round(cal.length / reached.screened * 100) : null,
  }

  // ⑤ 超时未动（流失风险）：按业务等待上限判定
  const nowMs = Date.now()
  const overdue = []
  for (const g of Object.values(byCand)) {
    if (!g.lastTs) continue
    const c2 = cs.find(x => x.id === Object.keys(byCand).find(k => byCand[k] === g))
    if (!c2) continue
    const days = Math.floor((nowMs - new Date(g.lastTs).getTime()) / 86400000)
    const rules = {
      '待初试': [3, '待初试超 3 天未发邀约'],
      '待背调': [3, '待背调超 3 天未出结论'],
      '待发 Offer': [2, '待发 Offer 超 2 天未拍板'],
      '初试中': [5, '初试中超 5 天未录面评'],
      '复试中': [5, '复试中超 5 天未录面评'],
      'Offer': [5, 'Offer 超 5 天未跟进入职'],
    }
    const rule = rules[c2.stage]
    if (rule && days >= rule[0]) overdue.push({ id: c2.id, name: c2.name, stage: c2.stage, days, reason: rule[1] })
  }
  overdue.sort((a, b) => b.days - a.days)

  // ===== 洞察句素材 =====
  const gap = ps.filter(p => p.status === '在招').map(p => {
    const inFlow = cs.filter(c => c.pid === p.id && ['已淘汰', '人才库'].indexOf(c.stage) < 0).length
    return { title: p.title, gap: Math.max(0, (p.hc || 1) - inFlow), inFlow }
  }).sort((a, b) => b.gap - a.gap)[0]
  const newSrc = sourceQuality[0]
  const passTotal = reached.screened, passOk = reached.passed  // 漏斗环节仍用通过数；淘汰数单列
  const passRate = passTotal ? Math.round(passOk / passTotal * 100) : null
  const needConfirm = cs.filter(c => ['待发 Offer'].indexOf(c.stage) >= 0).length
  // ===== 周期口径：流量指标 = 快照差分（本周期末累计 − 上周期末累计），环比 = 同长度上一周期 =====
  const PDAYS = PERIOD === 'week' ? 7 : PERIOD === 'month' ? 30 : 0
  const mrowsAll = readRows(join(d, 'metrics.jsonl')).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const latestM = mrowsAll[mrowsAll.length - 1] || null
  const cutFor = (days, offset) => {
    const dl = new Date(Date.now() - (days + offset) * 86400000).toISOString().slice(0, 10)
    let last = null
    for (const m of mrowsAll) if (String(m.date) <= dl) last = m
    return last
  }
  // 周期起点前最后快照 / 上一周期起点前最后快照
  const startSnap = PERIOD === 'all' ? null : cutFor(PDAYS, 0)
  const prevStartSnap = PERIOD === 'all' ? null : cutFor(PDAYS, PDAYS)
  const flowDiff = (key, a, b) => (a && a[key] != null && b && b[key] != null) ? (a[key] - b[key]) : null
  const flow = {
    intake: PERIOD === 'all' ? null : flowDiff('candidates', latestM, startSnap),
    screened: PERIOD === 'all' ? null : flowDiff('evaluated', latestM, startSnap),
    interview: PERIOD === 'all' ? null : flowDiff('pipeline', latestM, startSnap, 'interview'),
    hired: PERIOD === 'all' ? null : flowDiff('hired', latestM, startSnap),
  }
  // pipeline 差分需要按 id 取
  const pipeDiff = (id, a, b) => {
    const pa = a && (a.pipeline || []).find(x => x.id === id)
    const pb = b && (b.pipeline || []).find(x => x.id === id)
    return (pa && pb && pa.count != null && pb.count != null) ? (pa.count - pb.count) : null
  }
  flow.interview = PERIOD === 'all' ? null : pipeDiff('interview', latestM, startSnap)
  flow.offer = PERIOD === 'all' ? null : pipeDiff('offer', latestM, startSnap)
  flow.passed = PERIOD === 'all' ? null : pipeDiff('passed', latestM, startSnap)
  // 上一周期环比
  const prevFlow = {
    intake: PERIOD === 'all' ? null : flowDiff('candidates', startSnap, prevStartSnap),
    interview: PERIOD === 'all' ? null : pipeDiff('interview', startSnap, prevStartSnap),
  }
  const periodLabel = PERIOD === 'week' ? '本周' : PERIOD === 'month' ? '本月' : '累计'
  const weekNew = cnt(cur, '接入')
  const prevNew = cnt(prev, '接入')

  /* 按日快照（幂等） */
  const metrics = readRows(join(d, 'metrics.jsonl'))
  const snap = {
    date: today, positions: ps.length, active, candidates: cs.length,
    byStage, bySource, evaluated: evaluatedCount, hired, pendingDecision, talent: cs.filter(c => c.stage === '人才库').length,
    undetermined, traceable, calibration: cal.length, pipeline, cycle,
    hiring: ps.filter(p => p.status === '在招').map(p => ({ title: p.title, hc: p.hc || 1, hired: cs.filter(c => c.pid === p.id && c.stage === '已入职').length })),
    stageTime,
  }
  const existing = metrics.filter(m => m.date === today)
  if (!existing.length) {
    metrics.push(snap)
    writeRows(join(d, 'metrics.jsonl'), metrics)
  } else {
    existing[existing.length - 1] = snap
    const idx = metrics.findIndex(m => m === existing[0])
    if (idx >= 0) metrics[idx] = snap
    writeRows(join(d, 'metrics.jsonl'), metrics)
  }
  const prevSnap = metrics.filter(m => m.date < today).slice(-1)[0] || null

  const K = (key, label, value, prevV, unit, note, insight) => ({
    key, label, value, prev: prevV, unit: unit || '', note: note || '', insight: insight || note || '', ...delta(value, prevV),
  })
  // 招聘负责人的 4 个决策卡：招到没有 / 瓶颈在哪 / 多快能到 / Offer 收不收得下
  const totalHc = hiring.reduce((a, h) => a + h.hc, 0)
  const totalHired = hiring.reduce((a, h) => a + h.hired, 0)
  const totalFlow = hiring.reduce((a, h) => a + h.inFlow, 0)
  const totalGap = Math.max(0, totalHc - totalHired)
  const donePct = totalHc ? Math.round(totalHired / totalHc * 100) : 0
  const toInterviewRate = reached.pool ? Math.round(reached.interview / reached.pool * 100) : null
  const offerReached = offerSentN  // 发出 Offer 人数（转化口径）
  const toOfferRate = reached.interview ? Math.round(offerReached / reached.interview * 100) : null
  const bottleneck = (function () {
    const seg = [
      { name: '初筛→初面', n: reached.pool - reached.interview },
      { name: '初面→Offer', n: reached.interview - offerReached },
    ].sort((a, b) => b.n - a.n)[0]
    return seg && seg.n > 0 ? seg.name : null
  })()
  const hireCycle = (function () {
    const ds = []
    for (const g of Object.values(byCand)) if (g.entered['已入职'] && g.receivedTs) ds.push(daysBetween(g.receivedTs, g.entered['已入职']))
    return ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length * 10) / 10 : null
  })()
  const kpis = [
    K('done', '招聘完成度', totalHired + '/' + totalHc, prevSnap && prevSnap.hiring ? prevSnap.hiring.hired : null, '人',
      totalGap ? `还差 ${totalGap} 人 · ${totalFlow} 人在途` : '需求已招满',
      totalGap ? `招到 ${donePct}% · 还差 ${totalGap} 人（在途 ${totalFlow}）` : '全部需求已招满'),
    K('conv', '简历→初面转化', toInterviewRate != null ? toInterviewRate + '%' : '—',
      prevSnap && prevSnap.reached ? (prevSnap.reached.pool ? Math.round(prevSnap.reached.interview / prevSnap.reached.pool * 100) : null) : null, '',
      bottleneck ? `瓶颈：${bottleneck} 流失最多` : '转化正常',
      bottleneck ? `总转化 ${toInterviewRate}% · 瓶颈在 ${bottleneck}` : null),
    K('hireCycle', '平均到岗周期', hireCycle != null ? hireCycle : '—',
      prevSnap && prevSnap.hireCycle != null ? prevSnap.hireCycle : null, '天',
      hireCycle != null ? `${hiredTotal} 人已入职 · 从接入起算` : '暂无入职样本',
      hireCycle != null ? `从收简历到入职 ${hireCycle} 天` : null),
    K('accept', 'Offer 接受率', offerAccept.rate != null ? offerAccept.rate + '%' : '—',
      prevSnap && prevSnap.offerAccept ? prevSnap.offerAccept.rate : null, '',
      offerAccept.pending ? `${offerAccept.pending} 个 Offer 待入职` : (offerAccept.sent ? '已入职 ' + offerAccept.hired + ' 人' : '暂无 Offer'),
      offerAccept.pending ? `接受率 ${offerAccept.rate}% · ${offerAccept.pending} 个待入职` : null),
  ]
  // 兼容：附加次要 KPI（小字排展示）
  const kpisMinor = [
    K('candidates', '候选人总量', cs.length, prevSnap ? prevSnap.candidates : null, '人', '全库'),
    K('intake', periodLabel + '新增', PERIOD === 'all' ? weekNew : (flow.intake != null ? Math.max(0, flow.intake) : weekNew),
      PERIOD === 'all' ? prevNew : prevFlow.intake, '份', PERIOD === 'all' ? '近 7 天' : (periodLabel + '流量 · 环比上' + (PERIOD === 'week' ? '周' : '月'))),
    K('screenFail', 'AI 初筛淘汰', reached.failed, null, '份', reached.screened ? ('挡掉 ' + reached.failed + '/' + reached.screened + ' 份 · 免人工筛') : '免人工筛'),
    K('pending', '待人工拍板', needConfirm, prevSnap ? prevSnap.pendingDecision : null, '人', '必须人给结论'),
    K('talent', '人才库沉淀', cs.filter(c => c.stage === '人才库').length, prevSnap ? prevSnap.talent : null, '人', '可激活复捞'),
    K('autoRate', '免人工率', autoRate, prevSnap && prevSnap.autoRate != null ? prevSnap.autoRate : null, '%', '执行环节'),
    K('calibration', '纠偏记录', cal.length, prevSnap ? prevSnap.calibration : null, '条', '标准收敛信号'),
  ]

  const funnel = STAGES.map(s => ({
    stage: s, count: byStage[s] || 0,
    ...delta(byStage[s] || 0, prevSnap && prevSnap.byStage ? prevSnap.byStage[s] : null),
  }))
  // 渠道口径：规范清单 ∪ 数据中实际出现的来源（历史渠道如"网投"仍入统计，不丢数）
  const allSrc = Array.from(new Set([...SOURCES, ...Object.keys(bySource)]))
  const sources = allSrc.map(s => ({
    source: s, count: bySource[s] || 0,
    ...delta(bySource[s] || 0, prevSnap && prevSnap.bySource ? prevSnap.bySource[s] : null),
  }))

  const nodes = NODES.map(n => ({
    id: n.id, label: n.label, stages: n.stages, ai: n.ai,
    count: n.stages.reduce((a, s) => a + (byStage[s] || 0), 0),
    automated: cnt(cur, n.auto),
    entered: cnt(cur, '接入') + cnt(cur, '评估') + cnt(cur, '阶段'),
  }))

  const ai = {
    calls: cnt(cur, '接入') + cnt(cur, '评估') + cnt(cur, '自动评估') + cnt(cur, '纠偏'),
    prevCalls: cnt(prev, '接入') + cnt(prev, '评估') + cnt(prev, '自动评估') + cnt(prev, '纠偏'),
    savedHours: (cnt(cur, '评估') * 0.15).toFixed(1),
    autoRate, traceable, undetermined,
    capabilities: [
      { name: '简历解析', node: '接入', count: cnt(cur, '接入') },
      { name: '入口脱敏', node: '接入', count: cnt(cur, '接入') },
      { name: '三键去重', node: '接入', count: cnt(cur, '去重') },
      { name: 'BARS 判档初筛', node: '评估', count: cnt(cur, '评估') },
      { name: '技术栈硬门槛', node: '评估', count: cnt(cur, '评估') },
      { name: '评级分流', node: '评估', count: cnt(cur, '自动评估') },
      { name: '结构化面评', node: '面试', count: cnt(cur, '阶段') },
      { name: '纠偏写回标准', node: '全节点', count: cnt(cur, '纠偏') },
    ],
  }
  ai.callsDelta = delta(ai.calls, ai.prevCalls)

  return {
    generatedAt: new Date().toISOString(),
    period: { current: `${curStart} ~ ${today}`, previous: `${prevStart} ~ ${prevEnd}` },
    periodMode: PERIOD, periodLabel,
    dataDir: d,
    baseline: prevSnap ? `对比 ${prevSnap.date} 快照与上一周期事件` : '首日基线已建立，环比将在后续累积',
    kpis, kpisMinor, pipeline, cycle, sourceQuality,
    funnel, sources, nodes, ai,
    hiring, closableCount, stageTime, offerAccept, aiPerf, overdue, reached, sourceFunnel, arrivals,
    pending: {
      intake: cs.filter(c => c.stage === '待评估').length,
      decision: pendingDecision,
      lowConfidence: cs.filter(c => c.conf != null && c.conf < 0.72).length,
      undetermined,
    },
  }
}
