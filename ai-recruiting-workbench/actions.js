/* 动作层：界面动作与工具调用的唯一实现。任何"改状态"都翻译成一条事件。
   HTTP 动作端点与 recruit_* 工具都调用这里，保证界面上每个动作都能通过一次工具调用复现。 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendEvent, recordAssessment, deriveGrade, deriveScore, fold, replay, standardVersions, migrateLegacy,
  HUMAN_CONTRACT, MACHINE_CONTRACT, readEvents,
} from './ledger.js'
import { autoAssess } from './assess.js'
import { ruleJD, jdToMarkdown } from './jd.js'
import { techStackFit } from './deepscore.js'
import { gradeFromScore } from './deepassess.js'
import { extractSkills, jobSkillDemand, skillGap, stackFit } from './skills.js'
import { checkPosting } from './compliance.js'
import { matchPositions } from './match.js'

const DECISIONS = { '进初试': '待初试', '进复试': '待复试', '面': '待初试', '不面': '已淘汰', '补一句': '待评估', 'Offer': 'Offer', '淘汰': '已淘汰', '人才库': '人才库', '已入职': '已入职' }
const DEFAULT_BASED_ON = { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'local-rules', prompt: 'v1' }

function numK(x){ if(x==null) return 0; const m=String(x).match(/[\d.]+/); return m?Number(m[0]):0 }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }; return 'h' + (h >>> 0).toString(16) }

function readRows(p) { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch (e) { return [] } }

/** 影响面：这个动作会波及哪些已发邀约 / 已排面试 / 已生成草案。人的判断有外部性，必须先看到。 */
export function impactOf(d, candidateId) {
  const own = readEvents(d).filter(e => (e.subject || {}).id === candidateId)
  const pick = (t) => own.filter(e => e.type === t).map(e => ({ seq: e.seq, ts: e.ts, payload: e.payload }))
  return {
    invites: pick('invite.sent'), interviews: pick('interview.scheduled'), offers: pick('offer.sent'),
    assessments: pick('assessment.recorded').length,
    summary: `已发邀约 ${pick('invite.sent').length} · 已排面试 ${pick('interview.scheduled').length} · Offer 草案 ${pick('offer.sent').length}`,
  }
}

/** 关岗影响面：该职位下处于「在途」（未入职/未终态）的候选人清单，供关岗前决策。 */
export function positionImpact(d, positionId) {
  const s = fold(d)
  const pos = s.positions.find(p => p.id === positionId)
  if (!pos) return { ok: false, error: '职位不存在' }
  const TERMINAL = ['已入职', 'Offer拒绝', '已淘汰', '人才库']
  const inFlight = s.candidates.filter(c => c.pid === positionId && TERMINAL.indexOf(c.stage) < 0)
  const byStage = {}
  for (const c of inFlight) byStage[c.stage] = (byStage[c.stage] || 0) + 1
  return {
    ok: true, positionId, title: pos.title,
    inFlightCount: inFlight.length,
    byStage,
    candidates: inFlight.map(c => ({ id: c.id, name: c.name, stage: c.stage })),
    summary: inFlight.length
      ? '关岗前有 ' + inFlight.length + ' 名候选人在途（' + Object.keys(byStage).map(k => k + ' ' + byStage[k]).join(' / ') + '），需为每人指定去向'
      : '无在途候选人，可直接关闭',
  }
}

