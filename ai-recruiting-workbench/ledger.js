/* 事实账本：append-only 事件 + 派生投影 + 因果回放 + 规范版本。
   权威是 events.jsonl；events.log 是同一事件的人类可读镜像（供看板与审计阅读）。 */

export const HUMAN_CONTRACT = {
  // 人只在判断点出现；录入、解析、归档、通知、汇总都不属于人的动作。
  decisions: ['面', '不面', '补一句', 'Offer', '淘汰', '人才库', '已入职'],
  corrections: ['技能被低估', '证据不足', '岗位特殊要求', '模型误判', '其他'],
  rules: [
    '人永不直接编辑状态字段：状态由事件派生',
    '不可逆终态（Offer / 已入职）必须经人 decision.made，机不得代做',
    '淘汰属「授权自动化」：AI 可对明确不合格者自动淘汰，但必须记 actor=agent+auto、可追溯、可激活复捞（写入 decision.made 而非静默改状态）',
    '改判必须带原因码；纠偏必须带维度',
    '每个动作 ≤3 次点击 / ≤20 秒，否则人会绕过系统、数据断流',
  ],
}

export const MACHINE_CONTRACT = {
  can: ['简历解析', '入口脱敏', '三键去重', '知识检索', '六维评分建议', '证据定位', '排期', '通知文案', '汇总'],
  cannot: ['淘汰', '改标准', '直接写状态', '无证据给分', '把置信度当证据', '低置信硬给结论'],
  outputMustCarry: ['inputHash', 'basedOn{l0,l1,rule,model,prompt}', 'evidence[]', 'confidence'],
}

export const EVENT_TYPES = [
  'position.created', 'position.updated', 'resume.received', 'resume.deduped',
  'assessment.recorded', 'decision.made', 'correction.made',
  'standard.proposed', 'standard.validated', 'standard.released',
  'invite.sent', 'interview.scheduled', 'interviewer.batch', 'interviewer.availability', 'feedback.submitted', 'offer.sent', 'offer.accepted', 'offer.declined', 'onboarding.scheduled', 'hire.confirmed', 'background.check',
  'stage.advanced', 'resume.backfilled', 'assessment.requested', 'name.fixed', 'candidate.bound',
  'salary.advised', 'resume.reparsed',
]

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const STAGES = ['待评估', '待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职', '已入职', 'Offer拒绝', '已淘汰', '人才库']
// 来源渠道权威清单（全站唯一口径：上传/邮箱归因/统计都用它；自定义来源允许自由文本）
export const SOURCES = ['BOSS直聘', '猎聘', '智联招聘', '内推', '猎头', '自搜', '其他']
// 历史数据中的旧渠道名（不再提供新选，统计时合并展示）
export const LEGACY_SOURCES = ['网投', '前程无忧', '拉勾', '官网', '校招', '内部转岗']
const DECISIONS = { '进初试': '待初试', '进复试': '待复试', '面': '待初试', '不面': '已淘汰', '补一句': '待评估', 'Offer': 'Offer已发', '淘汰': '已淘汰', '人才库': '人才库', '已入职': '已入职', 'Offer拒绝': 'Offer拒绝', '候选人放弃': 'Offer拒绝' }