/** 工作台一次拉取所需的全部数据：看板 + 收件箱 + 选中候选人详情 + 因果链 + 规范版本。 */
export function workbenchData(d, candidateId, buildDashboard, opts) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  migrateLegacy(d)
  const s = fold(d)
  const dashboard = buildDashboard(d, opts)
  const items = s.inbox.map(x => ({ ...x, name: x.name || (s.byId[x.id] || {}).name || x.id }))
  const selectedId = candidateId || (items[0] || {}).id || (s.candidates[0] || {}).id || null
  const c = selectedId ? s.byId[selectedId] : null
  let detail = null
  if (c) {
    const p = s.positions.find(x => x.id === c.pid) || null
    let standard = ''
    if (p && p.standard) { try { standard = readFileSync(join(d, p.standard), 'utf8') } catch (e) { standard = '(评分卡缺失)' } }
    const r = replay(d, c.id)
    detail = {
      candidate: {
        id: c.id, name: c.name, pid: c.pid, source: c.source, stage: c.stage, mail: c.mail || null, resume: c.resume, mail: c.mail || null,
        scores: c.scores, conf: c.conf, route: c.route, evidence: c.evidence,
        undetermined: c.undetermined, doubts: c.doubts, summary: c.summary,
        gateResults: c.gateResults || [], weighted: c.weighted != null ? c.weighted : null,
        action: c.action || '', conclusion: c.conclusion || '', deep: c.deep || null,
        unlinked: !!c.unlinked,
      },
      position: p, standard, gates: p ? p.gates || [] : [], abilities: p ? p.abilities || [] : [],
      stackFit: (function () { try { return stackFit(p, c.resume || '') } catch (e) { return null } })(),
      suggestedPositions: (function () {
        if (c.pid) return null
        try { const m = matchPositions({ resume: c.resume }, s.positions); return m && m.ranked ? m.ranked.slice(0, 3) : null } catch (e) { return null }
      })(),
      compliance: (function () { try { return p && p.jd ? checkPosting(p.jd) : null } catch (e) { return null } })(),
      skills: (function () { try { return extractSkills(c.resume || '') } catch (e) { return [] } })(),
      jobSkills: (function () { try { return jobSkillDemand(p) } catch (e) { return [] } })(),
      skillGap: (function () { try { return skillGap(extractSkills(c.resume || ''), jobSkillDemand(p)) } catch (e) { return { matched: [], missing: [], rate: null } } })(),
      forbidden: ['性别', '年龄', '出生日期', '婚育', '民族', '宗教', '户籍', '照片'],
      timeline: r.chain, standardAtLastEvent: r.standardAtLastEvent, currentStandard: r.currentStandard,
      impact: impactOf(d, c.id),
      calibration: s.calibration.filter(x => x.candidateId === c.id),
      replayCount: r.eventCount,
      // 本批排名分位：同岗位、已评估候选人的加权分排序
      rank: (function () {
        if (c.weighted == null) return null
        const peers = s.candidates.filter(x => x.pid === c.pid && x.weighted != null)
        if (peers.length < 2) return null
        const sorted = peers.slice().sort((a, b) => b.weighted - a.weighted)
        const pos = sorted.findIndex(x => x.id === c.id) + 1
        return { pos, total: sorted.length, pct: Math.round(pos / sorted.length * 100) }
      })(),
    }
  }
  // ===== 面试日程聚合：所有 interview.scheduled，附候选人当前状态 =====
  const evAll = readEvents(d)

  // 最近一次邀约（界面显示"已邀约"状态，解决"发了邀约但看起来没动"）
  const invMap = {}
  for (const e of evAll) {
    if (e.type !== 'invite.sent') continue
    const cid2 = (e.subject || {}).id
    if (cid2) invMap[cid2] = e.payload || {}
  }
  // 面试官访问令牌（来自 interview.scheduled）——取每人最新一条
  const ivTokenMap = {}
  for (const e of evAll) {
    if (e.type !== 'interview.scheduled') continue
    const cid2 = (e.subject || {}).id
    const tk = (e.payload || {}).token
    if (cid2 && tk) ivTokenMap[cid2] = tk
  }
  const candidates = s.candidates.map(c => ({
    id: c.id, name: c.name, pid: c.pid, source: c.source, stage: c.stage,
    conf: c.conf, route: c.route, needsOcr: !!c.needsOcr,
    undetermined: (c.undetermined || []).length, unlinked: !!c.unlinked,
    lastInvite: invMap[c.id] ? { at: invMap[c.id].at || '', channel: invMap[c.id].channel || '', round: invMap[c.id].round || '', token: ivTokenMap[c.id] || '' } : null,
    weighted: c.weighted != null ? c.weighted : null,
    score: c.deep && c.deep.score != null ? c.deep.score : (c.weighted != null ? c.weighted : null),
    grade: deriveGrade(c),
    skills: (function () { try { return extractSkills(c.resume || '').map(x => x.name).slice(0, 8) } catch (e) { return [] } })(),
    summary: (c.summary || '').slice(0, 120),
    daysAgo: (function () {
      const evs2 = evAll.filter(e => (e.subject || {}).id === c.id)
      const last = evs2[evs2.length - 1]
      return last ? Math.floor((Date.now() - new Date(last.ts).getTime()) / 86400000) : null
    })(),
  }))

  const byId2 = {}
  for (const c of s.candidates) byId2[c.id] = c
  const interviews = evAll.filter(e => e.type === 'interview.scheduled').map(e => {
    const c = byId2[(e.subject || {}).id] || {}
    return {
      candidateId: c.id, name: c.name || (e.subject || {}).id, stage: c.stage || '',
      round: (e.payload || {}).round || '初试', at: (e.payload || {}).at || '',
      interviewer: (e.payload || {}).interviewer || '', place: (e.payload || {}).place || (e.payload || {}).channel || '',
      ts: e.ts,
    }
  }).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
  // 同一人多轮面试：候选人在途（初试中/复试中）的排最新在前，已淘汰/Offer 的沉底
  const liveInterviews = interviews.filter(x => ['待初试', '初试中', '待复试', '复试中', '待发 Offer'].indexOf(x.stage) >= 0)
  const doneInterviews = interviews.filter(x => liveInterviews.indexOf(x) < 0)

  // ===== 超时预警：按当前阶段 + 最后活动时间，堵"跟进不及时" =====
  const now = Date.now()
  const RULES = [
    { stages: ['待评估'], limit: 3, kind: '简历积压', act: '尽快 AI 初筛' },
    { stages: ['待初试'], limit: 2, kind: '待发邀约', act: '发邀约或淘汰' },
    { stages: ['待评估'], limit: 2, kind: '待初筛', act: '一键 AI 初筛' },
    { stages: ['待初试'], limit: 2, kind: '待邀约', act: '发初试邀约' },
    { stages: ['初试中'], limit: 3, kind: '初试无反馈', act: '录入面试评价' },
    { stages: ['待复试'], limit: 2, kind: '复试待安排', act: '安排复试' },
    { stages: ['复试中'], limit: 3, kind: '复试无反馈', act: '录入复试评价' },
    { stages: ['待发 Offer'], limit: 1, kind: 'Offer 拖延', act: '尽快发 Offer 或淘汰' },
  ]
  const alerts = []
  for (const c of s.candidates) {
    const rule = RULES.find(r => r.stages.indexOf(c.stage) >= 0)
    if (!rule || !c.updated) continue
    const days = Math.floor((now - new Date(c.updated).getTime()) / 86400000)
    if (days >= rule.limit) alerts.push({ candidateId: c.id, name: c.name, stage: c.stage, kind: rule.kind, act: rule.act, days })
  }
  alerts.sort((a, b) => b.days - a.days)

  // 校准仪表：AI 准不准、标准有没有漂移
  const corr = evAll.filter(e => e.type === 'correction.made')
  const now30 = Date.now() - 30 * 86400000
  const corr30 = corr.filter(e => new Date(e.ts).getTime() >= now30)
  const agentAssess = evAll.filter(e => e.type === 'assessment.recorded' && e.actor === 'agent').length
  const REASONS5 = ['技能被低估', '证据不足', '岗位特殊要求', '模型误判', '其他']
  const byReason = {}, byDim = {}
  for (const e of corr) { const p2 = e.payload || {}; const r2 = REASONS5.indexOf(p2.reasonCode) >= 0 ? p2.reasonCode : '其他'; byReason[r2] = (byReason[r2] || 0) + 1; const d2 = p2.dimension || '未知'; byDim[d2] = (byDim[d2] || 0) + 1 }
  const calibrationStats = {
    corrections: corr.length, last30: corr30.length, agentAssess,
    rate: agentAssess ? Math.round(corr30.length / agentAssess * 100) : 0,
    byReason, byDim,
    drift: corr30.length >= 5,
    driftMsg: corr30.length >= 5 ? '近 30 天纠偏 ' + corr30.length + ' 次，标准可能漂移——建议复盘评分卡锚点' : null,
  }
  // 近 14 天趋势（metrics.jsonl 按日快照）
  const mrows = readRows(join(d, 'metrics.jsonl'))
  const trend = mrows.slice(-14).map(m => ({ date: m.date, candidates: m.candidates, evaluated: m.evaluated, hired: m.hired, passed: (m.pipeline || []).filter(x => x.id === 'passed')[0] ? (m.pipeline.filter(x => x.id === 'passed')[0].count) : null }))

  // 实招薪资闭环：每个岗位「实际发出的 Offer 薪资」→ 校准建议
  const parseSalary = (str) => {
    // "25K×14" / "20K" / "12K" → 月薪K（×月数折算但不改月base）
    const m = String(str || '').match(/(\d+(?:\.\d+)?)\s*[kK]/)
    if (!m) return null
    return Number(m[1])
  }
  const actualPay = {}
  for (const e of evAll) {
    if (e.type !== 'offer.sent' && e.type !== 'hire.confirmed') continue
    const cid = (e.subject || {}).id
    const c0 = s.byId[cid]
    if (!c0) continue
    const k = parseSalary((e.payload || {}).salary)
    if (k == null) continue
    const pid = c0.pid || ''
    actualPay[pid] = actualPay[pid] || []
    actualPay[pid].push({ candidate: c0.name, salary: k, raw: (e.payload || {}).salary, ts: e.ts })
  }
  const actualPayList = Object.keys(actualPay).map(pid => {
    const arr = actualPay[pid]
    const ks = arr.map(x => x.salary).sort((a, b) => a - b)
    const p0 = s.positions.find(x => x.id === pid) || {}
    return {
      pid, title: p0.title || '(未关联)', count: arr.length,
      min: ks[0], max: ks[ks.length - 1],
      median: ks.length % 2 ? ks[(ks.length - 1) / 2] : Math.round((ks[ks.length / 2 - 1] + ks[ks.length / 2]) / 2 * 10) / 10,
      items: arr.slice(-6),
    }
  })

  // 候选人现薪（按岗位）：进复试/面试候选人的现薪/期望薪资 → 薪资证据链的第二源
  const currentSalaryByPid = {}
  for (const e of evAll) {
    if (e.type !== 'feedback.submitted') continue
    const p7 = e.payload || {}
    const v = p7.currentSalary
    if (typeof v !== 'number' || v <= 0) continue
    const cid = (e.subject || {}).id
    const cc = s.byId[cid]
    if (!cc || !cc.pid) continue
    currentSalaryByPid[cc.pid] = currentSalaryByPid[cc.pid] || []
    currentSalaryByPid[cc.pid].push({ name: cc.name, salary: v, note: p7.salaryNote || '', ts: e.ts })
  }
  const currentSalaryList = Object.keys(currentSalaryByPid).map(pid => {
    const arr = currentSalaryByPid[pid]; const ks = arr.map(x => x.salary).sort((a, b) => a - b)
    const p8 = s.positions.find(x => x.id === pid) || {}
    return { pid, title: p8.title || '', count: arr.length, min: ks[0], max: ks[ks.length - 1],
      median: ks.length % 2 ? ks[(ks.length - 1) / 2] : Math.round((ks[ks.length / 2 - 1] + ks[ks.length / 2]) / 2 * 10) / 10, items: arr.slice(-6) }
  })

  // 薪酬建议准确性（自校准）：每个职位「历史建议 P50」vs「实招中位」
  const advisedByPid = {}
  for (const e of evAll) {
    if (e.type !== 'salary.advised') continue
    const pid = (e.subject || {}).id
    if (!pid) continue
    const p6 = e.payload || {}
    advisedByPid[pid] = advisedByPid[pid] || []
    if (p6.P50 != null) advisedByPid[pid].push({ P50: p6.P50, ts: e.ts, source: p6.source, aiEstimate: !!p6.aiEstimate })
  }
  const salaryAccuracy = []
  for (const ap of actualPayList) {
    const advised = advisedByPid[ap.pid] || []
    if (!advised.length || ap.median == null) continue
    const last = advised[advised.length - 1]
    salaryAccuracy.push({
      pid: ap.pid, title: ap.title,
      advisedP50: last.P50, actualMedian: ap.median, actualCount: ap.count,
      diffPct: Math.round((ap.median - last.P50) / Math.max(1, last.P50) * 1000) / 10,
      aiEstimate: last.aiEstimate, source: last.source || '',
    })
  }
  const salaryCal = (function () {
    const rows = salaryAccuracy.filter(x => x.advisedP50 != null)
    if (!rows.length) return { bias: null, sample: 0, correction: null }
    const ratios = rows.map(x => (x.actualMedian - x.advisedP50) / Math.max(1, x.advisedP50))
    const bias = ratios.reduce((a, b) => a + b, 0) / ratios.length
    const correction = Math.abs(bias) >= 0.08 && rows.length >= 2
      ? { factor: Math.round((1 + bias) * 100) / 100, note: bias > 0 ? '实招普遍高于建议 ' + Math.round(bias * 100) + '%，建议按此上调' : '实招普遍低于建议 ' + Math.round(-bias * 100) + '%，建议按此下调' }
      : null
    return { bias: Math.round(bias * 1000) / 10, sample: rows.length, correction }
  })()

  // 人才库：已淘汰 + 人才库 的历史候选人（可检索、可召回）
  const talentPool = s.candidates
    .filter(c => c.stage === '人才库' || c.stage === '已淘汰')
    .map(c => {
      const sk = (function () { try { return extractSkills(c.resume || '') } catch (e) { return [] } })()
      const p3 = s.positions.find(x => x.id === c.pid) || {}
      const evs2 = evAll.filter(e => (e.subject || {}).id === c.id)
      const last = evs2[evs2.length - 1]
      const daysAgo = last ? Math.floor((Date.now() - new Date(last.ts).getTime()) / 86400000) : null
      return {
        id: c.id, name: c.name, stage: c.stage, route: c.route || '', pid: c.pid || '',
        positionTitle: p3.title || '', source: c.source || '',
        skills: sk.map(x => x.name).slice(0, 14),
        skillGroups: Array.from(new Set(sk.map(x => x.group))),
        daysAgo, summary: (c.summary || '').slice(0, 80),
        decisionReason: (c.decisionReason || '').slice(0, 100),
        // 人才库不携带历史评级/分数：复捞应回到同一起始点，按新岗位重新评估（公平性）
      }
    })

  // AI 与人判断的偏差（自迭代核心）：AI 判档 vs 人定档，按维度统计
  const aiAlignment = (function () {
    const LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3 }
    const stat = {}
    // 每个候选人：取其 assessment 的 AI 档位 + 后续 feedback 的人定档位
    const byCand2 = {}
    for (const e of evAll) {
      const id2 = (e.subject || {}).id
      if (!id2) continue
      byCand2[id2] = byCand2[id2] || { ai: null, human: null }
      if (e.type === 'assessment.recorded' && e.actor === 'agent') {
        const al = (e.payload || {}).deep && (e.payload.deep.alignment || [])
        if (al && al.length) { byCand2[id2].ai = {}; for (const a of al) byCand2[id2].ai[a.dim] = a.level }
      }
      if (e.type === 'feedback.submitted' && (e.payload || {}).dims) {
        byCand2[id2].human = {}
        for (const d of e.payload.dims) byCand2[id2].human[d.dim] = d.level
      }
      if (e.type === 'ai_interview.completed' && (e.payload || {}).dims) {
        byCand2[id2].ai = byCand2[id2].ai || {}
        for (const d of e.payload.dims) byCand2[id2].ai[d.dim] = d.level
      }
    }
    for (const id2 of Object.keys(byCand2)) {
      const g2 = byCand2[id2]
      if (!g2.ai || !g2.human) continue
      for (const dim of Object.keys(g2.human)) {
        if (g2.ai[dim] == null) continue
        const a = LEVEL[g2.ai[dim]], h2 = LEVEL[g2.human[dim]]
        if (a == null || h2 == null) continue
        stat[dim] = stat[dim] || { dim, n: 0, agree: 0, diff1: 0, diff2: 0, aiHigher: 0 }
        stat[dim].n++
        if (a === h2) stat[dim].agree++
        else if (Math.abs(a - h2) === 1) { stat[dim].diff1++; if (a > h2) stat[dim].aiHigher++ }
        else { stat[dim].diff2++; if (a > h2) stat[dim].aiHigher++ }
      }
    }
    const dims = Object.values(stat).map(x => ({
      dim: x.dim, n: x.n, agreeRate: x.n ? Math.round(x.agree / x.n * 100) : null,
      diff1: x.diff1, diff2: x.diff2, aiHigher: x.aiHigher,
      note: x.aiHigher > (x.n - x.aiHigher) ? 'AI 普遍判得偏高' : (x.aiHigher * 2 < x.n ? 'AI 普遍判得偏低' : '高低互见'),
    })).sort((a, b) => (a.agreeRate == null ? 101 : a.agreeRate) - (b.agreeRate == null ? 101 : b.agreeRate))
    const total = dims.reduce((acc, x) => { acc.n += x.n; acc.agree += Math.round((x.agreeRate || 0) * x.n / 100); return acc }, { n: 0, agree: 0 })
    return { dims, overall: total.n ? Math.round(total.agree / total.n * 100) : null, samples: total.n }
  })()

  // ===== 结论级闭环：AI 初筛等级 × 后续面试实际结果 =====
  // 回答"AI 判 S/A 放行的人，面试真的通过了吗？"——不是维度分，是结论准不准。
  // AI 结论(S/A=推荐进面, B=留人, C=淘汰) vs 面试官/HR 的最终通过与否，验证筛选标准。
  const aiVsInterviewer = (function () {
    const byCand3 = {}
    for (const e of evAll) {
      const id3 = (e.subject || {}).id
      if (!id3) continue
      byCand3[id3] = byCand3[id3] || { aiGrade: null, latestPass: null, rounds: 0 }
      if (e.type === 'assessment.recorded' && e.actor === 'agent') {
        const p = e.payload || {}
        const g = (p.deep && p.deep.grade) || (String(p.route || '').match(/([SABC])\s*级/) || [])[1]
        if (g) byCand3[id3].aiGrade = String(g).toUpperCase()
      }
      if (e.type === 'feedback.submitted') {
        const p = e.payload || {}
        if (p.pass != null) { byCand3[id3].latestPass = p.pass !== false; byCand3[id3].rounds++ }
      }
    }
    const groups = { S: { n: 0, pass: 0 }, A: { n: 0, pass: 0 }, B: { n: 0, pass: 0 }, C: { n: 0, pass: 0 } }
    let total = 0, totalPass = 0
    for (const id3 of Object.keys(byCand3)) {
      const g3 = byCand3[id3]
      if (!g3.aiGrade || g3.latestPass == null) continue   // 只统计"AI判过且有面试结论"的人
      const grp = groups[g3.aiGrade]; if (!grp) continue
      grp.n++; if (g3.latestPass) grp.pass++
      total++; if (g3.latestPass) totalPass++
    }
    const out = Object.keys(groups).map(g => ({ grade: g, n: groups[g].n, pass: groups[g].pass, passRate: groups[g].n ? Math.round(groups[g].pass / groups[g].n * 100) : null }))
    return { groups: out, total, totalPass, overallPassRate: total ? Math.round(totalPass / total * 100) : null }
  })()

  // 引入能力的使用统计（诚实口径：可验证的候选人数据）
  const aiExtra = (() => {
    let ocr = 0, withRead = 0, withSkills = 0, withGap = 0, gapSum = 0, gapN = 0
    for (const c of s.candidates) {
      const pa = c.parse || {}
      if (pa.ocr) ocr++
      if (pa.readability && typeof pa.readability.score === 'number') withRead++
      try {
        const sk = extractSkills(c.resume || '')
        if (sk.length) withSkills++
        const p2 = s.positions.find(x => x.id === c.pid)
        if (p2 && sk.length) { const g2 = skillGap(sk, jobSkillDemand(p2)); if (g2.rate != null) { withGap++; gapSum += g2.rate; gapN++ } }
      } catch (e) {}
    }
    return { ocr, readability: withRead, skills: withSkills, gap: withGap, gapAvg: gapN ? Math.round(gapSum / gapN) : null }
  })()

  return {
    generatedAt: new Date().toISOString(),
    dashboard, inbox: items, selectedId, detail, candidates,
    interviews: liveInterviews, interviewsDone: doneInterviews.slice(0, 8), alerts, trend, calibrationStats, aiExtra, aiAlignment, talentPool, actualPayList, currentSalaryList, salaryAccuracy, salaryCal, aiVsInterviewer,
    positions: s.positions.map(p => ({ id: p.id, title: p.title, dept: p.dept, city: p.city, hc: p.hc, band: p.band, status: p.status, gates: p.gates, abilities: p.abilities, jd: p.jd || '' })),
    standards: standardVersions(d),
    contracts: { human: HUMAN_CONTRACT, machine: MACHINE_CONTRACT },
  }
}

/**
 * 执行一个动作。返回 {ok, seq, ...}；契约不满足时 throw。
 * a: {action, candidateId, decision, reason, reasonCode, dimension, note, basedOn}
 */
export function performAction(d, a) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  migrateLegacy(d)
  const action = String(a.action || '')
  const s = fold(d)
  const c = a.candidateId ? s.byId[a.candidateId] : null
  const NO_CANDIDATE = ['create_position', 'generate_jd', 'update_position', 'reopen_position', 'close_position', 'salary_advised']
  if (NO_CANDIDATE.indexOf(action) < 0 && !c) throw new Error('candidate not found: ' + a.candidateId)

  const lastSeq = c && c.seqs ? c.seqs[c.seqs.length - 1] : null
  const humanEvent = (decision, reason, extra) => appendEvent(d, {
    type: 'decision.made', actor: 'human', actorId: 'hr',
    subject: { kind: 'candidate', id: c.id },
    payload: { decision, reason: reason || '', from: c.stage, ...(extra || {}) },
    basedOn: { ...DEFAULT_BASED_ON, ...(a.basedOn || {}) },
    inputHash: hash(c.resume), causedBy: lastSeq,
  })

  switch (action) {
    case 'fix_name': {
      const nn = String(a.name || '').trim()
      if (!nn) throw new Error('新姓名不能为空')
      const ev = appendEvent(d, { type: 'name.fixed', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { name: nn, from: c.name }, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, action, message: `${c.name} → ${nn}` }
    }
    case 'generate_jd': {
      // 同步规则版 JD（工具侧兜底；界面走 /generate-jd 端点可用 LLM）
      const jd = ruleJD({
        title: a.title, dept: a.dept, city: a.city, headcount: a.headcount,
        band: [numK(a.bandMin), numK(a.bandMax)], gates: a.gates, abilities: a.abilities,
        businessContext: a.businessContext,
      })
      jd.title = a.title || ''; jd.dept = a.dept || ''; jd.city = a.city || ''
      jd.band = (a.bandMin || a.bandMax) ? ((a.bandMin || 0) + '–' + (a.bandMax || 0) + 'K') : ''
      return { ok: true, jd, markdown: jdToMarkdown(jd), source: 'rule' }
    }
    case 'update_position': {
      const s2 = fold(d)
      const exist = s2.positions.find(x => x.id === a.positionId)
      if (!exist) throw new Error('position not found: ' + a.positionId)
      const patch = {}
      const fields = ['title', 'dept', 'city', 'headcount', 'bandMin', 'bandMax', 'gates', 'abilities', 'standard', 'jd', 'jdObj', 'scorecard', 'scorecardMarkdown', 'status', 'expYears']
      // 只覆盖传入的字段
      if (a.title != null) patch.title = String(a.title).trim()
      if (a.dept != null) patch.dept = a.dept
      if (a.city != null) patch.city = a.city
      if (a.headcount != null) patch.hc = a.headcount
      if (a.bandMin != null || a.bandMax != null) patch.band = [numK(a.bandMin), numK(a.bandMax)]
      if (a.gates != null) patch.gates = Array.isArray(a.gates) ? a.gates : String(a.gates || '').split(/[、,，\n]/).map(x => x.trim()).filter(Boolean)
      if (a.abilities != null) patch.abilities = Array.isArray(a.abilities) ? a.abilities : String(a.abilities || '').split(/[、,，\n>]/).map(x => x.trim()).filter(Boolean)
      if (a.standard != null) patch.standard = a.standard
      if (a.jd != null) patch.jd = a.jd
      if (a.jdObj !== undefined) patch.jdObj = a.jdObj
      if (a.scorecard !== undefined) patch.scorecard = a.scorecard
      if (a.scorecardMarkdown != null) patch.scorecardMarkdown = a.scorecardMarkdown
      if (a.status != null) patch.status = a.status
      if (a.expYears != null) patch.expYears = a.expYears
      if (a.context !== undefined) patch.context = a.context
      if (patch.title === '') throw new Error('职位名称不能为空')
      const ev = appendEvent(d, { type: 'position.updated', actor: 'human', subject: { kind: 'position', id: a.positionId }, payload: patch })
      return { ok: true, seq: ev.seq, positionId: a.positionId, title: patch.title || exist.title }
    }
    case 'create_position': {
      const title = String(a.title || '').trim()
      if (!title) throw new Error('职位名称必填')
      const p = {
        id: 'P' + Date.now().toString(36), title,
        dept: a.dept || '', city: a.city || '', hc: a.headcount || 1,
        band: [numK(a.bandMin), numK(a.bandMax)], status: '在招',
        gates: Array.isArray(a.gates) ? a.gates : String(a.gates || '').split(/[、,，\n]/).map(x => x.trim()).filter(Boolean),
        abilities: Array.isArray(a.abilities) ? a.abilities : String(a.abilities || '').split(/[、,，\n>]/).map(x => x.trim()).filter(Boolean),
        standard: a.standard || '',
        jd: a.jd || '',
        jdRaw: a.jdRaw || '',
        jdObj: a.jdObj || null,
        scorecard: a.scorecard || null,
        scorecardMarkdown: a.scorecardMarkdown || '',
        context: a.context || null,   // 隐性业务上下文：{stage, teamGap, culture, dealBreakers}
      }
      const ev = appendEvent(d, { type: 'position.created', actor: 'human', subject: { kind: 'position', id: p.id }, payload: p })
      return { ok: true, seq: ev.seq, positionId: p.id, title }
    }
    case 'reopen_position': {
      // 历史职位复开（离职替补/扩编/滚招）：复制历史职位，保留 JD/评分卡/薪资，清空招聘进度
      const src2 = s.positions.find(x => x.id === a.positionId)
      if (!src2) throw new Error('原职位不存在：' + a.positionId)
      const p2 = {
        id: 'P' + Date.now().toString(36),
        title: a.title || src2.title, dept: src2.dept || '', city: src2.city || '',
        hc: a.headcount || src2.hc || 1,
        band: src2.band || [0, 0],
        status: '在招', gates: src2.gates || [], abilities: src2.abilities || [],
        standard: src2.standard || '', jd: src2.jd || '', jdRaw: src2.jdRaw || '', scorecard: src2.scorecard || null,
        scorecardMarkdown: src2.scorecardMarkdown || '',
        context: src2.context || null,
        parentId: src2.id, source: 'reopen',
      }
      const ev = appendEvent(d, { type: 'position.created', actor: 'human', subject: { kind: 'position', id: p2.id },
        payload: p2, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, positionId: p2.id, title: p2.title, reopenedFrom: src2.id,
        message: '已从「' + src2.title + '」复开（保留 JD 与评分卡，招聘进度重新开始）' }
    }
    case 'close_position': {
      const p3 = s.positions.find(x => x.id === a.positionId)
      if (!p3) throw new Error('职位不存在：' + a.positionId)
      // 关岗前检查在途：必须处理，否则产生孤儿单
      const TERMINAL = ['已入职', 'Offer拒绝', '已淘汰', '人才库']
      const inFlight = s.candidates.filter(c => c.pid === p3.id && TERMINAL.indexOf(c.stage) < 0)
      const disposition = String(a.disposition || '').trim()  // transfer | talent | eliminate | keep
      if (inFlight.length && !disposition) {
        return { ok: false, needDisposition: true, inFlightCount: inFlight.length,
          candidates: inFlight.map(c => ({ id: c.id, name: c.name, stage: c.stage })),
          message: '该职位有 ' + inFlight.length + ' 名候选人在途，关闭前需指定去向（转岗/进人才库/淘汰/保留跟随）' }
      }
      const ev = appendEvent(d, { type: 'position.updated', actor: 'human', subject: { kind: 'position', id: p3.id },
        payload: { status: a.status || '已关闭', reason: a.reason || '关闭招聘' }, causedBy: lastSeq })
      // 处理在途
      let handled = 0
      if (inFlight.length && disposition) {
        for (const c of inFlight) {
          if (disposition === 'talent') {
            appendEvent(d, { type: 'decision.made', actor: 'human', subject: { kind: 'candidate', id: c.id },
              payload: { decision: '人才库', reason: '岗位关闭，转入人才库（' + p3.title + '）', auto: false }, causedBy: ev.seq })
          } else if (disposition === 'eliminate') {
            appendEvent(d, { type: 'decision.made', actor: 'human', subject: { kind: 'candidate', id: c.id },
              payload: { decision: '淘汰', reason: '岗位关闭，流程终止（' + p3.title + '）', auto: false }, causedBy: ev.seq })
          } else if (disposition === 'transfer') {
            // 转岗需指定目标职位
            const target = String(a.transferToPositionId || '').trim()
            if (!target) throw new Error('转岗需指定目标职位（transferToPositionId）')
            appendEvent(d, { type: 'candidate.bound', actor: 'human', subject: { kind: 'candidate', id: c.id }, payload: { pid: target, forced: true }, causedBy: ev.seq })
          }
          // keep: 保留跟随（不动，仍挂原岗位，但岗位已关——提示后续处理）
          handled++
        }
      }
      const st3 = a.status || '已关闭'
      const msg = inFlight.length
        ? '职位' + st3 + '，在途 ' + inFlight.length + ' 人已处理（' + ({ transfer: '转岗', talent: '进人才库', eliminate: '淘汰', keep: '保留跟随' }[disposition] || '') + '）'
        : '职位' + st3
      return { ok: true, seq: ev.seq, positionId: p3.id, status: a.status || '已关闭', handled, message: msg }
    }
    case 'auto_assess': {
      // AI 初筛：必须先关联岗位，否则评分无意义
      const p = s.positions.find(x => x.id === c.pid)
      if (!p) throw new Error('候选人未关联岗位，无法评估。请先在「职位管理」绑定岗位，或上传时指定岗位。')
      // 技术栈硬门槛：方向不对口直接 C 级（技能库单一口径）
      const sf = (function () { try { return stackFit(p, c.resume || '') } catch (e) { return null } })()
      const out = autoAssess(c.resume, p)
      if (sf && sf.fit === 'mismatch') {
        out.scores = {}
        out.weighted = 20
        out.route = 'C 级 · 技术栈不对口'
        out.conf = 0.9
        out.summary = '技术栈不对口｜' + sf.reason
        out.conclusion = 'reject'
        out.gateResults = [{ gate: '核心技术栈：' + (sf.jobStack || ''), verdict: 'fail', reason: sf.reason }]
        out.doubts = ['技术方向与岗位要求不符']
        out.undetermined = Object.keys(out.scores || {})
      }
      const ev = recordAssessment(d, {
        candidateId: c.id,
        scores: out.scores, conf: out.conf, route: out.route, evidence: out.evidence,
        undetermined: out.undetermined, doubts: out.doubts, summary: out.summary,
        gateResults: out.gateResults || [], weighted: out.weighted,
        action: out.action || '', conclusion: out.conclusion || '',
        deep: { engine: 'autoAssess', grade: out.grade || '', score: out.weighted, stackFit: sf || undefined },
        evidenceList: Object.values(out.evidence).filter(Boolean),
        basedOn: { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'autoAssess', prompt: 'v1' },
        inputHash: hash(c.resume || ''), causedBy: lastSeq,
      })
      // 评估即分流（三段式，与用户确认的路径一致）：
      //   S/A → 待初试（AI 直接放行）；C → 已淘汰（进人才库可激活）；B → 待评估（留人判断）
      const r2 = String(out.route || '')
      // 统一口径：等级优先取 BARS 的 grade，其次 route 里的等级，最后按分数换算（规则引擎也必须有明确等级）
      let grade = String((out.deep && out.deep.grade) || (r2.match(/([SABC])\s*级/) || [])[1] || '').toUpperCase()
      if (['S','A','B','C'].indexOf(grade) < 0) {
        const sc = (typeof out.weighted === 'number') ? out.weighted : (out.deep && out.deep.score)
        if (typeof sc === 'number') grade = gradeFromScore(sc)
      }
      // 硬门槛一票否决：有明确证据的 fail 项 → 直接淘汰（最高优先级，不受"缺证据"影响）
      const hardFail = (out.gateResults || []).some(g => g.verdict === 'fail')
      // 缺关键证据的人（且硬门槛未 fail）：即使分数低也不直接淘汰——留人复核（否则误杀"简历没写全但其实合格"的人）
      const insufficient = !hardFail && (/待补充|缺.*证据|未判定|证据不足/.test(r2) || (Array.isArray(out.undetermined) && out.undetermined.length > 0))
      // 分流：硬门槛 fail 或 grade=C → 淘汰；S/A → 初试；其余 → 待评估
      const isNo = hardFail || (!insufficient && (grade ? grade === 'C' : /C 级|不对口|不推荐|不建议/.test(r2)))
      const isSA = !hardFail && !insufficient && (grade ? (grade === 'S' || grade === 'A') : /S 级|A 级/.test(r2))
      const canAdv = ['待评估', '待初试', '待发 Offer'].indexOf(c.stage) >= 0
      if (canAdv) {
        if (isNo) {
          // C 级自动淘汰：按契约记为「授权自动化」的 decision.made（actor=agent, auto, reversible），可追溯可复捞
          appendEvent(d, { type: 'decision.made', actor: 'agent', actorId: 'ai-auto', subject: { kind: 'candidate', id: c.id },
            payload: { decision: '淘汰', reason: (hardFail ? ('硬门槛未通过：' + (out.gateResults || []).filter(g => g.verdict === 'fail').map(g => g.gate).join('、')) : ('AI 初筛不合格（' + (out.route || '') + '）')) + ' · 授权自动化，可激活复捞', from: c.stage, auto: true, reversible: true, grade: hardFail ? 'C' : (grade || 'C') }, causedBy: ev.seq })
        } else {
          const to = isSA ? '待初试' : '待评估'   // S/A 进初试；B/低置信/缺证据留人判断
          const why = insufficient ? ('缺关键证据，需人复核（' + (out.undetermined || []).join('、') + '）') : ('AI 初筛（' + (out.route || '') + '）')
          appendEvent(d, { type: 'stage.advanced', actor: 'agent', subject: { kind: 'candidate', id: c.id },
            payload: { to, reason: why + ' → ' + to, needsReview: insufficient || undefined }, causedBy: ev.seq })
        }
      }
      return { ok: true, seq: ev.seq, action, candidateId: c.id, route: out.route, conf: out.conf,
        scores: out.scores, undetermined: out.undetermined, doubts: out.doubts, to: canAdv ? (isNo ? '已淘汰' : (isSA ? '待初试' : '待评估')) : null }
    }
    case 'salary_advised': {
    const p5 = s.positions.find(x => x.id === a.positionId)
    if (!p5) throw new Error('职位不存在')
    const ev = appendEvent(d, {
      type: 'salary.advised', actor: 'agent', subject: { kind: 'position', id: a.positionId },
      payload: { P25: a.P25, P50: a.P50, P75: a.P75, source: a.source || '', aiEstimate: !!a.aiEstimate,
        bandMin: a.bandMin, bandMax: a.bandMax, title: p5.title },
      basedOn: { rule: 'salary-benchmark-v1' }, causedBy: lastSeq,
    })
    return { ok: true, seq: ev.seq }
  }
  case 'request_assess': {
      // 界面不自己算分；写一条请求事件，并交给 Agent 读原文判断。
      const ev = appendEvent(d, {
        type: 'assessment.requested', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { candidateId: c.id, positionId: c.pid, name: c.name },
        causedBy: lastSeq,
      })
      return {
        ok: true, seq: ev.seq, candidateId: c.id,
        prompt: '请用 recruit_evaluation_packet 读取候选人 ' + c.id + '（' + c.name + '）的简历原文与评分卡，逐维给出可引用证据，缺证据判未判定，然后用 recruit_record_assessment 落库。不要用公式算分，不要自动淘汰。',
      }
    }
    case 'invite': {
    // 时间显示格式化：ISO → 3月5日 14:00
    const fAt = (v) => {
      const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
      return m ? (parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日 ' + m[4] + ':' + m[5]) : String(v || '')
    }
      const pos = s.positions.find(x => x.id === c.pid) || {}
      const round = c.stage === '待复试' ? '复试' : '初试'
      const at = fAt(a.at) || '（待与候选人确认时间）'
      const place = a.place || (a.channel === '腾讯会议' ? '腾讯会议（链接另行发送）' : '公司面试间')
      const text = String(a.text || '').trim() || ('【' + (pos.title || '面试') + '·' + round + '邀约】' +
        (c.name || '您') + '您好，感谢投递。诚邀您参加' + round + '。\n时间：' + at + '\n地点/方式：' + place + '\n请回复确认，如需调整请告知。期待与您交流！')
      const ev = appendEvent(d, {
        type: 'invite.sent', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { channel: a.channel || '微信', text, round, at, place, rawAt: a.at || '' }, causedBy: lastSeq,
      })
      // 邀约即完成面试排期：带了具体时间 → 同步写 interview.scheduled（进日历待办）+ 推进到初试中/复试中
      let to = null
      const ivToken = 'IV' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      if (a.at) {
        const toStage = c.stage === '待复试' ? '复试中' : '初试中'
        const iev = appendEvent(d, { type: 'interview.scheduled', actor: 'human', subject: { kind: 'candidate', id: c.id },
          payload: { at: a.at || '', interviewer: a.interviewer || '', place, channel: a.channel || '', round, source: 'invite', token: ivToken }, causedBy: ev.seq })
        if (['待初试', '待复试'].indexOf(c.stage) >= 0) {
          appendEvent(d, { type: 'stage.advanced', actor: 'human', subject: { kind: 'candidate', id: c.id },
            payload: { to: toStage, reason: round + '邀约已发（' + at + '），进入' + toStage }, causedBy: iev.seq })
          to = toStage
        }
      }
      return { ok: true, seq: ev.seq, to, interviewToken: a.at ? ivToken : null, message: '已发' + round + '邀约（' + (a.channel || '微信') + '）' + (a.at ? '，排期已同步到面试日程' : '，可复制发送') }
    }
    case 'interview': {
      // 排面试：待初试→初试中；待复试→复试中
      const to = c.stage === '待复试' ? '复试中' : (c.stage === '待初试' ? '初试中' : null)
      const ev = appendEvent(d, {
        type: 'interview.scheduled', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { at: a.at || '', interviewer: a.interviewer || '', place: a.place || '', channel: a.channel || '', round: to === '复试中' ? '复试' : '初试', token: 'IV' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }, causedBy: lastSeq,
      })
      if (to) appendEvent(d, { type: 'stage.advanced', actor: 'human', subject: { kind: 'candidate', id: c.id }, payload: { to, reason: '已安排' + (to === '复试中' ? '复试' : '初试') }, causedBy: ev.seq })
      return { ok: true, seq: ev.seq, to, message: '已排' + (to === '复试中' ? '复试' : '初试') }
    }
    case 'feedback': {
      // 录面评并推进：初试中→待复试；复试中→待发 Offer
      const ev = appendEvent(d, {
        type: 'feedback.submitted', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { score: a.score == null ? null : Number(a.score), note: a.note || '', round: c.stage === '复试中' ? '复试' : (c.stage === '初试中' ? '初试' : 'AI初面'), pass: a.pass !== false, dims: a.dims || null,
          currentSalary: (() => { const m = String(a.currentSalary || '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null })(),
          salaryNote: a.salaryNote || '' }, causedBy: lastSeq,
      })
      let to = null
      if (c.stage === '待初试') to = a.pass === false ? '已淘汰' : '待复试'
      else if (c.stage === '初试中') to = a.pass === false ? '已淘汰' : '待复试'
      else if (c.stage === '复试中') to = a.pass === false ? '已淘汰' : '待背调'
      if (to) appendEvent(d, { type: 'stage.advanced', actor: 'human', subject: { kind: 'candidate', id: c.id }, payload: { to, reason: (c.stage === '待初试' ? 'AI初面' : c.stage === '初试中' ? '初试' : '复试') + (a.pass === false ? '未通过' : '通过') }, causedBy: ev.seq })
      return { ok: true, seq: ev.seq, to, message: '面评已录，' + (to ? '进入 ' + to : '') }
    }
    case 'background_check': {
      // 背调结论：pass→待发Offer；fail→淘汰；skip→待发Offer（岗位不要求背调）
      const result = String(a.result || 'pass')   // pass | fail | skip
      const note = String(a.note || '').trim()
      const ev = appendEvent(d, { type: 'background.check', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { result, note }, causedBy: lastSeq })
      let to = null
      if (result === 'fail') {
        appendEvent(d, { type: 'decision.made', actor: 'human', subject: { kind: 'candidate', id: c.id },
          payload: { decision: '淘汰', reason: '背调不通过' + (note ? '：' + note : ''), auto: false }, causedBy: ev.seq })
        to = '已淘汰'
      } else {
        appendEvent(d, { type: 'stage.advanced', actor: 'human', subject: { kind: 'candidate', id: c.id },
          payload: { to: '待发 Offer', reason: (result === 'skip' ? '免背调' : '背调通过') + (note ? '：' + note : '') }, causedBy: ev.seq })
        to = '待发 Offer'
      }
      return { ok: true, seq: ev.seq, to, message: '背调' + (result === 'fail' ? '不通过 → 已淘汰' : '通过 → 可发 Offer') }
    }
    case 'send_offer': {
      const ev = appendEvent(d, {
        type: 'offer.sent', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { salary: a.salary || '', note: a.note || '', startDate: a.startDate || '' }, causedBy: lastSeq,
      })
      return { ok: true, seq: ev.seq, to: 'Offer已发', message: 'Offer 已发出' + (a.startDate ? '（预计 ' + a.startDate + ' 入职）' : '') }
    }
    case 'offer_accept': {
      // 候选人接受 Offer
      const ev = appendEvent(d, { type: 'offer.accepted', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { salary: a.salary || '', note: a.note || '' }, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, to: 'Offer已接受', message: c.name + ' 已接受 Offer' }
    }
    case 'offer_decline': {
      // Offer 被拒 / 候选人放弃 —— 必须留原因（招聘风险最高的一段）
      const reason = String(a.reason || '').trim()
      if (!reason) throw new Error('HUMAN_CONTRACT: Offer 被拒必须记录原因（薪资/竞品/家庭/其他）')
      const ev = appendEvent(d, { type: 'offer.declined', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { reason, note: a.note || '' }, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, to: 'Offer拒绝', message: c.name + ' Offer 被拒：' + reason }
    }
    case 'schedule_onboarding': {
      // 安排入职（发报到通知）
      const startDate = String(a.startDate || '').trim()
      const ev = appendEvent(d, { type: 'onboarding.scheduled', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { startDate, note: a.note || '' }, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, to: '待入职', message: '已安排入职' + (startDate ? '：' + startDate : '') }
    }
    case 'hire': {
      const reason = String(a.reason || '').trim()
      if (!reason) throw new Error('入职必须留确认信息')
      // 写 hire.confirmed（供到岗周期/已入职统计），并保留 decision 语义
      const ev = appendEvent(d, { type: 'hire.confirmed', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { reason, startDate: a.startDate || '', salary: a.salary || '' }, causedBy: lastSeq })
      return { ok: true, seq: ev.seq, to: '已入职', message: c.name + ' 已入职' }
    }
    case 'decide': {
      if (HUMAN_CONTRACT.decisions.indexOf(a.decision) < 0) throw new Error('HUMAN_CONTRACT: unknown decision ' + a.decision)
      const reason = String(a.reason || '').trim()
      if ((a.decision === '淘汰' || a.decision === 'Offer') && !reason) throw new Error('HUMAN_CONTRACT: 淘汰/Offer 必须留理由')
      const ev = humanEvent(a.decision, reason)
      return { ok: true, seq: ev.seq, action, decision: a.decision, to: DECISIONS[a.decision], message: `${c.name} → ${DECISIONS[a.decision]}` }
    }
    case 'calibrate': {
      if (HUMAN_CONTRACT.corrections.indexOf(a.reasonCode) < 0) throw new Error('HUMAN_CONTRACT: 纠偏必须五选一原因码')
      const dim = String(a.dimension || '').trim()
      if (!dim) throw new Error('HUMAN_CONTRACT: 纠偏必须带维度')
      const corr = appendEvent(d, {
        type: 'correction.made', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { dimension: dim, reasonCode: a.reasonCode, note: a.note || '', candidateId: c.id },
        causedBy: lastSeq,
      })
      const v = standardVersions(d)
      const cluster = v.calibrationClusters.find(x => x.key === `${dim} × ${a.reasonCode}`)
      let proposal = null
      if (cluster && cluster.count >= 3) {
        proposal = appendEvent(d, {
          type: 'standard.proposed', actor: 'system', subject: { kind: 'standard', id: 'L0' },
          payload: { dimension: dim, reasonCode: a.reasonCode, clusterCount: cluster.count, note: '达到聚类阈值，待回归重放验证后发布新版本' },
          causedBy: corr.seq,
        })
      }
      return { ok: true, seq: corr.seq, action, proposalSeq: proposal ? proposal.seq : null, message: `校准样本已入池（${a.reasonCode} / ${dim}）` + (proposal ? '，已生成规范变更建议' : '') }
    }
    case 'adopt': {
      if (/淘汰|拒绝|reject/i.test(String(c.route || ''))) throw new Error('MACHINE_CONTRACT: AI 结论含淘汰，必须人工拍板，不能采纳')
      const ev = humanEvent('面', '采纳 AI 建议，进入面试')
      return { ok: true, seq: ev.seq, action, to: DECISIONS['面'], message: `已采纳建议，${c.name} → ${DECISIONS['面']}` }
    }
    case 'ask': {
      const note = String(a.note || '').trim()
      if (!note) throw new Error('HUMAN_CONTRACT: 补一句必须写明要补什么')
      const ev = humanEvent('补一句', note)
      return { ok: true, seq: ev.seq, action, to: DECISIONS['补一句'], message: `已发出追问：${note.slice(0, 40)}` }
    }
    case 'override': {
      if (HUMAN_CONTRACT.corrections.indexOf(a.reasonCode) < 0) throw new Error('HUMAN_CONTRACT: 改判必须五选一原因码')
      const dim = String(a.dimension || '').trim()
      if (!dim) throw new Error('HUMAN_CONTRACT: 纠偏必须带维度')
      const note = String(a.note || '').trim()
      // 改判 = AI 原判 X → 人认为 Y，成对记录（X≠Y 才成立，否则不算改判）
      const kind = String(a.overrideKind || '档位改判')
      const from = a.from != null ? String(a.from) : ''
      const to = a.to != null ? String(a.to) : ''
      if (kind === '档位改判') {
        if (!from || !to) throw new Error('档位改判必须记录 AI 原判档位与改成档位')
        if (from === to) throw new Error('改成与原判相同，不构成改判')
      }
      if (kind === '硬门槛推翻' && !note) throw new Error('推翻硬门槛必须写明破格依据')
      const corr = appendEvent(d, {
        type: 'correction.made', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: { dimension: dim, reasonCode: a.reasonCode, note, candidateId: c.id, overrideKind: kind, from, to },
        causedBy: lastSeq,
      })
      const decision = a.decision || '补一句'
      if (HUMAN_CONTRACT.decisions.indexOf(decision) < 0) throw new Error('HUMAN_CONTRACT: unknown decision')
      const ev = humanEvent(decision, `人工改判：${a.reasonCode} / ${dim}${note ? ' · ' + note : ''}`, { causedByCorrection: corr.seq })
      const v = standardVersions(d)
      const cluster = v.calibrationClusters.find(x => x.key === `${dim} × ${a.reasonCode}`)
      let proposal = null
      if (cluster && cluster.count >= 3) {
        proposal = appendEvent(d, {
          type: 'standard.proposed', actor: 'system', subject: { kind: 'standard', id: 'L0' },
          payload: { dimension: dim, reasonCode: a.reasonCode, clusterCount: cluster.count, note: '达到聚类阈值，待回归重放验证后发布新版本' },
          causedBy: corr.seq,
        })
      }
      return { ok: true, seq: ev.seq, correctionSeq: corr.seq, proposalSeq: proposal ? proposal.seq : null, action, to: DECISIONS[decision], message: `已改判并写入校准池（${a.reasonCode} / ${dim}）` + (proposal ? '，已生成规范变更建议' : '') }
    }
    case 'eliminate':
    case 'offer': {
      const decision = action === 'eliminate' ? '淘汰' : 'Offer'
      const reason = String(a.reason || '').trim()
      if (!reason) throw new Error(`HUMAN_CONTRACT: ${decision} 必须留理由`)
      const ev = humanEvent(decision, reason, { impact: impactOf(d, c.id).summary })
      // 发 Offer 是业务事实：无论哪条 UI 路径，都必须写 offer.sent（薪资入账、Offer 环统计、接受率依赖它）
      if (decision === 'Offer') {
        appendEvent(d, { type: 'offer.sent', actor: 'human', subject: { kind: 'candidate', id: c.id },
          payload: { salary: a.salary || '', note: reason }, causedBy: ev.seq })
      }
      return { ok: true, seq: ev.seq, action, decision, to: DECISIONS[decision], message: `${c.name} → ${DECISIONS[decision]}（已留痕：${reason.slice(0, 30)}）` }
    }
    case 'bind_position': {
      const pid = String(a.positionId || '').trim()
      if (!pid) throw new Error('请选择要绑定的岗位')
      const pos = s.positions.find(x => x.id === pid)
      if (!pos) throw new Error('岗位不存在: ' + pid)
      // 绑定时前置技术栈校验：方向不符则拒绝（除非显式 force）
      const fit = techStackFit(pos, c.resume || '')
      if (fit.fit === 'mismatch' && !a.force) {
        return { ok: false, mismatch: true, reason: fit.reason, needConfirm: true,
          message: '候选人与「' + pos.title + '」技术栈不对口：' + fit.reason + '。确认要强制绑定吗？' }
      }
      const ev = appendEvent(d, { type: 'candidate.bound', actor: 'human', subject: { kind: 'candidate', id: c.id }, payload: { pid, forced: fit.fit === 'mismatch' ? true : undefined, stackFit: fit.fit }, causedBy: lastSeq })
      // 人只做「匹配岗位」这一步；匹配完 AI 自动初筛并按结论分流（AI 能力，无需再点按钮）
      let screen = null
      try {
        const r = performAction(d, { action: 'auto_assess', candidateId: c.id })
        screen = { route: r.route, to: r.to || null }
      } catch (e) { screen = { error: String((e && e.message) || e) } }
      const stageNow = (fold(d).byId[c.id] || {}).stage
      return { ok: true, seq: ev.seq, action, positionId: pid, screen, stage: stageNow,
        message: c.name + ' 已绑定「' + pos.title + '」' + (screen && screen.route ? '，AI 初筛：' + screen.route + (screen.to ? ' → ' + screen.to : '') : '') }
    }
    case 'activate': {
      // 回溯激活：从人才库 / 已淘汰 / 历史留档把候选人重新拉回流程。
      const reason = String(a.reason || '').trim()
      if (!reason) throw new Error('HUMAN_CONTRACT: 重新激活必须写明原因')
      const ev = appendEvent(d, {
        type: 'stage.advanced', actor: 'human', actorId: 'hr',
        subject: { kind: 'candidate', id: c.id },
        payload: { to: '待评估', reason, reactivatedFrom: c.stage },
        causedBy: lastSeq,
      })
      return { ok: true, seq: ev.seq, action, to: '待评估', from: c.stage, message: `${c.name} 已从 ${c.stage} 重新激活 → 待评估` }
    }
    case 'backfill': {
      // 扫描件/图片简历：补录文本后可进入正常评估链路。
      const text = String(a.text || '').trim()
      if (!text) throw new Error('补录文本不能为空')
      const ev = appendEvent(d, {
        type: 'resume.backfilled', actor: 'human', actorId: 'hr',
        subject: { kind: 'candidate', id: c.id },
        payload: { resume: text, fromFiles: (c.files || []) },
        inputHash: hash(text), causedBy: lastSeq,
      })
      return { ok: true, seq: ev.seq, action, message: `${c.name} 文本已补录（${text.length} 字）` }
    }
    case 'rollback': {
      // append-only 账本不删除事件，追加一条补偿事件把状态退回。
      const ev = appendEvent(d, {
        type: 'stage.advanced', actor: 'human', actorId: 'hr',
        subject: { kind: 'candidate', id: c.id },
        payload: { to: '待评估', reason: '人工回滚上一次动作 → 回到待评估（需重新评估）', compensates: a.seq || lastSeq },
        causedBy: lastSeq,
      })
      return { ok: true, seq: ev.seq, action, to: '待评估', message: `已回滚：${c.name} → 待评估（补偿事件 #${ev.seq}）` }
    }
    default:
      throw new Error('unknown action: ' + action)
  }
}