function readRows(p) { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch (e) { return [] } }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }; return 'h' + (h >>> 0).toString(16) }
function readJSON(p, fb) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { return fb } }
function writeJSON(p, v) { writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8') }

export function readEvents(dir) {
  return readRows(join(dir, 'events.jsonl')).sort((a, b) => (a.seq || 0) - (b.seq || 0))
}

/** 唯一写入口：任何状态变化都必须先翻译成一条事件。 */
export function appendEvent(dir, input) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const events = readEvents(dir)
  const seq = (events.length ? events[events.length - 1].seq : 0) + 1
  const ev = {
    seq,
    ts: new Date().toISOString(),
    actor: input.actor || 'system',
    actorId: input.actorId || '',
    type: input.type,
    subject: input.subject || { kind: 'workspace', id: '-' },
    payload: input.payload || {},
    evidence: input.evidence || [],
    basedOn: input.basedOn || { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'local-rules', prompt: 'v1' },
    inputHash: input.inputHash || '',
    causedBy: input.causedBy == null ? null : input.causedBy,
    correlationId: input.correlationId || 'c' + seq,
  }
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n', 'utf8')
  // 人类可读镜像：看板、审计、人工排查读它；不是权威。
  const LABEL = {
    'position.created': '职位', 'position.updated': '职位更新', 'resume.received': '接入', 'resume.deduped': '去重',
    'assessment.recorded': '评估', 'decision.made': '决策', 'correction.made': '纠偏', 'salary.advised': '薪酬建议', 'resume.reparsed': '简历重解析',
    'standard.proposed': '规范建议', 'standard.validated': '规范验证', 'standard.released': '规范发布',
    'invite.sent': '邀约', 'interview.scheduled': '面试', 'interviewer.batch': '面试官批量协作', 'interviewer.availability': '面试官时间反馈', 'feedback.submitted': '面评',
    'offer.sent': 'Offer已发', 'background.check': '背调', 'offer.accepted': 'Offer已接受', 'offer.declined': 'Offer被拒/放弃', 'onboarding.scheduled': '安排入职', 'hire.confirmed': '确认入职', 'stage.advanced': '阶段', 'assessment.requested': '请求评估', 'name.fixed': '改名', 'candidate.bound': '绑定岗位',
  }
  appendFileSync(join(dir, 'events.log'),
    `${ev.ts} | ${ev.subject.id} | ${LABEL[ev.type] || ev.type} | ${JSON.stringify(ev.payload).slice(0, 160)}\n`, 'utf8')
  project(dir)
  return ev
}

// ===== 派生的唯一口径：等级/分数从候选人状态统一推导（杜绝各处各算、锚定 bug）=====
export function deriveGrade(c) {
  if (!c) return ''
  if (c.deep && c.deep.grade && ['S','A','B','C'].indexOf(String(c.deep.grade).toUpperCase()) >= 0) return String(c.deep.grade).toUpperCase()
  const m = String(c.route || '').match(/([SABC])\s*级/)
  if (m) return m[1].toUpperCase()
  if (typeof c.weighted === 'number') return c.weighted >= 85 ? 'S' : c.weighted >= 75 ? 'A' : c.weighted >= 60 ? 'B' : 'C'
  return ''
}
export function deriveScore(c) {
  if (!c) return null
  if (c.weighted != null) return c.weighted
  if (c.deep && c.deep.score != null) return c.deep.score
  return null
}

// ===== 评估事件唯一入口：所有 AI 评估都走这里，schema 唯一、字段规范化 =====
// 背景：此前 assessment.recorded 在 actions/index 有 6-7 处各自拼 payload，字段漂移、易丢分。
// 现在统一：调用方只传语义字段，本函数保证 schema 一致、缺省安全、并把 deep.alignment 派生 scores/weighted 一致化。
export function recordAssessment(dir, o) {
  o = o || {}
  const deep = o.deep || null
  // scores / weighted / grade 的单一来源：优先显式传，其次从 deep 派生
  let scores = o.scores
  if (scores == null && deep && Array.isArray(deep.alignment)) {
    scores = {}
    for (const a of deep.alignment) if (a && a.dim && a.score != null) scores[a.dim] = a.score
  }
  if (scores == null) scores = {}
  const weighted = (o.weighted != null) ? o.weighted : (deep && deep.score != null ? deep.score : null)
  const grade = o.grade || (deep && deep.grade) || (o.route ? ((String(o.route).match(/([SABC])\s*级/) || [])[1] || '') : '') || ''
  const conf = (o.conf != null) ? o.conf : (deep && deep.conf != null ? deep.conf : null)
  const payload = {
    // 结构诊断
    deep,
    grade,
    score: weighted,
    weighted,
    scores,
    conf,
    // 结论/去向
    route: o.route || '',
    action: o.action || '',
    conclusion: o.conclusion || '',
    tier: o.tier || '',
    summary: o.summary || '',
    // 证据与缺口（结构化，供面试/校准/展示消费）
    evidence: o.evidence || {},
    undetermined: o.undetermined || [],
    doubts: o.doubts || [],
    gateResults: o.gateResults || [],
    // 标记本次评估"增强/修补"类（如门槛回填），便于 fold 判断是否覆盖核心结论
    partial: !!o.partial,
    engine: (deep && deep.engine) || o.engine || (o.basedOn && o.basedOn.rule) || '',
  }
  return appendEvent(dir, {
    type: 'assessment.recorded',
    actor: o.actor || 'agent',
    actorId: o.actorId || '',
    subject: { kind: 'candidate', id: o.candidateId },
    payload,
    evidence: o.evidenceList || (o.evidence ? Object.values(o.evidence).filter(Boolean) : []),
    basedOn: o.basedOn || { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'local-rules', prompt: 'v1' },
    inputHash: o.inputHash || '',
    causedBy: o.causedBy == null ? null : o.causedBy,
  })
}

/** fold：只由事件派生状态，永不直接写状态文件。 */
export function fold(dir, events) {
  const ev = events || readEvents(dir)
  const positions = [], byId = {}, calibration = [], standards = [], standardsLog = []
  for (const e of ev) {
    const p = e.payload || {}, id = (e.subject || {}).id
    switch (e.type) {
      case 'position.created':
        positions.push({ ...p, createdAt: e.ts }); break
      case 'resume.reparsed': {
        const c = byId[id]; if (!c) break
        if (p.resume != null) c.resume = p.resume
        if (p.dropped) c.dropped = p.dropped
        if (p.parse) c.parse = { ...(c.parse || {}), ...p.parse }
        c.updated = e.ts; c.seqs.push(e.seq); break
      }
      case 'position.updated': {
        const idx = positions.findIndex(x => x.id === id)
        if (idx >= 0) positions[idx] = { ...positions[idx], ...p, updatedAt: e.ts }
        else positions.push({ ...p, createdAt: e.ts })
        break
      }
      case 'resume.received': {
        // 同一人重复投递：只把新原件追加到留档，不重建候选人对象。
        if (p.duplicateAttachment) {
          const c = byId[id]
          if (c) {
            c.files = (c.files || []).concat(p.duplicateAttachment)
            c.dupCount = (c.dupCount || 0) + 1
            c.lastDupReason = p.dupReason || ''
            // 重复投递带了新岗位、且原未绑岗位 → 记录申请岗位供人确认（不自动绑）
            if (p.appliedPid) c.appliedPid = c.appliedPid || p.appliedPid
            c.updated = e.ts; c.seqs.push(e.seq)
          }
          break
        }
        byId[id] = {
          id, name: p.name, pid: p.pid, source: p.source, phone: p.phone || '', email: p.email || '',
          resume: p.resume || '', dropped: p.dropped || [],
          stage: (p.stage && p.stage !== '已接入' && STAGES.indexOf(p.stage) >= 0) ? p.stage : '待评估',
          files: p.files || [], needsOcr: !!p.needsOcr, mail: p.mail || {}, parse: p.parse || {},
          appliedPid: p.appliedPid || '', precheck: p.precheck || null, intentFlag: p.intentFlag || '',
          scores: null, conf: null, route: null, evidence: {}, undetermined: [], doubts: [], summary: '',
          created: e.ts, updated: e.ts, seqs: [e.seq],
        }; break
      }
      case 'resume.deduped': break
      case 'assessment.recorded': {
        const c = byId[id]; if (!c) break
        // 统一入口后：assessment.recorded 的 payload 由 recordAssessment() 规范化，字段齐全。
        // partial=true 的是"增强/补丁"类（门槛回填、评分卡预览）→ 只补不覆盖核心结论；
        // partial=false 的是完整评估 → 直接以本次为准（schema 单一，不再需要宽松兜底）。
        // 判定是否"实质完整评估"：显式 full（非 partial）且带了核心结论（route 或 weighted 或 deep）
        // 兼容历史数据：旧的门槛增强事件未标 partial，但缺 route/weighted —— 视为补丁，不清空核心结论
        const hasCore = p.route || p.weighted != null || (p.deep && (p.deep.grade || p.deep.score != null))
        const full = !p.partial && hasCore
        // 完整评估：核心结论以本次为准（逐字段防空值覆盖）
        if (full) {
          if (p.scores != null) c.scores = p.scores
          if (p.route) c.route = p.route
          if (p.weighted != null) c.weighted = p.weighted
          if (p.conf != null) c.conf = p.conf
          if (p.summary) c.summary = p.summary
          if (p.evidence) c.evidence = p.evidence
          if (p.undetermined) c.undetermined = p.undetermined
          if (p.doubts) c.doubts = p.doubts
          if (p.action) c.action = p.action
          if (p.conclusion) c.conclusion = p.conclusion
          if (p.tier) c.tier = p.tier
          if (p.deep) c.deep = p.deep
        } else {
          // 增强补丁：只更新本次明确带来的证据类字段，不动分数/route/deep
          if (Array.isArray(p.gateResults) && p.gateResults.length) c.gateResults = p.gateResults
          if (p.gateSummary) c.gateSummary = p.gateSummary
          if (p.summary && !c.summary) c.summary = p.summary
        }
        if (Array.isArray(p.gateResults) && p.gateResults.length && full) c.gateResults = p.gateResults
        // 评估只更新诊断内容，绝不改变阶段：阶段只能由 stage.advanced / decision.made 推进
        // （AI 评估完的去向由评估动作自己写 stage.advanced：待初试 或 已淘汰）
        c.updated = e.ts; c.lastAssessmentSeq = e.seq
        c.seqs.push(e.seq); break
      }
      case 'decision.made': {
        const c = byId[id]; if (!c) break
        c.stage = DECISIONS[p.decision] || c.stage
        c.lastDecision = p.decision; c.decisionReason = p.reason || ''
        c.updated = e.ts; c.seqs.push(e.seq); break
      }
      case 'correction.made':
        calibration.push({ seq: e.seq, ts: e.ts, candidateId: id, dimension: p.dimension, reasonCode: p.reasonCode, note: p.note || '' }); break
      case 'standard.proposed':
        standardsLog.push({ seq: e.seq, ts: e.ts, phase: 'proposed', ...p }); break
      case 'standard.validated':
        standardsLog.push({ seq: e.seq, ts: e.ts, phase: 'validated', ...p }); break
      case 'standard.released':
        standards.push({ seq: e.seq, ts: e.ts, ...p })
        standardsLog.push({ seq: e.seq, ts: e.ts, phase: 'released', ...p }); break
      case 'name.fixed': {
        const c = byId[id]
        if (c && p.name) { c.name = p.name; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'candidate.bound': {
        const c = byId[id]
        if (c && p.pid) { c.pid = p.pid; c.unlinked = false; c.stage = '待评估'; c.scores = null; c.conf = null; c.route = null; c.weighted = null; c.evidence = {}; c.undetermined = []; c.doubts = []; c.gateResults = []; c.deep = null; c.action = ''; c.conclusion = ''; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'assessment.requested': {
        const c = byId[id]
        if (c) { c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'resume.backfilled': {
        const c = byId[id]
        if (c) { c.resume = p.resume || c.resume; c.needsOcr = false; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'invite.sent': case 'interview.scheduled': case 'feedback.submitted':
      case 'offer.sent': case 'stage.advanced': {
        const c = byId[id]
        if (c) {
          if (e.type === 'stage.advanced' && p.to) c.stage = p.to
          if (e.type === 'offer.sent') { c.stage = 'Offer已发'; c.offer = { salary: p.salary || '', note: p.note || '', at: e.ts, startDate: p.startDate || '' } }
          c.updated = e.ts; c.seqs.push(e.seq)
        }
        break
      }
      case 'offer.accepted': {
        const c = byId[id]; if (c) { c.stage = 'Offer已接受'; c.offer = { ...(c.offer || {}), acceptedAt: e.ts, acceptedSalary: p.salary || (c.offer || {}).salary }; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'offer.declined': {
        const c = byId[id]; if (c) { c.stage = 'Offer拒绝'; c.offer = { ...(c.offer || {}), declinedAt: e.ts, declineReason: p.reason || '' }; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'onboarding.scheduled': {
        const c = byId[id]; if (c) { c.stage = '待入职'; c.offer = { ...(c.offer || {}), startDate: p.startDate || (c.offer || {}).startDate, onboardAt: p.startDate || '' }; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      case 'hire.confirmed': {
        const c = byId[id]; if (c) { c.stage = '已入职'; c.offer = { ...(c.offer || {}), hiredAt: e.ts, startDate: p.startDate || (c.offer || {}).startDate }; c.updated = e.ts; c.seqs.push(e.seq) }
        break
      }
      default: break
    }
  }
  const candidates = Object.values(byId)
  // 旧阶段兼容映射：待面试→待初试，面试中→初试中（历史数据平滑过渡）
  const STAGE_MIGRATE = { '待面试': '待初试', '面试中': '初试中', '待决策': '待发 Offer', '已评估': '待初试', 'Offer': 'Offer已发' }
  for (const c of candidates) { if (STAGE_MIGRATE[c.stage]) c.stage = STAGE_MIGRATE[c.stage] }
  // 兜底校正：未关联岗位(pid为空)的候选人，评估结论无意义 → 清空评分/结论，阶段回待评估，标记需绑定岗位
  const validPids = new Set(positions.map(p => p.id))
  for (const c of candidates) {
    if (!c.pid || !validPids.has(c.pid)) {
      c.unlinked = true
      if (c.stage !== '已淘汰' && c.stage !== '人才库' && c.stage !== '已入职') {
        c.stage = '待评估'
        c.scores = null; c.conf = null; c.route = null; c.weighted = null
        c.evidence = {}; c.undetermined = []; c.doubts = []; c.summary = ''
        c.gateResults = []; c.deep = null; c.action = ''; c.conclusion = ''
      }
    } else { c.unlinked = false }
  }
  const byStage = {}, bySource = {}
  for (const s of STAGES) byStage[s] = 0
  for (const c of candidates) { byStage[c.stage] = (byStage[c.stage] || 0) + 1; bySource[c.source] = (bySource[c.source] || 0) + 1 }
  const inbox = []
  // 收件箱只装「还没处理的判断点」：一旦人做了决策、状态推进到面试及以后，
  // 该候选人历史上的低置信/证据不足疑点即视为已处理，不再占着入口。
  const DECIDED = ['待初试', '初试中', '待复试', '复试中', 'Offer', '已入职', '已淘汰', '人才库']
  // 收件箱按「人要做什么」分层，不按内部字段。每候选人只进最主要的一条（避免同一人刷多条）。
  for (const c of candidates) {
    const decided = DECIDED.indexOf(c.stage) >= 0
    let grade = (c.deep && c.deep.grade) || (String(c.route || '').match(/([SABC])\s*级/) || [])[1] || ''
    grade = String(grade).toUpperCase()
    if (['S','A','B','C'].indexOf(grade) < 0 && typeof c.weighted === 'number') {
      grade = c.weighted >= 85 ? 'S' : c.weighted >= 75 ? 'A' : c.weighted >= 60 ? 'B' : 'C'
    }
    if (['S','A','B','C'].indexOf(grade) < 0) grade = ''
    let item = null
    const STARTED = ['待初试', '初试中', '待复试', '复试中']
    if (c.stage === '已淘汰' || c.stage === '人才库' || c.stage === '已入职' || c.stage === 'Offer' || STARTED.indexOf(c.stage) >= 0) {
      item = null // 已定局或已进入面试流程，不占收件箱
    } else if (c.unlinked && c.appliedPid) {
      // 投了岗位但方向不符（技术栈预检 mismatch）→ 疑似投错，待人确认意向/改绑
      item = { kind: '疑似投错岗位', risk: 4, reason: (c.precheck && c.precheck.reason ? c.precheck.reason.slice(0, 50) + '；' : '') + '投了岗位但方向不符，请确认真实意向或改绑正确岗位' }
    } else if (c.unlinked && c.dupCount > 0) {
      item = { kind: '重复投递', risk: 2, reason: '该候选人重复投递 ' + c.dupCount + ' 次（' + (c.lastDupReason || '') + '），原件已归档' }
    } else if (c.unlinked) {
      item = { kind: '待分配岗位', risk: 3, reason: '未指定岗位，请分配后评估' }
    } else if (c.stage === '待评估' && !grade && c.needsOcr) {
      item = { kind: '待补录', risk: 3, reason: '扫描件/图片无 OCR，原件已留档，需补录文本' }
    } else if (c.stage === '待评估' && !grade) {
      // 真·尚未评分（无 route/weighted）→ AI 会自动初筛，不该占"待处理"；不作为人工待办
      item = null
    } else if (c.stage === '待评估' && grade) {
      // 已评分待人工审核：缺证据→待复核；S/A→需拍板；B→排雷；C→建议淘汰
      const und = c.undetermined || []
      const insufficient = und.length > 0 || /待补充|缺.*证据|未判定|证据不足/.test(c.route || '')
      if (insufficient) item = { kind: '低置信待复核', risk: 3, reason: '缺关键证据（' + (und.join('、') || '关键维度') + '），请索取补充材料或面试核实' }
      else if (grade === 'S' || grade === 'A') item = { kind: '需拍板·推荐', risk: 4, reason: grade + ' 级 · ' + (c.weighted != null ? c.weighted + ' 分' : '') + '，AI 推荐进初试，请拍板' }
      else if (grade === 'C') item = { kind: '建议淘汰·待确认', risk: 4, reason: 'C 级 · ' + (c.route || '不建议推进').slice(0, 40) + '，请确认淘汰或破格' }
      else item = { kind: '需面试排雷', risk: 3, reason: 'B 级 · 建议面试中重点排雷' }
    } else if (c.stage === '待发 Offer') {
      item = { kind: '待发 Offer', risk: 5, reason: '流程已到待决策，请给最终结论（淘汰/Offer/进面试）' }
    } else if (grade === 'S' || grade === 'A') {
      item = { kind: '需拍板·推荐', risk: 4, reason: (grade + ' 级 · ' + (c.weighted != null ? c.weighted : '') + ' 分）AI 推荐进初试，请拍板') }
    } else if (grade === 'B') {
      const rf = ((c.deep && c.deep.redFlags) || []).length
      if (c.tier === 'b_lowconf') item = { kind: '低置信待复核', risk: 3, reason: 'B 级 · ' + (rf ? rf + ' 条红牌/' : '') + '证据偏弱，建议先人工复核再定' }
      else item = { kind: '需面试排雷', risk: 3, reason: 'B 级 · ' + (rf ? rf + ' 条红牌待核实，' : '') + '建议面试中重点排雷' }
    } else if (grade === 'C') {
      item = { kind: '建议淘汰·待确认', risk: 4, reason: 'C 级 · ' + ((c.deep && c.deep.conclusion) ? c.deep.conclusion.slice(0, 40) : (c.route || '不建议推进')) + '，请确认淘汰或破格' }
    } else if (decided) {
      item = null
    } else {
      item = { kind: '待处理', risk: 2, reason: '待人工查看' }
    }
    if (item) inbox.push({ id: c.id, name: c.name, kind: item.kind, risk: item.risk, reason: item.reason, stage: c.stage })
  }
  // 排序：先按风险，再按 kind 优先级
  const KIND_ORDER = { '待发 Offer': 0, '需拍板·推荐': 1, '建议淘汰·待确认': 1, '疑似投错岗位': 2, '待分配岗位': 2, '重复投递': 3, '需面试排雷': 3, '低置信待复核': 4, '待初筛': 5, '待补录': 6, '待处理': 7 }
  inbox.sort((a, b) => (b.risk - a.risk) || ((KIND_ORDER[a.kind] || 9) - (KIND_ORDER[b.kind] || 9)))
  return { positions, candidates, byStage, bySource, inbox, calibration, standards, standardsLog, eventCount: ev.length, byId }
}

/** 写派生投影（可随时丢弃重建）；同时保留兼容格式的只读视图供旧工具读取。 */
export function project(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const pd = join(dir, 'projections'); if (!existsSync(pd)) mkdirSync(pd, { recursive: true })
  const s = fold(dir)
  writeJSON(join(pd, 'state.json'), {
    generatedAt: new Date().toISOString(), eventCount: s.eventCount,
    positions: s.positions, byStage: s.byStage, bySource: s.bySource,
    inboxCount: s.inbox.length, calibrationCount: s.calibration.length,
    standardVersions: s.standards.map(x => x.version),
  })
  // 兼容视图：只读，由投影派生，工具不再直接写它们。
  writeJSON(join(dir, 'positions.json'), s.positions)
  writeFileSync(join(dir, 'candidates.jsonl'), s.candidates.map(c => JSON.stringify(c)).join('\n') + (s.candidates.length ? '\n' : ''), 'utf8')
  writeFileSync(join(dir, 'calibration.jsonl'), s.calibration.map(c => JSON.stringify(c)).join('\n') + (s.calibration.length ? '\n' : ''), 'utf8')
  return s
}

/** 回放：给定对象，重建完整因果链、每步依据与当时生效的规范版本。 */
export function replay(dir, subjectId) {
  const ev = readEvents(dir)
  const own = ev.filter(e => (e.subject || {}).id === subjectId)
  const bySeq = new Map(ev.map(e => [e.seq, e]))
  const chain = []
  for (const e of own) {
    chain.push({
      seq: e.seq, ts: e.ts, actor: e.actor, type: e.type,
      payload: e.payload, evidence: e.evidence, basedOn: e.basedOn, inputHash: e.inputHash,
      causedBy: e.causedBy, cause: e.causedBy == null ? null : (() => {
        const c = bySeq.get(e.causedBy)
        return c ? { seq: c.seq, type: c.type, actor: c.actor } : null
      })(),
    })
  }
  const standardsAt = (seq) => {
    const released = ev.filter(x => x.type === 'standard.released' && x.seq <= seq)
    return released.length ? released[released.length - 1].payload : { l0: 'v1.2', l1: 'v1', rule: 'v1' }
  }
  return {
    subjectId, eventCount: own.length, chain,
    standardAtFirstEvent: own.length ? standardsAt(own[0].seq) : null,
    standardAtLastEvent: own.length ? standardsAt(own[own.length - 1].seq) : null,
    currentStandard: standardsAt(Infinity),
  }
}

/** 规范版本链与校准状态。 */
export function standardVersions(dir) {
  const ev = readEvents(dir)
  const released = ev.filter(e => e.type === 'standard.released').map(e => ({ seq: e.seq, ts: e.ts, ...e.payload }))
  const proposals = ev.filter(e => e.type === 'standard.proposed').map(e => ({ seq: e.seq, ts: e.ts, ...e.payload }))
  const validations = ev.filter(e => e.type === 'standard.validated').map(e => ({ seq: e.seq, ts: e.ts, ...e.payload }))
  const byKey = {}
  for (const e of ev.filter(x => x.type === 'correction.made')) {
    const p = e.payload || {}
    const k = `${p.dimension || '-'} × ${p.reasonCode || '-'}`
    byKey[k] = (byKey[k] || 0) + 1
  }
  return {
    current: released.length ? released[released.length - 1] : { version: 'L0 v1.2 / L1 v1（初始基线）' },
    released, proposals, validations,
    calibrationClusters: Object.entries(byKey).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count, ready: count >= 3 })),
  }
}

/** 把旧格式数据迁移成初始事件（一次性，幂等）。 */
export function migrateLegacy(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(join(dir, 'events.jsonl'))) return readEvents(dir).length
  const oldPositions = readJSON(join(dir, 'positions.json'), [])
  const oldCandidates = readRows(join(dir, 'candidates.jsonl'))
  if (!oldPositions.length && !oldCandidates.length) return 0
  const lines = []
  let seq = 0
  const lastByCandidate = {}
  const push = (o) => {
    const mySeq = ++seq
    lines.push(JSON.stringify({
      seq: mySeq, ts: o.ts || new Date().toISOString(), actor: o.actor || 'system', actorId: 'migration',
      type: o.type, subject: o.subject || { kind: 'workspace', id: '-' }, payload: o.payload || {},
      evidence: o.evidence || [], basedOn: o.basedOn || { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'legacy', prompt: 'v1' },
      inputHash: o.inputHash || '', causedBy: o.causedBy == null ? null : o.causedBy,
      correlationId: o.correlationId || 'migration',
    }))
    const id = (o.subject || {}).id
    if (id) lastByCandidate[id] = mySeq
    return mySeq
  }
  const link = (o, extra) => push({ ...o, causedBy: extra })
  for (const p of oldPositions) push({ type: 'position.created', subject: { kind: 'position', id: p.id }, payload: p })
  for (const c of oldCandidates) {
    const sub = { kind: 'candidate', id: c.id }
    let prev = push({ type: 'resume.received', subject: sub, payload: c, ts: c.created || undefined, inputHash: hash(c.resume || '') })
    if (c.scores) prev = link({ type: 'assessment.recorded', subject: sub, actor: 'agent', payload: { scores: c.scores, conf: c.conf, route: c.route, evidence: c.evidence, undetermined: c.undetermined, doubts: c.doubts, summary: c.summary }, evidence: Object.values(c.evidence || {}).filter(Boolean) }, prev)
    if (c.stage && c.stage !== '已接入' && c.stage !== '已评估') prev = link({ type: 'stage.advanced', subject: sub, payload: { to: c.stage } }, prev)
  }
  for (const c of readRows(join(dir, 'calibration.jsonl'))) {
    link({ type: 'correction.made', subject: { kind: 'candidate', id: c.candidateId || '-' }, actor: 'human', payload: c }, lastByCandidate[c.candidateId] || null)
  }
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  project(dir)
  return lines.length
}
