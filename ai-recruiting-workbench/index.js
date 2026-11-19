import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDashboard } from './dashboard.js'
import { scrub, hash } from './util.js'
import { handleUpload, drill, archive } from './intake.js'
import {
  appendEvent, fold, project, replay, standardVersions, migrateLegacy, recordAssessment,
  HUMAN_CONTRACT, MACHINE_CONTRACT, readEvents,
} from './ledger.js'
import { performAction, workbenchData, impactOf } from './actions.js'
import { ruleJD, parseJDMarkdown, jdToMarkdown, emptyJD } from './jd.js'
import { ruleScorecard, scorecardToMarkdown, emptyScorecard } from './scorecard.js'
import { salaryBenchmark } from './salary.js'
import { buildDeepAssessPrompt, parseDeepAssess, gradeToAction } from './deepassess.js'
import { buildBarsPrompt, parseBarsResult, scoreFromVerdicts, consensusVerdicts, techStackFit, computeConfidence } from './deepscore.js'

export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'webServer']
// llm 作为软依赖：拿不到就降级规则引擎
export const optional = ['llm']

import { SOURCES } from './ledger.js'
const DEFAULT_BASED_ON = { l0: 'v1.2', l1: 'v1', rule: 'v1', model: 'local-rules', prompt: 'v1' }

function dirOf(ctx, exec, config) {
  // 账本只有一个位置：显式数据目录优先。工具与 HTTP 路由必须读同一份事实，
  // 否则「沉淀」会分裂成两本账。会话 cwd 仅作未配置时的回退。
  if (config && config.dataDir) return config.dataDir
  try {
    if (exec && exec.agent && ctx.workingDirectory) {
      const base = ctx.workingDirectory.get(exec.agent.session)
      if (base) return join(base, 'recruiting')
    }
  } catch (e) { /* fall through */ }
  return join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')
}
function ensure(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); return p }
function keyOf(c) {
  return [String(c.name || '').trim(), String(c.phone || '').replace(/\D/g, ''),
    String(c.email || '').toLowerCase(), c.pid].join('|')
}
function jsonOut(format) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: format ? format(value) : JSON.stringify(value, null, 2) }],
  }
}
function obj(props, required = []) { return { type: 'object', additionalProperties: false, properties: props, required } }
const S = (d) => ({ type: 'string', description: d })
const N = (d) => ({ type: 'number', description: d })

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))

export function apply(ctx, config = {}) {
  const dispose = []
  const dataDir = () => config && config.dataDir
    ? config.dataDir
    : join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')
  const tool = (name, description, parameters, run, format) => {
    dispose.push(ctx.tools.register({
      name, description, parameters, output: jsonOut(format),
      async execute(args, exec) { return run(args || {}, exec) },
    }))
  }
  // 启动即完成旧数据 → 事件账本的迁移（幂等）
  try { migrateLegacy(config.dataDir || join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')) } catch (e) { /* 迁移失败不阻断插件；工具调用时会再尝试 */
  }

  /* ============ 观察层：只读，全部由 fold 派生 ============ */
  tool('recruit_dashboard', '实时数据看板：KPI 带环比、流程节点人数与自动推进、漏斗与渠道、AI 能力效能与提质指标。数字每次调用从事件账本重算。',
    obj({}), (_a, exec) => {
      const d = dirOf(ctx, exec, config); ensure(d); migrateLegacy(d); project(d)
      return buildDashboard(d)
    },
    v => [
      `AI 招聘工作台 · 实时看板（${v.generatedAt.slice(0, 16).replace('T', ' ')}）`,
      `周期 ${v.period.current}｜对比 ${v.period.previous}`, v.baseline, '',
      '【核心指标 + 环比】', ...v.kpis.map(k => `${k.label} ${k.value}${k.unit}  环比 ${k.deltaLabel}  ${k.note}`), '',
      '【流程节点】', ...v.nodes.map(n => `${n.label} ${n.count}人 · 自动推进 ${n.automated} · AI[${n.ai.join('/')}]`), '',
      '【AI 能力】', `调用 ${v.ai.calls} 次（环比 ${v.ai.callsDelta.deltaLabel}）· 节省 ${v.ai.savedHours}h · 免人工率 ${v.ai.autoRate}% · 判断可追溯率 ${v.ai.traceable}% · 未判定 ${v.ai.undetermined} 维`, '',
      '【待办】', `待接入 ${v.pending.intake} · 待拍板 ${v.pending.decision} · 低置信 ${v.pending.lowConfidence}`,
    ].join('\n'))

  tool('recruit_overview', 'Read the event ledger and return live counts: positions, candidates, stage funnel, source distribution, inbox and ledger size. State is derived, never stored directly.',
    obj({}), (_a, exec) => {
      const d = dirOf(ctx, exec, config); ensure(d); migrateLegacy(d)
      const s = fold(d)
      return {
        dataDir: d, ledgerEvents: s.eventCount,
        positions: s.positions.length, positionsActive: s.positions.filter(p => p.status === '在招').length,
        candidates: s.candidates.length, byStage: s.byStage, bySource: s.bySource,
        pendingIntake: s.candidates.filter(c => c.stage === '待评估').length,
        pendingDecision: s.candidates.filter(c => c.stage === '待发 Offer').length,
        lowConfidence: s.candidates.filter(c => c.conf != null && c.conf < 0.72).length,
        calibrationRecords: s.calibration.length,
        standards: s.standards.map(x => x.version || x.l0),
      }
    }, v => `招聘概览\n事件账本 ${v.ledgerEvents} 条｜在招职位 ${v.positionsActive}/${v.positions} · 候选人 ${v.candidates}\n待接入/待评估 ${v.pendingIntake} · 待发Offer ${v.pendingDecision} · 低置信 ${v.lowConfidence}\n阶段：${Object.entries(v.byStage || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' / ')}\n渠道：${Object.entries(v.bySource || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' / ')}\n规范版本：${(v.standards || []).join('、') || '初始基线'}\n数据目录：${v.dataDir}`)

  tool('recruit_positions', 'List all positions with hard gates, ordered ability dimensions and salary band.',
    obj({}), (_a, exec) => ({ positions: fold(dirOf(ctx, exec, config)).positions }),
    v => (v.positions || []).length ? v.positions.map(p => `${p.id} ${p.title}｜${p.dept}/${p.city}｜${p.band ? p.band.join('-') + 'K' : ''}｜${p.status}｜门槛：${(p.gates || []).join('、')}｜能力：${(p.abilities || []).join(' > ')}`).join('\n') : '(暂无职位)')

  tool('recruit_add_position', 'Create a position. Writes a position.created event; positions.json is only a derived projection. Gates and abilities are plain lists; no weights or thresholds.',
    obj({ title: S('Position title'), dept: S('Department'), city: S('City'), headcount: N('Headcount'), bandMin: N('Band min K'), bandMax: N('Band max K'), gates: { type: 'array', items: { type: 'string' } }, abilities: { type: 'array', items: { type: 'string' } }, status: S('Status'), standard: S('Relative path of L0 scoring card') }, ['title']),
    (a, exec) => {
      const d = ensure(dirOf(ctx, exec, config)); migrateLegacy(d)
      const p = { id: 'P' + Date.now().toString(36), title: String(a.title).trim(), dept: a.dept || '', city: a.city || '', hc: a.headcount || 1, band: [a.bandMin || 0, a.bandMax || 0], status: a.status || '在招', gates: a.gates || [], abilities: a.abilities || [], standard: a.standard || '' }
      appendEvent(d, { type: 'position.created', actor: 'human', subject: { kind: 'position', id: p.id }, payload: p })
      return { ok: true, positionId: p.id, title: p.title, event: 'position.created' }
    })

  /* ============ 事实层：写操作只追加事件 ============ */
  tool('recruit_intake', 'Intake one resume. Drops sensitive fields at the entrance, deduplicates on name+phone+email+position, and appends a resume.received event (the only write). candidates.jsonl is a derived projection.',
    obj({ name: S('Candidate name'), positionId: S('Position id'), source: S('Fixed source code'), resume: S('Raw resume text'), phone: S('Phone'), email: S('Email') }, ['name', 'positionId', 'resume']),
    (a, exec) => {
      const d = ensure(dirOf(ctx, exec, config)); migrateLegacy(d)
      const clean = scrub(a.resume)
      const c = {
        id: 'C' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: String(a.name).trim(), pid: a.positionId,
        source: SOURCES.indexOf(a.source) >= 0 ? a.source : '其他',
        phone: a.phone || '', email: a.email || '', resume: clean.text, dropped: clean.dropped,
        created: new Date().toISOString(),
      }
      if (!c.name) throw new Error('name must not be empty')
      const s = fold(d)
      const dup = s.candidates.find(x => keyOf(x) === keyOf(c))
      if (dup) {
        appendEvent(d, { type: 'resume.deduped', actor: 'system', subject: { kind: 'candidate', id: c.id }, payload: { duplicateOf: dup.id, name: c.name }, causedBy: dup.seqs ? dup.seqs[0] : null })
        return { ok: false, duplicateOf: dup.id, name: c.name, reason: '三键重复，未入库（已留痕）' }
      }
      const ev = appendEvent(d, {
        type: 'resume.received', actor: 'human', subject: { kind: 'candidate', id: c.id },
        payload: c, inputHash: hash(c.resume), evidence: clean.dropped.length ? [`入口脱敏：${clean.dropped.join('、')}`] : [],
      })
      return { ok: true, candidateId: c.id, name: c.name, stage: '待评估', seq: ev.seq, dropped: clean.dropped }
    })

  tool('recruit_evaluation_packet', 'Return everything needed to judge one candidate: raw resume, scoring card, gates, forbidden fields, calibration history and the event replay chain. The Agent reads 原文 and judges; this tool never computes a score.',
    obj({ candidateId: S('Candidate id') }, ['candidateId']), (a, exec) => {
      const d = dirOf(ctx, exec, config); migrateLegacy(d)
      const s = fold(d), c = s.byId[a.candidateId]
      if (!c) throw new Error('candidate not found: ' + a.candidateId)
      const p = s.positions.find(x => x.id === c.pid) || null
      let standard = ''
      if (p && p.standard) { try { standard = readFileSync(join(d, p.standard), 'utf8') } catch (e) { standard = '(scoring card missing)' } }
      const rp = replay(d, c.id)
      return {
        candidate: { id: c.id, name: c.name, pid: c.pid, source: c.source, stage: c.stage, resume: c.resume, phone: c.phone, email: c.email },
        position: p, standard, gates: p ? p.gates || [] : [], abilities: p ? p.abilities || [] : [],
        forbidden: ['性别', '年龄', '出生日期', '婚育', '民族', '宗教', '户籍', '照片'],
        calibration: s.calibration, replay: rp.chain, eventCount: rp.eventCount,
        standardAtLastEvent: rp.standardAtLastEvent, currentStandard: rp.currentStandard,
        instruction: 'Read the resume and the scoring card, then give your own judgement with quotable evidence. No formula. Dimensions without evidence must be 未判定. Never auto-reject; elimination goes through recruit_decide.',
      }
    }, v => `评估包 · ${v.candidate.name} (${v.candidate.id})｜账本事件 ${v.eventCount} 条\n岗位：${v.position ? v.position.title : '未关联'}｜来源 ${v.candidate.source}（只用于统计）\n\n【简历原文（已脱敏）】\n${v.candidate.resume}\n\n【规则闸门】\n${(v.gates || []).join('\n') || '(无)'}\n\n【能力项】\n${(v.abilities || []).join(' > ') || '(无)'}\n\n【L0 评分卡】\n${v.standard || '(无)'}\n\n【历史纠偏】\n${(v.calibration || []).map(x => `${x.dimension} / ${x.reasonCode} / ${x.note || ''}`).join('\n') || '(无)'}\n\n【因果链（回放）】\n${(v.replay || []).map(e => `#${e.seq} ${e.ts.slice(0, 16)} [${e.actor}] ${e.type}${e.cause ? ` ← #${e.cause.seq} ${e.cause.type}` : ''}`).join('\n') || '(无)'}\n\n当时规范：${JSON.stringify(v.standardAtLastEvent)}\n\n${v.instruction}`)

  tool('recruit_record_assessment', 'Persist an assessment as an assessment.recorded event. Enforces MACHINE_CONTRACT: every scored dimension needs quotable evidence (else 未判定), output must carry inputHash + basedOn + confidence, and auto-reject routes are forbidden.',
    obj({
      candidateId: S('Candidate id'),
      scores: { type: 'object', description: 'Dimension -> score', additionalProperties: { type: 'number' } },
      evidence: { type: 'object', description: 'Dimension -> exact resume quote', additionalProperties: { type: 'string' } },
      confidence: N('Confidence 0-1'), route: S('Routing suggestion'),
      doubts: { type: 'array', items: { type: 'string' } }, summary: S('Short summary'),
      basedOn: { type: 'object', description: 'Standard/model versions used', additionalProperties: { type: 'string' } },
    }, ['candidateId', 'scores', 'evidence']), (a, exec) => {
      const d = ensure(dirOf(ctx, exec, config)); migrateLegacy(d)
      const s = fold(d), c = s.byId[a.candidateId]
      if (!c) throw new Error('candidate not found: ' + a.candidateId)
      const scores = a.scores || {}, evidence = a.evidence || {}
      const normalized = {}, undetermined = []
      for (const k of Object.keys(scores)) {
        const ev = evidence[k]
        if (!ev || !String(ev).trim()) { normalized[k] = null; undetermined.push(k) }
        else normalized[k] = Number(scores[k])
      }
      if (typeof a.confidence !== 'number') throw new Error('MACHINE_CONTRACT: confidence is required')
      const route = String(a.route || '待人工判断')
      if (/淘汰|拒绝|reject/i.test(route)) throw new Error('MACHINE_CONTRACT: auto-reject is forbidden; use recruit_decide')
      const ev = recordAssessment(d, {
        candidateId: c.id, scores: normalized, conf: a.confidence, route, evidence, undetermined, doubts: a.doubts || [], summary: a.summary || '',
        evidenceList: Object.values(evidence).filter(Boolean),
        basedOn: { ...DEFAULT_BASED_ON, ...(a.basedOn || {}) },
        inputHash: hash(c.resume), causedBy: c.seqs ? c.seqs[c.seqs.length - 1] : null,
      })
      // 评估文档是派生视图，供人阅读；权威仍是事件
      const ad = ensure(join(d, 'assessments'))
      const file = join(ad, new Date().toISOString().slice(0, 10) + '.md')
      let md = `\n## ${c.name} · ${c.id} · 事件 #${ev.seq}\n\n结论建议：${route}，置信度 ${a.confidence}\n依据：${JSON.stringify(ev.basedOn)}｜输入哈希 ${ev.inputHash}\n\n| 维度 | 分 | 证据 |\n|---|---|---|\n`
      for (const k of Object.keys(normalized)) md += `| ${k} | ${normalized[k] == null ? '未判定' : normalized[k]} | ${String(evidence[k] || '—').replace(/\|/g, '/')} |\n`
      md += '\nAI 不自动淘汰，最终由人决定。\n'
      appendFileSync(file, md, 'utf8')
      return { ok: true, candidateId: c.id, seq: ev.seq, stage: c.stage, undetermined, basedOn: ev.basedOn, inputHash: ev.inputHash }
    })

  tool('recruit_inbox', 'The exception inbox (the ONLY human operation entry), sorted by risk: new resumes, low confidence, missing evidence and pending decisions. Derived from the ledger. AI never auto-rejects.',
    obj({}), (_a, exec) => { const d = dirOf(ctx, exec, config); migrateLegacy(d); const s = fold(d); return { count: s.inbox.length, items: s.inbox.slice(0, 30) } },
    v => v.count ? `例外收件箱（${v.count}）\n` + (v.items || []).map(x => `[${x.kind}] ${x.name} · ${x.reason} · 阶段 ${x.stage}`).join('\n') : '暂无例外，全部已推进')

  tool('recruit_decide', 'Record a human decision as a decision.made event. Enforces HUMAN_CONTRACT: elimination/Offer only here with a required reason; the same performAction() also serves the workbench UI, so every UI action equals one tool call.',
    obj({ candidateId: S('Candidate id'), decision: S('面 / 不面 / 补一句 / Offer / 淘汰 / 人才库 / 已入职'), reason: S('Reason, stored in the ledger') }, ['candidateId', 'decision']),
    (a, exec) => performAction(ensure(dirOf(ctx, exec, config)), { action: 'decide', candidateId: a.candidateId, decision: a.decision, reason: a.reason }))

  tool('recruit_calibrate', 'Record a correction as a correction.made event. Calibration produces a STANDARD VERSION proposal (not a score edit): when a dimension × reason-code cluster reaches 3, a standard.proposed event is appended. Shares performAction() with the UI.',
    obj({ candidateId: S('Candidate id'), dimension: S('Dimension'), reasonCode: S('One of the five fixed codes'), note: S('Note') }, ['candidateId', 'dimension', 'reasonCode']),
    (a, exec) => performAction(ensure(dirOf(ctx, exec, config)), { action: 'calibrate', candidateId: a.candidateId, dimension: a.dimension, reasonCode: a.reasonCode, note: a.note }))

  tool('recruit_impact', 'Show what a human decision would affect (sent invites, scheduled interviews, draft offers) before it is made. Human decisions have externalities.',
    obj({ candidateId: S('Candidate id') }, ['candidateId']),
    (a, exec) => impactOf(dirOf(ctx, exec, config), a.candidateId),
    v => `影响面：${v.summary}`)

  tool('recruit_workbench', 'One read for the workbench UI: dashboard with period-over-period deltas, risk-sorted inbox, selected candidate detail (resume, scores, quotable evidence, three doubts), causal timeline, impact surface and contracts.',
    obj({ candidateId: S('Optional selected candidate id') }, []),
    (a, exec) => workbenchData(dirOf(ctx, exec, config), a.candidateId, buildDashboard),
    v => `工作台数据：收件箱 ${v.inbox.length} 条｜选中 ${v.selectedId || '无'}｜看板 KPI ${v.dashboard.kpis.length} 项｜节点 ${v.dashboard.nodes.length} 个`)

  tool('recruit_replay', 'Replay one candidate or position: the full causal chain (seq, actor, event type, evidence, standard versions, causedBy) so any conclusion can be traced back to the event and rule version that produced it. This is what "沉淀流程" means.',
    obj({ subjectId: S('Candidate or position id'), limit: N('Max events, default 40') }, ['subjectId']),
    (a, exec) => { const d = dirOf(ctx, exec, config); migrateLegacy(d); const r = replay(d, a.subjectId); return { ...r, chain: r.chain.slice(-(a.limit || 40)) } },
    v => `回放 · ${v.subjectId}（${v.eventCount} 条事件）\n当前规范：${JSON.stringify(v.currentStandard)}\n首次事件时规范：${JSON.stringify(v.standardAtFirstEvent)}\n\n${(v.chain || []).map(e => `#${e.seq} ${e.ts.slice(0, 19)} [${e.actor}] ${e.type}${e.cause ? ` ← #${e.cause.seq} ${e.cause.type}(${e.cause.actor})` : ''}\n   basedOn=${JSON.stringify(e.basedOn)}｜inputHash=${e.inputHash || '—'}｜causedBy=${e.causedBy === null ? 'null' : '#' + e.causedBy}\n   证据 ${(e.evidence || []).join(' / ') || '—'}`).join('\n') || '(无事件)'}`)

  tool('recruit_standards', 'List the standard version chain and calibration clusters. A calibration produces standard.proposed → standard.validated → standard.released; old versions are never deleted, so 标准漂移 is detectable and historical conclusions reproducible.',
    obj({}), (_a, exec) => { const d = dirOf(ctx, exec, config); migrateLegacy(d); return standardVersions(d) },
    v => `规范版本链\n当前：${JSON.stringify(v.current)}\n已发布：${v.released.length}｜建议：${v.proposals.length}｜验证：${v.validations.length}\n\n校准聚类：\n${(v.calibrationClusters || []).map(x => `${x.key} ×${x.count}${x.ready ? ' → 已生成变更建议，待回归验证' : ''}`).join('\n') || '(无)'}`)

  tool('recruit_drill', '数据穿透：从看板指标 / 阶段 / 渠道下钻到候选人名单，带原件留档路径、事件数与最近一条事件。',
    obj({ metric: S('candidates / pending / evaluated / hired / active'), stage: S('Filter by stage'), source: S('Filter by source channel') }, []),
    (a, exec) => drill(dirOf(ctx, exec, config), a),
    v => `下钻 · ${v.criteria}（${v.count}）\n` + (v.items || []).map(x => `${x.id} ${x.name || x.title} · ${x.stage || x.status} · 事件 ${x.eventCount || 0} · 原件 ${(x.files || []).length}`).join('\n'))

  tool('recruit_report', 'Aggregate funnel, source distribution and efficiency metrics from the ledger. Source channels are statistics only.',
    obj({}), (_a, exec) => {
      const d = dirOf(ctx, exec, config); migrateLegacy(d)
      const s = fold(d), cs = s.candidates
      const evaluated = cs.filter(c => c.scores).length
      const auto = cs.filter(c => c.route && c.route.indexOf('高置信') >= 0).length
      return { total: cs.length, ledgerEvents: s.eventCount, funnel: s.byStage, sources: s.bySource, evaluated, autoRate: cs.length ? Math.round(auto / cs.length * 100) : 0, hired: s.byStage['已入职'] || 0, rejected: s.byStage['已淘汰'] || 0, calibration: s.calibration.length }
    }, v => `招聘报表\n事件账本 ${v.ledgerEvents} 条｜候选人 ${v.total}｜已评估 ${v.evaluated}｜已入职 ${v.hired}｜淘汰 ${v.rejected}｜纠偏 ${v.calibration}\n免人工率（执行环节）${v.autoRate}%\n漏斗：${Object.entries(v.funnel || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' / ')}\n渠道：${Object.entries(v.sources || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' / ')}`)

  /* ============ Client 交互端点 ============ */
  // 工作台一次拉取：看板 + 收件箱 + 选中候选人详情 + 因果链 + 契约
  // 面试官免登录页面：GET /interview?token=xxx 返回自包含 HTML（面试官手机/电脑直接打开）
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/interview',
    resource: async (request) => {
      const u = new URL(request.url); const token = u.searchParams.get('token') || ''
      let brief = null, errMsg = ''
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const hit = findByInterviewToken(d, token)
        if (!hit) errMsg = '链接无效或已过期，请联系招聘HR重新获取。'
        else {
          const s = fold(d); const c = s.byId[hit.candidateId] || {}
          const p = s.positions.find(x => x.id === c.pid) || {}
          brief = { name: c.name || '', stage: c.stage || '', resume: String(c.resume || '').slice(0, 8000), pos: p.title || '',
            round: hit.interview.round || '初试', at: hit.interview.at || '', place: hit.interview.place || '', interviewer: hit.interview.interviewer || '',
            grade: (c.deep && c.deep.grade) || '', score: c.weighted != null ? c.weighted : null, summary: c.summary || '',
            alignment: (c.deep && c.deep.alignment) || [], doubts: c.doubts || [],
            already: readEvents(d).some(e => e.type === 'feedback.submitted' && (e.subject || {}).id === hit.candidateId && (e.payload || {}).interviewerToken === token) }
        }
      } catch (e) { errMsg = String(e && e.message || e) }
      const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]))
      const html = interviewerPageHtml(token, brief, errMsg, esc)
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
    },
  }))
  // ===== 面试官协作端点（凭 token 免登录：读档案 + 交面评）=====
  // 从所有 interview.scheduled 事件里按 token 找到 候选人+面试信息
  function findByInterviewToken(d, token) {
    if (!token) return null
    const evs = readEvents(d)
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i]
      if (e.type === 'interview.scheduled' && (e.payload || {}).token === token) {
        return { candidateId: (e.subject || {}).id, interview: e.payload, seq: e.seq }
      }
    }
    return null
  }
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/interviewer-get',
    resource: async (request) => {
      try {
        const u = new URL(request.url); const token = u.searchParams.get('token') || ''
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const hit = findByInterviewToken(d, token)
        if (!hit) return new Response(JSON.stringify({ ok: false, error: '链接无效或已过期' }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
        const s = fold(d); const c = s.byId[hit.candidateId] || {}
        const p = s.positions.find(x => x.id === c.pid) || {}
        // 只读、脱敏：不返回电话/邮箱全量；提供简历+AI诊断+验证清单
        const brief = {
          ok: true, candidate: { name: c.name || '', stage: c.stage || '', resume: (c.resume || '').slice(0, 8000) },
          position: { title: p.title || '' },
          round: hit.interview.round || '初试', at: hit.interview.at || '', place: hit.interview.place || '', interviewer: hit.interview.interviewer || '',
          ai: { grade: (c.deep && c.deep.grade) || '', score: c.weighted != null ? c.weighted : null, summary: c.summary || '',
            alignment: (c.deep && c.deep.alignment) || [], doubts: c.doubts || [], gateResults: c.gateResults || [] },
          alreadyFeedback: (readEvents(d).filter(e => e.type === 'feedback.submitted' && (e.subject || {}).id === hit.candidateId && (e.payload || {}).interviewerToken === token).length > 0),
        }
        return new Response(JSON.stringify(brief), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 500 }) }
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/interviewer-submit',
    handler: async (req, res) => {
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const hit = findByInterviewToken(d, String(a.token || ''))
        if (!hit) { replyJson(res, 404, { ok: false, error: '链接无效或已过期' }); return }
        const cid = hit.candidateId
        const c = fold(d).byId[cid]
        if (!c) { replyJson(res, 400, { ok: false, error: '候选人不存在' }); return }
        const name = String(a.interviewer || hit.interview.interviewer || '面试官').trim().slice(0, 20)
        // 面试官提交：只写 feedback.submitted（actor=human，标注 interviewer 及 token 来源），不直接拍板录用
        const ev = appendEvent(d, { type: 'feedback.submitted', actor: 'human', subject: { kind: 'candidate', id: cid },
          payload: { interviewer: name, interviewerToken: String(a.token || ''), byInterviewer: true, round: hit.interview.round || '初试',
            score: a.score == null || a.score === '' ? null : Number(a.score), pass: a.pass !== false, note: String(a.note || '').slice(0, 1000),
            dims: (a.dims && typeof a.dims === 'object' && !Array.isArray(a.dims)) ? Object.keys(a.dims).map(k => ({ dim: k, level: a.dims[k] })) : (a.dims || null),
            recommend: String(a.recommend || '') }, causedBy: hit.seq })
        replyJson(res, 200, { ok: true, seq: ev.seq, message: '面评已提交给招聘团队' })
      } catch (e) { replyJson(res, 400, { ok: false, error: String(e && e.message || e) }) }
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/workbench',
    resource: async (request) => {
      try {
        const url = new URL(request.url)
        const cid = url.searchParams.get('candidateId') || null
        const period = url.searchParams.get('period') || 'all'
        const d = config && config.dataDir
          ? config.dataDir
          : join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')
        ensure(d)
        return new Response(JSON.stringify(workbenchData(d, cid, buildDashboard, { period })), {
          status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
          status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }
    },
  }))

  // 界面动作：POST 走与 recruit_* 工具完全相同的 performAction()，界面动作 == 一次工具调用。
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/action',
    handler: async (req, res) => {
      const reply = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST') { reply(405, { error: 'POST only' }); return }
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 64 * 1024) { reply(413, { error: 'body too large' }); return }
        }
        const a = JSON.parse(raw || '{}')
        const d = config && config.dataDir
          ? config.dataDir
          : join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')
        ensure(d)
        // 初筛动作统一走评估主入口（决策不再散落）
        let result
        if (a.action === 'auto_assess' && a.candidateId) {
          const r = await assessCandidate(d, a.candidateId)
          result = r.ok
            ? { ok: true, candidateId: a.candidateId, action: a.action, route: r.route, to: r.to, diag: r.diag, engine: r.engine, seq: r.seq }
            : { ok: false, pending: true, engine: r.engine || 'pending-llm', reason: r.reason, message: r.message, needsRetry: true, candidateId: a.candidateId }
        } else {
          result = performAction(d, a)
        }
        // 绑岗后：AI 门槛增强（补门槛人话依据）
        if (result && result.ok && a.action === 'bind_position' && (a.candidateId || result.candidateId)) {
          try { await enhanceGatesWithAI(d, a.candidateId || result.candidateId) } catch (e) {}
        }
        reply(200, result)
      } catch (e) {
        reply(400, { error: String(e && e.message || e) })
      }
    },
  }))

  /* ============ 接入层端点：上传 / 下钻 / 留档 ============ */
  const replyJson = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readPost = async (req, res, cap) => {
    if (req.method !== 'POST') { replyJson(res, 405, { error: 'POST only' }); return null }
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > cap) { replyJson(res, 413, { error: 'body too large' }); return null }
    }
    try { return JSON.parse(raw || '{}') } catch (e) { replyJson(res, 400, { error: 'invalid JSON' }); return null }
  }
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/upload',
    handler: async (req, res) => {
      const a = await readPost(req, res, 30 * 1024 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const out = handleUpload(d, a, {
          pythonPath: config.pythonPath || process.env.DSH_PYTHON, scriptDir: SCRIPT_DIR,
        })
        // 全自动：接入 → （无岗位则先匹配岗位）→ 绑定 → 按该岗位评分卡初筛 → 分流
        if (out && out.ok && out.candidateId) {
          try {
            let cid0 = out.candidateId
            let cand0 = fold(d).byId[cid0]
            // 第一步：没指定岗位 → 按简历自动匹配最合适的在招岗位
            if (cand0 && !cand0.pid) {
              const { matchPositions } = await import('./match.js')
              const pos0 = fold(d).positions
              const m = matchPositions({ resume: cand0.resume }, pos0)
              out.match = m ? { confident: m.confident, best: m.best ? { title: m.best.title, score: m.best.score } : null, ranked: (m.ranked || []).slice(0, 3).map(x => ({ title: x.title, score: x.score })) } : null
              if (m && m.confident && m.best) {
                // 自动绑定到匹配岗位（写 bind 事件）
                performAction(d, { action: 'bind_position', candidateId: cid0, positionId: m.best.positionId })
                out.autoBind = { positionId: m.best.positionId, title: m.best.title, score: m.best.score }
              } else {
                // 匹配不确定 → 留「待分配岗位」，不硬筛
                out.needsPosition = true
              }
            }
            // 第二步：已绑定岗位 → 初筛
            cand0 = fold(d).byId[cid0]
            if (cand0 && cand0.pid) {
              const ra = await assessCandidate(d, cid0)
              if (ra.ok) out.autoScreen = { route: ra.route, to: ra.to || null, engine: ra.engine }
              else out.autoScreen = { pending: true, engine: ra.engine || 'pending-llm', message: ra.message || ra.reason, needsRetry: true }
            }
          } catch (e) { out.autoScreen = { error: String(e && e.message || e) } }
        }
        replyJson(res, 200, out)
      } catch (e) { replyJson(res, 400, { error: String(e && e.message || e) }) }
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/drill',
    resource: async (request) => {
      try {
        const u = new URL(request.url)
        const q = { metric: u.searchParams.get('metric') || '', stage: u.searchParams.get('stage') || '', source: u.searchParams.get('source') || '' }
        return new Response(JSON.stringify(drill(dataDir(), q)), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
      } catch (e) { return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500 }) }
    },
  }))
  // 关岗前影响面：列出该职位在途候选人
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/llm-probe',
    resource: async () => {
      const out = { hasCtx: !!ctx, providers: [], chunks: [], text: '', errors: [] }
      try {
        const llm = (typeof ctx.get === 'function' && ctx.get('llm')) || ctx.llm
        out.hasLlm = !!llm
        out.hasStream = !!(llm && typeof llm.stream === 'function')
        try { out.providers = (llm && typeof llm.listProviders === 'function') ? await llm.listProviders() : 'no-listProviders' } catch (e) { out.errors.push('providers:' + e.message) }
        if (out.hasStream) {
          const prov = (config && config.jdProvider) || 'magpie'
          const model = (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash'
          out.used = { prov, model }
          let n = 0
          for await (const chunk of llm.stream({ provider: prov, model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：你好' }] }] })) {
            if (n < 6) out.chunks.push({ type: chunk && chunk.type, keys: chunk ? Object.keys(chunk) : null, text: chunk && typeof chunk.text === 'string' ? chunk.text.slice(0, 40) : null })
            n++
            if (chunk && typeof chunk.text === 'string') out.text += chunk.text
            if (n > 200) break
          }
          out.chunkCount = n
          out.usable = !!(out.text && out.text.trim())
          if (!out.usable) out.hint = 'LLM 无有效返回：检查网关额度/账号。AI 初筛将保持等待，不使用规则替代。'
        }
      } catch (e) {
        out.errors.push('stream:' + String(e && e.message || e))
        out.usable = false
        out.hint = 'LLM 调用异常：' + String(e && e.message || e)
      }
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/insights',
    handler: async (req, res) => {
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        // POST + question：对数据追问（对话式）
        if (req.method === 'POST') {
          const a = await readPost(req, res, 16 * 1024)
          if (!a) return
          const q = String(a.question || '').trim()
          if (q) {
            const w2 = workbenchData(d, null, buildDashboard); const dd2 = w2.dashboard || {}
            const snap2 = { kpis:(dd2.kpis||[]).map(k=>k.label+'='+k.value+(k.unit||'')), hiring:(dd2.hiring||[]).map(h=>({岗位:h.title,需求:h.hc,在途:h.inFlow,缺口:h.gap})), funnel:(dd2.pipeline||[]).map(p=>p.label+':'+p.count), sourceFunnel:(dd2.sourceFunnel||[]).map(x=>({渠道:x.source,投递:x.total,进面:x.interview})), gradeDist:(dd2.aiPerf||{}).gradeDist||{} }
            const prompt = ['你是资深招聘分析专家，基于以下真实数据回答用户的问题。','只依据数据推理，不要编；数据不足就说不足。回答简洁、给可执行建议，2-4 句。','数据：'+JSON.stringify(snap2),'用户问题：'+q].join('\\n')
            const ans = await llmText(prompt)
            replyJson(res, 200, { ok: true, answer: String(ans || '').trim() })
            return
          }
        }
        const w = workbenchData(d, null, buildDashboard)
        const dd = w.dashboard || {}
        const snap = {
          kpis: (dd.kpis || []).map(k => k.label + '=' + k.value + (k.unit || '')),
          hiring: (dd.hiring || []).map(h => ({ 岗位: h.title, 需求: h.hc, 已入职: h.hired, 在途: h.inFlow, 缺口: h.gap, 在途分布: h.stageDist || {} })),
          funnel: (dd.pipeline || []).map(p => p.label + ':' + p.count),
          sourceFunnel: (dd.sourceFunnel || []).map(x => ({ 渠道: x.source, 投递: x.total, 进面: x.interview, Offer: x.offer, 进面率: x.toInterview })),
          stageTime: (dd.stageTime || []).filter(x => x.avg != null).map(x => x.stage + '停留' + x.avg + '天'),
          gradeDist: (dd.aiPerf || {}).gradeDist || {},
          ica: dd.cycle || {},
          offerAccept: dd.offerAccept || {},
          trend: (w.trend || []).slice(-7).map(t => ({ 日期: t.date, 候选: t.candidates, 已评估: t.evaluated })),
        }
        // 业务痛点（从岗位上下文取，若有）
        try { const p0 = fold(d).positions.find(x => x.context && x.context.stage); if (p0) snap.painPoint = p0.context.stage + '｜' + (p0.context.teamGap || '') } catch (e) {}
        const r = await llmText(buildInsightPrompt(snap))
        const m = String(r || '').match(/\{[\s\S]*\}/)
        const parsed = m ? JSON.parse(m[0]) : null
        replyJson(res, 200, parsed && parsed.insights ? { ok: true, insights: parsed.insights } : { ok: false, error: '解析失败', raw: String(r).slice(0, 200) })
      } catch (e) { replyJson(res, 500, { ok: false, error: String(e && e.message || e) }) }
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/position-impact',
    resource: async (request) => {
      try {
        const u = new URL(request.url)
        const pid = u.searchParams.get('positionId') || ''
        const { positionImpact } = await import('./actions.js')
        return new Response(JSON.stringify(positionImpact(dataDir(), pid)), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), { status: 500 }) }
    },
  }))
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/archive',
    resource: async () => new Response(JSON.stringify(archive(dataDir())), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }),
  }))

  // 邮箱：界面「立即收信」触发本地 IMAP/POP3 抓取并入库
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/fetch-mail',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const { spawnSync } = await import('node:child_process')
        const py = config.pythonPath || process.env.DSH_PYTHON
          || '/Users/andyzhang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3'
        const d = dataDir()
        const cfgPath = join(d, 'mail.json')
        const args = [join(SCRIPT_DIR, 'fetch_mail.py'), '--config', cfgPath]
        if (a.dryRun) args.push('--dry-run')
        else args.push('--upload', a.guiUrl || 'http://127.0.0.1:62947')
        if (a.check) args.length = 0, args.push(join(SCRIPT_DIR, 'fetch_mail.py'), '--config', cfgPath, '--check')
        const r = spawnSync(py, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
        const out = (r.stdout || '').trim().split('\n').pop()
        let parsed
        try { parsed = JSON.parse(out) } catch (e) { parsed = { ok: false, error: (r.stderr || out || '脚本无输出').slice(0, 300) } }
        replyJson(res, parsed.ok ? 200 : 400, parsed)
      } catch (e) { replyJson(res, 400, { error: String(e && e.message || e) }) }
    },
  }))

  // 邮箱配置：GET 回显（不含密码）/ POST 保存
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/mail-config',
    handler: async (req, res) => {
      const d = dataDir()
      if (req.method === 'GET') {
        try {
          const cfg = JSON.parse(readFileSync(join(d, 'mail.json'), 'utf8'))
          delete cfg.password
          replyJson(res, 200, { ok: true, configured: true, config: cfg })
        } catch (e) { replyJson(res, 200, { ok: true, configured: false, config: {} }) }
        return
      }
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        ensure(d)
        const cfg = {
          protocol: a.protocol || 'imap', host: a.host || '', port: Number(a.port) || 993,
          ssl: a.ssl !== false, user: a.user || '', password: a.password || '',
          folder: a.folder || 'INBOX', criteria: a.criteria || 'UNSEEN',
          limit: Number(a.limit) || 50, markSeen: false, dataDir: d,
          source: a.source || '网投', defaultPositionId: a.defaultPositionId || '',
        }
        writeFileSync(join(d, 'mail.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
        replyJson(res, 200, { ok: true, configured: !!(cfg.host && cfg.user && cfg.password) })
      } catch (e) { replyJson(res, 400, { error: String(e && e.message || e) }) }
    },
  }))

  // AI 一键初筛：对全部待评估候选人批量自动评估
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/auto-assess',
    handler: async (req, res) => {
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const s = fold(d)
        let ids = a.candidateId ? [a.candidateId]
          : s.candidates.filter(c => c.stage === '待评估' || (!c.pid && c.stage !== '已淘汰')).map(c => c.id)
        const done = [], failed = [], matched = []
        const { matchPositions } = await import('./match.js')
        for (const id of ids) {
          try {
            let cc = fold(d).byId[id]
            // 补筛前置：无岗位的先自动匹配绑定（复用与上传相同的逻辑）
            if (cc && !cc.pid) {
              const m = matchPositions({ resume: cc.resume }, fold(d).positions)
              if (m && m.confident && m.best) {
                performAction(d, { action: 'bind_position', candidateId: id, positionId: m.best.positionId })
                matched.push({ id, title: m.best.title, score: m.best.score })
              } else { failed.push({ id, error: '未匹配到明确岗位，需人工分配', needsPosition: true }); continue }
            }
            done.push(performAction(d, { action: 'auto_assess', candidateId: id }))
          } catch (e) { failed.push({ id, error: String(e && e.message || e) }) }
        }
        replyJson(res, 200, { ok: true, assessed: done.length, failed, matched, results: done.map(x => ({ id: x.candidateId, route: x.route, conf: x.conf, undetermined: x.undetermined, to: x.to })) })
      } catch (e) { replyJson(res, 400, { error: String(e && e.message || e) }) }
    },
  }))

  // 由 JD 生成评分卡：双轨制（硬门槛 + 软价值权重），LLM 生成 + 规则兜底
  const SC_PROMPT = (p, jd) => [
    '# Role',
    '你是一位资深招聘专家与数据分析师。',
    '',
    '# Task',
    '根据以下【岗位信息】与【岗位职责说明书】设计一份科学的 AI 初筛评分卡（100 分制，双轨制）。',
    '岗位名称：' + (p.title || '') + '；部门：' + (p.dept || '') + '；城市：' + (p.city || ''),
    '硬门槛：' + (p.gates || '无'),
    '能力项：' + (p.abilities || '无'),
    '岗位核心目的：' + (jd && jd.corePurpose || ''),
    '核心职责：' + ((jd && jd.responsibilities || []).map(r => r.action + r.content).join('；') || ''),
    '业务背景/重点：' + (p.businessContext || (jd && jd.meta && jd.meta.basedOnBusiness) || '无'),
    '',
    '# 设计要求',
    '1. 第一轨硬性门槛（Hard Gate）：学历/年限/赛道/必备资质等，一票否决项，逐条列出。**禁止**把跳槽频率、单段在职时长、空窗期作为硬门槛或负面项（除非岗位有明确法律/合规要求）。',
    '2. 第二轨业务价值与能力匹配（Soft Value）：过往战绩与量化成果、技能深度、成长性等维度，给权重与打分档（低/中/高对应分数区间）。',
    '3. 行为动词与量化结果导向：有"场景+动作+结果(带数字)"计分，仅"负责/参与/了解"不计分。',
    '4. 剔除伪相关与歧视性指标（性别/年龄/婚育/院校歧视/星座等）。**不得以跳槽频率、在职时间短作为稳定性负面评价**——这类信号易构成对特定人群的隐性歧视（如生育期女性、行业周期从业者），应关注其真实能力与产出，而非停留时长。',
    '5. 动态对齐业务：把当前业务重点转化为加权项。',
    '',
    '# Output Format',
    '输出结构化 Markdown：硬性门槛清单；软价值维度表（维度|权重|打分档说明）；反伪相关说明。只输出正文。',
  ].join('\n')

  async function llmGenerateScorecard(p, jd) {
    const llm = (typeof ctx.get === 'function' && ctx.get('llm')) || ctx.llm
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }
    const provider = (config && config.jdProvider) || 'magpie'
    const model = (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash'
    let text = ''
    try {
      for await (const chunk of llm.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: SC_PROMPT(p, jd) }] }] })) {
        if (chunk && typeof chunk.text === 'string' && chunk.type !== 'block-start') text += chunk.text
      }
    } catch (e) { return { ok: false, reason: 'llm-error: ' + String((e && e.message) || e) } }
    text = (text || '').trim()
    if (text.length < 40) return { ok: false, reason: 'llm-empty' }
    return { ok: true, markdown: text, provider, model }
  }

  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/generate-scorecard',
    handler: async (req, res) => {
      const a = await readPost(req, res, 128 * 1024)
      if (!a) return
      try {
        const jd = a.jdObj || null
        const g = await llmGenerateScorecard(a, jd)
        // 规则版始终算出结构化骨架；LLM 版用于覆盖/补充展示
        const sc = ruleScorecard(a, jd)
        if (g.ok) {
          // LLM 成功：用 LLM 文本作为权威原文，结构仍用规则骨架（保证可解析可评分）
          sc.meta.generatedBy = 'llm+' + sc.meta.generatedBy
          sc.meta.llmMarkdown = g.markdown
          sc.meta.llmProvider = g.model
        } else {
          sc.meta.llmError = g.reason
        }
        sc.title = a.title || ''
        const markdown = g.ok ? g.markdown : scorecardToMarkdown(sc, a.title)
        replyJson(res, 200, { ok: true, source: g.ok ? 'llm' : 'rule', scorecard: sc, markdown, llmError: g.ok ? undefined : g.reason })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // 用评分卡给候选人简历打分（结构化评估报告：总分/分项/优势/风险），LLM + 规则兜底
  const SCORE_PROMPT = (sc, resume, title) => [
    '# Role', '你是一位资深的招聘专家与数据分析师。', '',
    '# Task',
    '请根据以下【岗位评分卡】与【候选人简历文本】，客观量化打分（总分100分），输出结构化评估报告。', '',
    '# 评分卡',
    '岗位：' + (title || ''),
    '硬性门槛（一票否决）：' + (sc.hardGates || []).map(g => g.item).join('；'),
    '软价值维度与权重：' + (sc.softDims || []).map(d => d.name + '(' + d.weight + '%)').join('；'),
    sc.businessFocus ? '业务重点对齐：' + sc.businessFocus : '', '',
    '# 评分规则',
    '1. 先查硬性门槛，任一不满足则总分归零并标记不推荐。',
    '2. 各软价值维度按权重打分，必须有简历原文依据；仅"负责/参与/了解"不计分，需"场景+动作+结果(带数字)"。',
    '3. 剔除伪相关与歧视性指标。', '',
    '# 简历文本', String(resume || '').slice(0, 6000), '',
    '# Output Format',
    '1. 【总得分】XX 分',
    '2. 【分项得分表】各维度得分及扣分原因（含原文依据）',
    '3. 【核心优势总结】2-3 条最匹配亮点',
    '4. 【潜在风险/存疑点】建议面试重点核查项',
    '只输出正文。',
  ].join('\n')

  async function llmScoreResume(sc, resume, title) {
    const llm = (typeof ctx.get === 'function' && ctx.get('llm')) || ctx.llm
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }
    const provider = (config && config.jdProvider) || 'magpie'
    const model = (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash'
    let text = ''
    try {
      for await (const chunk of llm.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: SCORE_PROMPT(sc, resume, title) }] }] })) {
        if (chunk && typeof chunk.text === 'string' && chunk.type !== 'block-start') text += chunk.text
      }
    } catch (e) { return { ok: false, reason: 'llm-error: ' + String((e && e.message) || e) } }
    text = (text || '').trim()
    if (text.length < 30) return { ok: false, reason: 'llm-empty' }
    return { ok: true, markdown: text, provider, model }
  }

  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/score-resume',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const s = fold(d)
        const c = s.byId[a.candidateId]
        if (!c) { replyJson(res, 400, { error: 'candidate not found: ' + a.candidateId }); return }
        const p = s.positions.find(x => x.id === c.pid) || {}
        let sc = (p && p.scorecard) || null
        if (!sc && p) sc = ruleScorecard(p, p.jdObj || null)
        if (!sc) sc = ruleScorecard({ title: p.title, dept: p.dept }, null)
        const g = await llmScoreResume(sc, c.resume, p.title)
        // 解析总分
        let total = null
        if (g.ok) { const m = g.markdown.match(/(?:总得分|总分)[^\d]{0,6}(\d{1,3})/); if (m) total = Number(m[1]) }
        // 记录评分事件（评估也入账本，可追溯）
        const ev = recordAssessment(d, {
          candidateId: c.id, route: total != null ? ('评分 ' + total + ' 分') : '评分待人工', conf: g.ok ? 0.8 : null,
          deep: { scorecardScore: { total, markdown: g.ok ? g.markdown : '', source: g.ok ? 'llm' : 'rule' }, engine: 'scorecard' },
          partial: true,  // 评分卡预览，不覆盖已有评估结论
          basedOn: { l0: 'v1.2', l1: 'v1', rule: 'v2-dual-track', model: g.ok ? g.model : 'rule' },
          inputHash: hash(c.resume || ''), causedBy: c.seqs ? c.seqs[c.seqs.length - 1] : null,
        })
        replyJson(res, 200, { ok: true, candidateId: c.id, total, source: g.ok ? 'llm' : 'rule', report: g.ok ? g.markdown : scorecardToMarkdown(sc, p.title), llmError: g.ok ? undefined : g.reason, seq: ev.seq })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // 深度适配性评估：LLM 按资深 HRBP 范式诊断（场景对齐/证据链/双向证伪/面试题）
  async function llmDeepAssess(prompt) {
    const llm = (typeof ctx.get === 'function' && ctx.get('llm')) || ctx.llm
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }
    const provider = (config && config.jdProvider) || 'magpie'
    const model = (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash'
    let text = ''
    try {
      for await (const chunk of llm.stream({ provider, model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })) {
        if (chunk && typeof chunk.text === 'string' && chunk.type !== 'block-start') text += chunk.text
      }
    } catch (e) { return { ok: false, reason: 'llm-error: ' + String((e && e.message) || e) } }
    return { ok: true, text }
  }

  // 统一取 LLM 文本（llmDeepAssess 返回 {ok,text}，直接当字符串用会把对象喂给 JSON.parse）
  // ===== AI 数据洞察：读全局招聘数据 → 跨维度因果推理 → 有价值的建议（不是复述数字）=====
  function buildInsightPrompt(snap) {
    const ctx = JSON.stringify(snap, null, 1)
    return [
      '# 角色',
      '你是资深招聘分析专家（懂招聘全链路 + 数据推理）。给你当前招聘的完整数据快照，你要输出「人一眼看不出来」的深度洞察。',
      '',
      '# 铁律（极重要）',
      '1. 禁止复述数字或说废话（如"缺口2人需招人"这种常识不要说）。每条洞察必须包含【因果关系/权衡/预警/归因】，是人自己不会去算的。',
      '2. 要有推理链：从数据观察到 → 推断原因 → 预判后果 → 给具体动作。',
      '3. 找跨维度的关联：如"某渠道投递多但0进面 × 该岗C档占比高"说明渠道与岗位错配；"在途人数×各环节停留时间"推算真实缺口填补周期。',
      '4. 发现异常要归因，不要只说现象。',
      '5. 数据不足以下结论时，明说"数据还少，暂无法判断，建议积累X"。不要编。',
      '6. 每条洞察给出信心度（高/中/低）。',
      '',
      '# 数据快照',
      ctx,
      '',
      '# 业务背景（辅助理解）',
      '招聘阶段痛点：' + (snap.painPoint || '未说明'),
      '',
      '# 输出严格 JSON',
      '{"insights":[{"headline":"一句话结论(含因果)","reasoning":"推理链：从观察到原因到后果","action":"具体可执行建议","impact":"影响(高/中/低)","confidence":"高/中/低","dim":"管理者|招聘执行|AI能力"}]}',
      'insights 3-5 条，按重要性排序。只输出 JSON。',
    ].join('\\n')
  }

  // AI 增强硬门槛分析：规则初筛后，用 LLM 读原文重判门槛，覆盖 gateResults 并重算等级（异步，失败不影响规则结论）
  async function enhanceGatesWithAI(d, candidateId) {
    try {
      const s0 = fold(d)
      const c = s0.byId[candidateId]
      if (!c || !c.pid) return null
      const p = s0.positions.find(x => x.id === c.pid)
      if (!p) return null
      const { buildGatePrompt, parseGateResult } = await import('./gatecheck.js')
      const r = await llmDeepAssess(buildGatePrompt(p, c.resume || ''))
      const parsed = r.ok ? parseGateResult(r.text) : null
      if (!parsed || !parsed.gates.length) return null
      const gateResults = parsed.gates.map(g => ({ gate: g.gate, verdict: g.verdict, reason: g.reason, evidence: g.evidence }))
      const hardFail = gateResults.some(g => g.verdict === 'fail')
      // 只写门槛结论，务必保留原 route/weighted/scores（否则覆盖丢分）
      recordAssessment(d, { candidateId,
        gateResults, summary: parsed.summary || '', partial: true,  // 门槛增强：partial，保留原 route/scores/weighted
        deep: c.deep || undefined,
        basedOn: { rule: 'gate-ai-v1' } })
      // 硬门槛一票否决：有明确证据不合格 → 直接淘汰（授权自动化，可复捞）。区别于"缺证据留人复核"
      if (hardFail) {
        const failed = gateResults.filter(g => g.verdict === 'fail').map(g => g.gate).join('、')
        const cur = (fold(d).byId[candidateId] || {})
        const NO_ELIM = ['已淘汰', '人才库', '已入职', 'Offer已发', 'Offer已接受', '待入职']
        if (NO_ELIM.indexOf(cur.stage) < 0) {
          appendEvent(d, { type: 'decision.made', actor: 'agent', actorId: 'ai-auto', subject: { kind: 'candidate', id: candidateId },
            payload: { decision: '淘汰', reason: '硬门槛未通过：' + failed + ' · 授权自动化，可激活复捞', from: cur.stage, auto: true, reversible: true, grade: 'C' },
            basedOn: { rule: 'gate-ai-v1' } })
        }
      }
      return { gateResults, summary: parsed.summary, hardFail }
    } catch (e) { return null }
  }

  // ===== BARS 核心评估（LLM 逐维判档 + 代码算分 + AI 硬门槛 + 分流）=====
  // 评价体系的真正核心：不是关键词匹配，是 LLM 读原文引用证据、对照行为锚点判 L0-L3 档位。
  // 返回 { ok, diag, tier, advanced, stackGate, seq } 或 { ok:false, reason }
  // ===== 评估主入口（唯一决策点）：所有"初筛/评估"都走这里，决策逻辑不再散落端点层 =====
  // 决策：有评分卡 → BARS 深评（内含技术栈闸门+规则硬门槛预检，不合格直接淘汰不进LLM）；
  //       无评分卡 → 规则 autoAssess 兜底。
  // 返回统一结构 { ok, engine, diag, route, to/advanced, seq }。
  // 评估主入口（唯一决策点）。原则：AI 筛选必须由 AI 完成 —— 不做静默降级。
  //   ① 硬门槛（规则可判的明确项）不符 → 直接淘汰（不烧 LLM）
  //   ② 其余一律走 BARS（LLM 逐维判档）
  //   ③ LLM 不可用 → 明确返回等待（pending-llm），绝不偷偷用规则冒充 AI 结论
  async function assessCandidate(d, candidateId) {
    const c0 = fold(d).byId[candidateId]
    if (!c0) return { ok: false, reason: 'candidate-not-found' }
    if (!c0.pid) return { ok: false, reason: '未关联岗位，无法评估。请先绑定岗位。' }
    const p0 = fold(d).positions.find(x => x.id === c0.pid)
    const hasSc = p0 && p0.scorecard && Array.isArray(p0.scorecard.softDims) && p0.scorecard.softDims.length
    if (!hasSc) return { ok: false, reason: 'no-scorecard', message: '该岗位无评分卡，无法 BARS 评估。请先在职位管理生成评分卡。' }
    const r = await runBarsAssess(d, candidateId)
    if (r && r.ok) return { ok: true, engine: r.stackGate || r.preGate ? 'rule-gate' : 'bars', diag: r.diag, route: r.diag && r.diag.route, to: r.advanced, seq: r.seq }
    // BARS 未产出：不降级、不落评估结论，明确告知等待 LLM
    const why = (r && r.reason) || 'unknown'
    const msg = why === 'no-valid-sample'
      ? 'AI 网关暂时不可用（BARS 判档无有效返回）。候选人保持待评估，AI 恢复后重新初筛即可 —— 不使用规则结论替代 AI 判断。'
      : ('BARS 评估未完成（' + why + '）。候选人保持待评估，请稍后重试。')
    return { ok: false, engine: 'pending-llm', reason: why, message: msg, needsRetry: true }
  }

  async function runBarsAssess(d, candidateId) {
    const s = fold(d)
    const c = s.byId[candidateId]
    if (!c) return { ok: false, reason: 'candidate-not-found' }
    const p = s.positions.find(x => x.id === c.pid) || { title: '' }
    // 1) 技术栈硬闸门（跨栈错配直接不匹配，避免 LLM 浪费）
    const stack = techStackFit(p, c.resume || '')
    if (stack.fit === 'mismatch') {
      const ev = recordAssessment(d, { candidateId: c.id,
        deep: { grade: 'C', score: 20, conclusion: '技术栈不对口｜' + stack.reason, alignment: [], stackFit: stack, engine: 'stack-gate' },
        conf: 0.9, route: 'C 级 · 技术栈不对口', action: stack.reason, conclusion: 'reject', tier: '', scores: {}, weighted: 20, summary: '技术栈不对口｜' + stack.reason,
        basedOn: { rule: 'stack-gate', model: 'rule' }, inputHash: hash(c.resume || ''), causedBy: c.seqs && c.seqs.length ? c.seqs[c.seqs.length - 1] : null })
      const canAdvC = ['待评估', '待初试', '待发 Offer'].indexOf(c.stage) >= 0
      if (canAdvC) appendEvent(d, { type: 'decision.made', actor: 'agent', actorId: 'ai-auto', subject: { kind: 'candidate', id: c.id },
        payload: { decision: '淘汰', reason: '技术栈不对口（' + stack.reason + '）', from: c.stage, auto: true, reversible: true, grade: 'C', score: 20 }, causedBy: ev.seq })
      return { ok: true, diag: { grade: 'C', score: 20, conclusion: '技术栈不对口｜' + stack.reason, stackFit: stack, alignment: [] }, advanced: canAdvC ? '已淘汰' : null, stackGate: true, seq: ev.seq }
    }
    // 2) 规则硬门槛预检（提效关键）：学历/专业/年限等能规则可靠判的，明确 fail 直接淘汰，不进 BARS（省 LLM）
    //    判不准（pending）的才继续 BARS 深评——不误杀"简历没写全但其实合格"的人
    const { evaluateGate } = await import('./assess.js')
    const gateList = (p.scorecard && p.scorecard.hardGates)
      ? p.scorecard.hardGates.map(g => typeof g === 'string' ? g : g.item)
      : (p.gates || [])
    if (gateList.length) {
      // 只对「真·硬性门槛」规则预检：含"优先/加分/期望/最好/有…更好"的是软性偏好，规则判不了，一律交 BARS（避免把"硕士优先"误当"必须硕士"误杀）
      const SOFT = /优先|加分|期望|最好|更佳|更好|preferred|nice to have|职责|负责|参与|完成|搭建|熟悉|了解|掌握/i
      const HARD_ONLY = gateList.filter(g => !SOFT.test(String(g)))
      const preGate = HARD_ONLY.map(g => { const r = evaluateGate(g, c.resume || ''); return { gate: g, verdict: r.verdict, reason: r.reason } })
      const preFail = preGate.filter(g => g.verdict === 'fail')
      if (preFail.length) {
        // 规则明确判不合格 → 直接淘汰，不进 BARS
        const ev = recordAssessment(d, { candidateId: c.id,
          deep: { grade: 'C', score: 20, conclusion: '硬门槛未通过｜' + preFail.map(g => g.gate).join('、'), alignment: [], gateResults: preGate, engine: 'rule-gate' },
          conf: 0.9, route: 'C 级 · 硬门槛未通过：' + preFail.map(g => g.gate).join('、'), action: '硬门槛未通过', conclusion: 'reject', tier: '', scores: {}, weighted: 20,
          summary: '硬门槛未通过（规则预检）｜' + preFail.map(g => g.gate + '：' + g.reason).join('；'), gateResults: preGate,
          basedOn: { rule: 'rule-gate', model: 'rule' }, inputHash: hash(c.resume || ''), causedBy: c.seqs && c.seqs.length ? c.seqs[c.seqs.length - 1] : null })
        const canAdv0 = ['待评估', '待初试', '待发 Offer'].indexOf(c.stage) >= 0
        if (canAdv0) appendEvent(d, { type: 'decision.made', actor: 'agent', actorId: 'ai-auto', subject: { kind: 'candidate', id: c.id },
          payload: { decision: '淘汰', reason: '硬门槛未通过（规则预检）：' + preFail.map(g => g.gate).join('、') + ' · 授权自动化，可激活复捞', from: c.stage, auto: true, reversible: true, grade: 'C', score: 20 }, causedBy: ev.seq })
        return { ok: true, diag: { grade: 'C', score: 20, conclusion: '硬门槛未通过｜' + preFail.map(g => g.gate).join('、'), gateResults: preGate, alignment: [], engine: 'rule-gate' }, advanced: canAdv0 ? '已淘汰' : null, preGate: true, seq: ev.seq }
      }
    }
    // 3) 无评分卡 → 无法 BARS
    if (!(p.scorecard && Array.isArray(p.scorecard.softDims) && p.scorecard.softDims.length)) return { ok: false, reason: 'no-scorecard' }
    // 3) BARS 三档采样取众数，代码算分
    const barsPrompt = buildBarsPrompt(p, c.resume || '')
    const samples = []
    for (let i = 0; i < 3; i++) { const r = await llmDeepAssess(barsPrompt); const v = r.ok ? parseBarsResult(r.text, p.scorecard) : null; if (v) samples.push(v) }
    if (!samples.length) return { ok: false, reason: 'no-valid-sample' }
    const verdicts = consensusVerdicts(p.scorecard, samples)
    const scored = scoreFromVerdicts(p.scorecard, verdicts)
    // 4) 硬门槛：AI 读原文判断（失败回退规则）
    const { buildGatePrompt, parseGateResult } = await import('./gatecheck.js')
    let gateResults = null
    try {
      const gr = await llmDeepAssess(buildGatePrompt(p, c.resume || ''))
      const parsed = gr.ok ? parseGateResult(gr.text) : null
      if (parsed && parsed.gates.length) gateResults = parsed.gates.map(g => ({ gate: g.gate, verdict: g.verdict, reason: g.reason, evidence: g.evidence }))
    } catch (e) {}
    if (!gateResults) {
      const { evaluateGate } = await import('./assess.js')
      const gates = (p.scorecard.hardGates) ? p.scorecard.hardGates.map(g => typeof g === 'string' ? g : g.item) : (p.gates || [])
      gateResults = gates.map(g => { const r = evaluateGate(g, c.resume || ''); return { gate: g, verdict: r.verdict, reason: r.reason } })
    }
    const hardFail = gateResults.some(g => g.verdict === 'fail')
    let grade = scored.grade, score = scored.score, conclusion
    if (hardFail) { grade = 'C'; conclusion = '硬门槛未通过：' + gateResults.filter(g => g.verdict === 'fail').map(g => g.gate).join('、') }
    else conclusion = grade === 'S' ? '高度契合' : grade === 'A' ? '基本胜任' : grade === 'B' ? '勉强匹配有短板' : '不建议推进'
    const act = gradeToAction(grade)
    const weak = scored.alignment.filter(a => a.level === 'L0' || a.level === 'L1').map(a => a.dim + '(' + a.level + ')')
    const conf = computeConfidence(verdicts, scored.alignment, gateResults, samples.length)
    const diag = { grade, score, conf, conclusion: conclusion + '｜' + scored.alignment.map(a => a.dim + ':' + a.level).join(' '), alignment: scored.alignment, gateResults, weak, samples: samples.length, sampleLevels: samples.map(v => Object.keys(v).map(k => v[k].level).join('')), engine: 'bars' }
    let tier = ''
    if (grade === 'B') tier = (score < 66 || (weak && weak.length >= 3)) ? 'b_lowconf' : 'b_redflag'
    const ev = recordAssessment(d, { candidateId: c.id,
      deep: diag, conf, route: act.route, action: conclusion, conclusion: act.conclusion, tier,
      scores: scored.alignment.reduce((m, x) => { if (x.score != null) m[x.dim] = x.score; return m }, {}), weighted: score, summary: act.route + '｜' + conclusion,
      gateResults,
      basedOn: { l0: 'v1.2', l1: 'v1', rule: 'bars-v2', model: (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash' },
      inputHash: hash(c.resume || ''), causedBy: c.seqs && c.seqs.length ? c.seqs[c.seqs.length - 1] : null })
    // 5) 分流：S/A 进初试；C 自动淘汰；B 留人；定局态只更新诊断
    const canAdvance = ['待评估', '待初试', '待发 Offer'].indexOf(c.stage) >= 0
    let advanced = null
    if (canAdvance) {
      if (grade === 'S' || grade === 'A') { appendEvent(d, { type: 'stage.advanced', actor: 'agent', subject: { kind: 'candidate', id: c.id }, payload: { to: '待初试', reason: 'BARS 诊断 ' + grade + ' 级，自动进入初试' }, causedBy: ev.seq }); advanced = '待初试' }
      else if (grade === 'C') { appendEvent(d, { type: 'decision.made', actor: 'agent', actorId: 'ai-auto', subject: { kind: 'candidate', id: c.id }, payload: { decision: '淘汰', reason: 'BARS 自动淘汰（C 级/硬门槛）｜' + conclusion.slice(0, 100), from: c.stage, auto: true, reversible: true, grade, score }, causedBy: ev.seq }); advanced = '已淘汰' }
    }
    return { ok: true, diag, tier, advanced, seq: ev.seq }
  }

  function interviewerPageHtml(token, brief, errMsg, esc) {
    const lvOpts = ['L0', 'L1', 'L2', 'L3'].map(l => '<option value="' + l + '">' + l + '</option>').join('')
    const body = errMsg
      ? '<div class="err">' + esc(errMsg) + '</div>'
      : (brief.already
        ? '<div class="done">✅ 你已提交过本次面评，感谢！招聘团队会据此推进。</div>' + interviewBriefHtml(brief, esc)
        : interviewBriefHtml(brief, esc) + `
      <div class="card form">
        <h3>提交面评</h3>
        <label>你的姓名<input id="ivname" placeholder="面试官姓名" value="${esc(brief.interviewer)}"></label>
        <label>是否推荐通过
          <select id="pass"><option value="1">推荐通过</option><option value="0">不通过</option></select></label>
        <label>综合评分（可选，0-100）<input id="score" type="number" min="0" max="100" placeholder="如 80"></label>
        <div class="dimsec"><div class="dt">逐维评档（对照上方 AI 判档，可选）</div>
          ${(brief.alignment||[]).map(a=>`<div class="dr"><span>${esc(a.dim)}（AI:${esc(a.level||'-')}）</span><select data-dim="${esc(a.dim)}"><option value="">不评</option>${lvOpts}</select></div>`).join('')}
        </div>
        <label>面评意见<textarea id="note" rows="4" placeholder="技术栈/项目深度/沟通/风险点…"></textarea></label>
        <button id="submit">提交给招聘团队</button>
        <div id="msg" class="msg"></div>
      </div>
      <script>
        document.getElementById('submit').onclick = async () => {
          const dims = {}; document.querySelectorAll('select[data-dim]').forEach(s => { if (s.value) dims[s.dataset.dim] = s.value });
          const body = { token: ${JSON.stringify(token)}, interviewer: document.getElementById('ivname').value,
            pass: document.getElementById('pass').value === '1', score: document.getElementById('score').value,
            note: document.getElementById('note').value, dims: Object.keys(dims).length ? dims : null };
          const msg = document.getElementById('msg'); msg.textContent = '提交中…';
          try {
            const r = await fetch('/api/ai-recruiting/interviewer-submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
            const j = await r.json();
            if (j.ok) { msg.className = 'msg ok'; msg.textContent = '✅ ' + j.message; document.querySelector('.form').style.display='none'; }
            else { msg.className = 'msg bad'; msg.textContent = j.error || '提交失败'; }
          } catch (e) { msg.className = 'msg bad'; msg.textContent = '提交失败：' + e.message; }
        };
      </script>`)
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>面试邀请 · ' + esc(brief ? brief.name : '') + '</title><style>' + interviewerPageCss() + '</style></head><body><div class="wrap">' + body + '</div></body></html>'
  }
  function interviewBriefHtml(b, esc) {
    const ai = '<div class="card ai"><div class="aihead"><span class="badge">AI 初筛</span>' + (b.grade ? '<b class="g">' + esc(b.grade) + ' 级</b>' : '') + (b.score != null ? '<span class="sc">' + esc(b.score) + ' 分</span>' : '') + '</div>' + (b.summary ? '<div class="sum">' + esc(b.summary).slice(0, 200) + '</div>' : '') + ((b.doubts && b.doubts.length) ? '<div class="db">⚠ 疑点：' + esc(b.doubts.join(' / ')) + '</div>' : '') + ((b.alignment && b.alignment.length) ? '<div class="dims">' + b.alignment.map(a => '<div class="dim"><span class="dn">' + esc(a.dim) + '</span><span class="lv">' + esc(a.level || '—') + '</span></div>').join('') + '</div>' : '') + '</div>'
    return '<div class="hd"><h1>面试邀请</h1><div class="meta">' + esc(b.pos) + ' · ' + esc(b.round) + (b.at ? ' · ' + esc(b.at) : '') + (b.place ? ' · ' + esc(b.place) : '') + '</div></div>' +
      '<div class="card"><div class="name">' + esc(b.name) + ' <span class="tag">' + esc(b.stage) + '</span></div></div>' + ai +
      '<div class="card"><h3>简历原文</h3><pre class="resume">' + esc(b.resume) + '</pre></div>'
  }
  function interviewerPageCss() {
    return `*{box-sizing:border-box}body{margin:0;background:#0f1420;color:#e8eef8;font:14px/1.6 -apple-system,"PingFang SC",sans-serif}.wrap{max-width:720px;margin:0 auto;padding:16px}.hd h1{margin:8px 0 2px;font-size:20px}.hd .meta{color:#94a3c0;font-size:12px;margin-bottom:12px}.card{background:#1a2033;border:1px solid #2b3350;border-radius:12px;padding:14px 16px;margin-bottom:12px}.name{font-size:18px;font-weight:700}.tag{font-size:11px;background:#252d45;color:#94a3c0;border-radius:8px;padding:1px 8px;font-weight:400}.aihead{display:flex;gap:8px;align-items:center;margin-bottom:8px}.badge{font-size:11px;background:rgba(79,132,255,.18);color:#7aa2ff;border-radius:7px;padding:1px 9px;font-weight:600}.g{font-size:16px}.g,.g[data-g=C]{color:#f0ad4e}.sc{color:#94a3c0;font-size:12px}.sum{color:#c4cde0;font-size:12.5px}.db{color:#f0ad4e;font-size:12px;margin-top:6px}.dims{margin-top:8px}.dim{display:flex;gap:8px;align-items:center;font-size:12px;padding:3px 0;border-top:1px solid #252d45}.dn{flex:1;color:#c4cde0}.lv{font-weight:700;color:#7aa2ff}.resume{white-space:pre-wrap;font:12px/1.7 inherit;color:#aeb8cc;max-height:340px;overflow:auto;margin:0}.form label{display:block;margin:10px 0;font-size:12.5px;color:#c4cde0}.form input,.form select,.form textarea{width:100%;margin-top:4px;background:#0f1420;border:1px solid #2b3350;color:#e8eef8;border-radius:8px;padding:8px 10px;font:inherit}.form textarea{resize:vertical}.dimsec{margin:10px 0}.dt{font-size:12px;color:#94a3c0;margin-bottom:6px}.dr{display:flex;gap:8px;align-items:center;font-size:12px;margin:4px 0}.dr span{flex:1}.dr select{width:90px;flex:none}.form button{width:100%;background:#4f84ff;color:#fff;border:0;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}.msg{margin-top:8px;font-size:12.5px}.msg.ok{color:#34d399}.msg.bad{color:#f47171}.done{background:rgba(52,199,123,.12);border:1px solid rgba(52,199,123,.4);color:#34d399;padding:14px;border-radius:10px;margin-bottom:12px}.err{background:rgba(244,113,113,.1);border:1px solid rgba(244,113,113,.4);color:#f47171;padding:16px;border-radius:10px}.card h3{margin:0 0 8px;font-size:13px}`
  }

  // ===== 评估 → 面试验证任务：把 BARS 评估结果转成「面试要验证什么」的结构化任务清单 =====
  // 这是"评估与面试一体"的核心：面试不是自由发挥，而是逐条承接评估的疑点/缺口/待核门槛。
  function buildVerifyTasks(c, pos) {
    const tasks = []
    const al = (c.deep && c.deep.alignment) || []
    for (const a of al) {
      const lv = a.level || ''
      const cand = String(a.candidate || '').trim()
      const insufficient = !cand || cand === '无' || cand.length < 8
      // 判 L0/L1 或证据单薄 → 该维度是面试重点验证项
      if (insufficient || ['L0', 'L1'].indexOf(lv) >= 0) {
        tasks.push({ dim: a.dim, aiLevel: lv, target: '验证是否真的具备（AI 判' + (lv || '缺') + '，证据不足/偏低）', why: insufficient ? '简历无充分证据支撑' : 'AI 判该维偏低，需当面确认是否属实/可培养', evidence: cand.slice(0, 80) })
      } else if (lv === 'L2') {
        tasks.push({ dim: a.dim, aiLevel: lv, target: '验证深度（AI 判 L2 中等，需确认能否独立扛复杂问题）', why: 'AI 判中等，避免"会用"被误当"精通"', evidence: cand.slice(0, 80) })
      }
      // L3 高判档：轻验证即可（防止简历夸大），不列为主线
    }
    // 未判定维度：明确缺证据
    for (const u of (c.undetermined || [])) {
      if (!tasks.some(t => t.dim === u)) tasks.push({ dim: u, aiLevel: '', target: '补证据（AI 无法判定，缺事实）', why: '简历未提供该维度的可引用事实', evidence: '' })
    }
    // 硬门槛待核
    for (const g of (c.gateResults || [])) {
      if (g.verdict === 'pending') tasks.push({ dim: '硬门槛·' + g.gate, aiLevel: '', target: '核实门槛（' + (g.reason || '') + '）', why: '硬门槛待核，影响是否合格', evidence: '' })
    }
    // 去重（按维度名）
    const seen = {}; const out = []
    for (const t of tasks) { if (!seen[t.dim]) { seen[t.dim] = 1; out.push(t) } }
    return out
  }

  // 健壮提取 JSON（LLM 可能带 ```json 包裹或前后杂字，需平衡括号截取）
  function extractJson(text) {
    const t = String(text || '')
    const cb = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/```\s*([\s\S]*?)```/)
    let s = cb ? cb[1] : t
    const start = s.indexOf('{')
    if (start < 0) return null
    let depth = 0, inStr = false, esc = false
    for (let i = start; i < s.length; i++) {
      const ch = s[i]
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch (e) { return null } } }
    }
    return null
  }

  async function llmText(prompt) {
    try {
      const r = await llmDeepAssess(prompt)
      if (typeof r === 'string') return r
      if (r && r.ok && typeof r.text === 'string') return r.text
      return ''
    } catch (e) { return '' }
  }

  // ===== JD 合规质检：歧视性表述 + 结构质量（纯规则）=====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/compliance',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const { checkPosting } = await import('./compliance.js')
        const r = checkPosting(String(a.text || ''))
        replyJson(res, 200, { ok: true, result: r })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== Offer 文档生成（python-docx）=====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/offer-docx',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const s2 = fold(d)
        const c = s2.byId[a.candidateId]
        if (!c) { replyJson(res, 400, { error: 'candidate not found' }); return }
        const p2 = s2.positions.find(x => x.id === c.pid) || {}
        const payload = {
          name: c.name || '', position: a.position || p2.title || '', salary: a.salary || '',
          startDate: a.startDate || '', reportTo: a.reportTo || '', company: a.company || '',
          note: a.note || '', date: new Date().toLocaleDateString('zh-CN'),
        }
        const tmpdir = join(d, 'tmp'); ensure(tmpdir)
        const out = join(tmpdir, 'offer_' + c.id + '_' + Date.now() + '.docx')
        const py = (config && config.pythonPath) || 'python3'
        const script = fileURLToPath(new URL('./make_offer.py', import.meta.url))
        const r = spawnSync(py, [script, out, JSON.stringify(payload)], { encoding: 'utf8', timeout: 60000 })
        if (!existsSync(out)) { replyJson(res, 400, { error: '文档生成失败：' + String((r && r.stderr) || '').slice(0, 200) }); return }
        const b64 = readFileSync(out).toString('base64')
        try { unlinkSync(out) } catch (e) {}
        replyJson(res, 200, { ok: true, filename: (c.name || 'offer') + '-录用通知书.docx', base64: b64 })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== 导出 CSV（候选人 / 面试 / 全员）=====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/export',
    handler: async (req, res) => {
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const s3 = fold(d)
        const scope = String(a.scope || 'all')
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
        let rows = []
        if (scope === 'interviews') {
          const evs = readEvents(d).filter(e => e.type === 'interview.scheduled')
          rows.push(['候选人', '轮次', '时间', '面试官', '地点', '当前阶段'])
          for (const e of evs) {
            const c = s3.byId[(e.subject || {}).id] || {}
            const p4 = e.payload || {}
            rows.push([c.name || '', p4.round || '', p4.at || '', p4.interviewer || '', p4.place || p4.channel || '', c.stage || ''])
          }
        } else {
          const id = a.candidateId
          const list = id ? [s3.byId[id]].filter(Boolean) : s3.candidates
          rows.push(['姓名', '岗位', '阶段', '来源', '评级', '加权分', '置信度', '关联状态', '备注'])
          for (const c of list) {
            const p4 = s3.positions.find(x => x.id === c.pid) || {}
            rows.push([c.name || '', p4.title || '', c.stage || '', c.source || '', c.route || '', c.weighted != null ? c.weighted : '', c.conf != null ? c.conf : '', c.unlinked ? '未关联岗位' : '已关联', (c.summary || '').slice(0, 80)])
          }
        }
        const csv = '\ufeff' + rows.map(r => r.map(esc).join(',')).join('\r\n')
        replyJson(res, 200, { ok: true, csv, filename: 'recruiting-' + scope + '-' + new Date().toISOString().slice(0, 10) + '.csv' })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== 人才库检索：按关键词 / 技能 / 岗位需求 召回历史候选人 =====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/talent-search',
    handler: async (req, res) => {
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const w = workbenchData(d, null, buildDashboard)
        const pool = w.talentPool || []
        const q = String(a.q || '').trim().toLowerCase()
        const wantSkills = (a.skills || []).map(x => String(x).toLowerCase()).filter(Boolean)
        const pos = a.positionId ? (fold(d).positions.find(x => x.id === a.positionId) || null) : null
        const { jobSkillDemand } = await import('./skills.js')
        // 只按「有区分度」的技能匹配：排除通用软技能与语言类（人人都有，不构成召回依据）
        const demand = pos
          ? jobSkillDemand(pos).filter(x => x.group !== '通用' && x.cat !== 'L').map(x => x.name)
          : []
        const results = []
        for (const c of pool) {
          const reasons = []
          let score = 0
          const nameHit = q && (String(c.name || '').toLowerCase().indexOf(q) >= 0)
          if (nameHit) { score += 40; reasons.push('姓名命中') }
          if (q && !nameHit) {
            const inSkills = (c.skills || []).some(s2 => s2.toLowerCase().indexOf(q) >= 0)
            if (inSkills) { score += 30; reasons.push('技能命中「' + q + '」') }
          }
          if (wantSkills.length) {
            const hit = (c.skills || []).filter(s2 => wantSkills.some(w2 => s2.toLowerCase().indexOf(w2) >= 0))
            if (hit.length) { score += hit.length * 12; reasons.push('技能命中 ' + hit.length + ' 项：' + hit.slice(0, 4).join('/')) }
          }
          if (demand.length >= 3) {
            const hitD = demand.filter(d2 => (c.skills || []).some(s2 => s2 === d2 || s2.toLowerCase().indexOf(d2.toLowerCase()) >= 0))
            const rate = Math.round(hitD.length / demand.length * 100)
            if (rate > 0) { score += rate * 0.5; reasons.push('岗位技能匹配 ' + rate + '%（' + hitD.length + '/' + demand.length + '）') }
            else reasons.push('岗位技能 0 命中（' + demand.length + ' 项要求）')
          } else if (demand.length && !wantSkills.length && !q) {
            reasons.push('该岗位技能要求不足（' + demand.length + ' 项），无法按技能召回')
          }
          if (!q && !wantSkills.length && !demand.length) score = 1
          if (score > 0) results.push({ ...c, matchScore: Math.round(score), matchReasons: reasons })
        }
        results.sort((x, y) => y.matchScore - x.matchScore)
        replyJson(res, 200, { ok: true, total: pool.length, count: results.length, results: results.slice(0, 40) })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== 打开链接：抓不到正文时，用系统浏览器打开让用户复制（减少摩擦）=====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/open-url',
    handler: async (req, res) => {
      const a = await readPost(req, res, 8 * 1024)
      if (!a) return
      try {
        const u = String(a.url || '').trim()
        if (!/^https?:\/\//i.test(u)) { replyJson(res, 400, { error: '仅支持 http/https 链接' }); return }
        const r = spawnSync('open', [u], { timeout: 8000 })
        replyJson(res, 200, { ok: r.status === 0, message: r.status === 0 ? '已在浏览器打开，复制页面 JD 后粘贴回来' : '打开失败' })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // 清洗网页 JD 正文：只保留「岗位职责 + 岗位要求 + 加分项」等核心段落，去掉导航/页脚/公司宣传
  function cleanJdText(raw) {
    const lines = String(raw || '').split('\n').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean)
    const NOISE = /^(首页|登录|立即申请|分享|关注我们|隐私政策|招聘意见反馈|一起成长|Grow Together|美团\s*｜|@\d{4}|京ICP备|京公网安备|Global Careers|了解美团|校园招聘|社会招聘|北斗计划|美团赛事|LongCat|Copyright|版权所有|^美团$)/i
    const FOOTER = /版权|ICP备|公网安备|隐私政策|意见反馈|关注我们|一起成长|Grow Together|Copyright|扫描二维码|App下载/i
    const START = /^(岗位职责|工作职责|职位描述|工作内容|主要职责|职责描述|岗位描述|职位职责)/
    const MID = /^(岗位要求|任职要求|任职资格|基本要求|岗位基本要求|职位要求|任职条件|岗位需求|任职标准|任职条件)/
    const PLUS = /^(加分项|优先条件|具备以下条件|优先考虑|以下条件优先|加分条件)/
    // 结束标记：这些段落不属于「职责/要求」核心
    const ENDS = /^(岗位亮点|亮点|福利|公司介绍|团队介绍|部门介绍|关于我们|工作环境|我们能提供|你将获得|联系我们|投递方式)/
    const kept = lines.filter(l => !NOISE.test(l) && !FOOTER.test(l) && l.length > 1)
    let si = -1, mi = -1, pi = -1
    for (let i = 0; i < kept.length; i++) {
      if (si < 0 && START.test(kept[i])) { si = i; continue }
      if (si >= 0 && mi < 0 && MID.test(kept[i])) { mi = i; continue }
      if (mi >= 0 && pi < 0 && PLUS.test(kept[i])) { pi = i; continue }
    }
    if (si >= 0) {
      const out = []
      // 标题（职责段之前的第一个非元信息行，通常是岗位名）+ 明确元信息
      const head = kept.slice(0, si)
      const meta = head.filter(l => /^(工作地点|部门)\s*[：:]|^(工作经验|更新时间|薪资|学历|招聘人数|工作性质)\s*[：:]/.test(l))
      const titleLine = head.find(l => !/^(工作地点|部门)\s*[：:]|^(工作经验|更新时间|薪资|学历|招聘人数|工作性质)\s*[：:]/.test(l) && !ENDS.test(l) && l.length <= 40)
      if (titleLine) out.push(titleLine)
      // 元信息（地点/部门/经验/更新时间）已抽取到职位字段，JD 正文只保留职责与要求
      // 职责段 → 要求段 → 加分项（遇到 ENDS 截断）
      let endIdx = kept.length
      for (let i = si + 1; i < kept.length; i++) { if (ENDS.test(kept[i])) { endIdx = i; break } }
      const body = kept.slice(si, endIdx)
      out.push(...body)
      const t = out.join('\n').trim()
      if (t.length >= 60) return t
    }
    return kept.join('\n').trim()
  }

  // ===== 职位导入：JD 文档/链接内容 → 结构化职位字段（AI 解析，人确认后保存）=====
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/position-import',
    handler: async (req, res) => {
      const a = await readPost(req, res, 20 * 1024 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        let text = String(a.text || '').trim()
        // 链接：抓取网页正文（招聘网站详情页常为服务端渲染；SPA 页面抓不到时提示粘贴文字）
        const looksUrl = /^https?:\/\/[^\s]+$/i.test(text)
        if (!text || looksUrl) {
          const u = looksUrl ? text : String(a.url || '').trim()
          if (u && /^https?:\/\//i.test(u)) {
            try {
              const r = await fetch(u, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept': 'text/html,application/xhtml+xml' },
                signal: AbortSignal.timeout(15000),
              })
              if (!r.ok) { replyJson(res, 200, { ok: false, reason: '链接抓取失败（HTTP ' + r.status + '）：可能需要登录或站点禁止抓取。请打开页面复制 JD 文字粘贴' }); return }
              const html = await r.text()
              text = String(html)
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/<[^>]+>/g, '\n')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                .split('\n').map(x => x.trim()).filter(Boolean).join('\n')
                .slice(0, 12000)
              // 是否真的拿到职位内容（框架导航文本会被误判为正文）
              const looksJd2 = (t) => {
                const words = ['职责', '要求', '任职', '岗位', '经验', '技能', '学历', '工作内容', '薪资', '优先', '能力', '招聘']
                let h = 0
                for (const w of words) if (String(t).indexOf(w) >= 0) h++
                return String(t).length >= 260 && h >= 2
              }
              if (!looksJd2(text)) {
                // 服务端抓不到（SPA）→ 用 Chrome headless 渲染后取正文（全自动，无需任何授权）
                const { fetchRenderedPage } = await import('./fetch_page.js')
                const rr = await fetchRenderedPage(u, { timeoutMs: 35000 })
                if (rr.ok && rr.text && rr.text.trim().length > 80) text = rr.text.slice(0, 12000)
                else {
                  replyJson(res, 200, { ok: false, reason: '页面未能自动渲染出正文（' + ((rr && rr.error) || '可能需登录') + '）。请复制 JD 文字粘贴' })
                  return
                }
              }
            } catch (e) {
              replyJson(res, 200, { ok: false, reason: '链接抓取失败：' + String((e && e.message) || e) + '。请复制页面文字粘贴' }); return
            }
          }
        }
        // 文件：复用简历解析器（PDF/Word/图片 OCR）
        if (!text && a.contentBase64) {
          const buf = Buffer.from(String(a.contentBase64), 'base64')
          if (!buf.length) { replyJson(res, 400, { error: '文件为空' }); return }
          const tmpdir = join(d, 'tmp'); ensure(tmpdir)
          const ext = (String(a.filename || 'jd.txt').match(/\.[a-z0-9]+$/i) || ['.txt'])[0].toLowerCase()
          const src = join(tmpdir, 'pos_' + Date.now() + ext)
          writeFileSync(src, buf)
          const py = config.pythonPath || process.env.DSH_PYTHON
          const r = spawnSync(py, [join(SCRIPT_DIR, 'parse_resume.py'), src], { encoding: 'utf8', timeout: 120000 })
          try { unlinkSync(src) } catch (e) {}
          let parsed = null
          try { parsed = JSON.parse(r.stdout) } catch (e) {}
          if (!parsed || !parsed.ok || !parsed.text) { replyJson(res, 200, { ok: false, reason: '文档无法提取文本（可能是图片/扫描件，请直接粘贴 JD 文字）', parse: parsed }); return }
          text = String(parsed.text).slice(0, 12000)
        }
        if (!text) { replyJson(res, 400, { error: '请提供 JD 文本或文件' }); return }
        const prompt = [
          '你是招聘助理。下面是职位描述（JD）原文，请抽取为结构化职位信息。',
          '只输出 JSON：{"title":"","dept":"","city":"","headcount":1,"expYears":null,"bandMin":null,"bandMax":null,"gates":[],"abilities":[],"summary":""}',
          '规则：1) title 用原文岗位名称；2) gates=硬性门槛（学历/年限/证书/技术栈等一票否决项，逐条列出）；3) abilities=能力项（按 JD 中强调顺序，3-6 条）；4) 薪资若以「15-20K」「20万/年」出现则换算成 K 月薪（20万/年≈16.7K）；5) 缺的字段留 null 或空数组，不要编造。',
          'JD 原文：',
          text.slice(0, 9000),
        ].join('\n')
        let out = ''
        out = await llmText(prompt)
        let parsed2 = null
        try { const m = String(out).match(/\{[\s\S]*\}/); if (m) parsed2 = JSON.parse(m[0]) } catch (e) {}
        if (!parsed2 || !parsed2.title) { replyJson(res, 200, { ok: false, reason: '解析失败，请手动填写', raw: String(out).slice(0, 300) }); return }
        const cleaned = cleanJdText(text)
        replyJson(res, 200, { ok: true, fields: parsed2, text: cleaned.slice(0, 12000), textRaw: text.slice(0, 12000), textLen: cleaned.length, basedOn: { rule: 'position-import-v1' } })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== 面试 Copilot：面试准备卡（必须验证项 + 针对性问题 + 红旗）与面评草稿 =====
  // 定位：面试官的副驾（人是面试官），不是替代人面试的独立环节
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/interview-prep',
    handler: async (req, res) => {
      const a = await readPost(req, res, 1024 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const s2 = fold(d)
        const c = s2.byId[a.candidateId]
        if (!c) { replyJson(res, 400, { error: 'candidate not found' }); return }
        const p2 = s2.positions.find(x => x.id === c.pid) || {}
        // 面评草稿模式：基于面试记录文本生成建议档位（人确认后入库）
        if (a.mode === 'draft') {
          const notes = String(a.notes || '').trim()
          if (!notes) { replyJson(res, 400, { error: '面试记录为空' }); return }
          const sc = s2.standards && s2.standards.length ? s2.standards[s2.standards.length - 1] : null
          const dimLines = ((c.deep && c.deep.alignment) || []).map(x => x.dim).join('、') || (p2.abilities || []).join('、')
          const prompt = [
            '你是资深面试官助手。下面是候选人的面试记录（面试官记录的原始要点），请按 BARS 维度评估。',
            '岗位：' + (p2.title || '') + '；候选人：' + (c.name || ''),
            '评估维度：' + (dimLines || '通用能力'),
            'BARS 档位定义：L0 不满足 / L1 基本匹配 / L2 良好 / L3 优秀。',
            '要求：1) 每个维度给档位与一句证据（引用记录原文，不要编造）；2) 证据不足给 L0 并在 doubts 注明；3) 给 3 条疑点。',
            '只输出 JSON：{"dims":[{"dim":"","level":"L2","evidence":""}],"summary":"","doubts":[]}',
            '面试记录：',
            notes.slice(0, 6000),
          ].join('\n')
          let out = ''
          out = await llmText(prompt)
          let parsed = null
          try { const j2 = extractJson(out); if (j2) parsed = j2 } catch (e) {}
          if (!parsed || !Array.isArray(parsed.dims)) { replyJson(res, 200, { ok: false, reason: '生成失败，请手动填写面评', raw: String(out).slice(0, 300) }); return }
          replyJson(res, 200, { ok: true, draft: parsed, basedOn: { rule: 'interview-draft-v1', standard: sc ? (sc.l0 || '') : '' } })
          return
        }
        // 准备卡模式
        const gates = (c.gateResults || []).map(g => g.gate + '：' + (g.verdict === 'pass' ? '通过' : g.verdict === 'fail' ? '未过' : '待核') + '（' + (g.reason || '') + '）').join('；')
        const doubts = (c.doubts || []).join('；')
        const dims = ((c.deep && c.deep.alignment) || []).map(x => x.dim + '(' + (x.level || '?') + ')').join('、')
        // 评估驱动的验证任务（面试逐条承接，不自由发挥）
        const vt = buildVerifyTasks(c, p2)
        const vtText = vt.length ? vt.map((t, i) => (i + 1) + '. 【' + t.dim + '】AI判档:' + (t.aiLevel || '缺/待核') + ' | 验证目标:' + t.target + ' | 原因:' + t.why + (t.evidence ? ' | 简历现有:' + t.evidence : '')).join('\n') : '（评估无明确疑点，按岗位核心能力设计）'
        const prompt = [
          '你是资深面试官的「面试题库与培训副驾」。你的面试问题必须紧扣"AI 评估给出的验证任务"，逐条承接，不得跑题、不得自由发挥。',
          '岗位：' + (p2.title || '') + '　候选人：' + (c.name || ''),
          'AI 初筛结论：' + (c.route || '未评估'),
          '# 必须逐条验证的任务清单（这是评估给出的待验证点，你的问题要覆盖它们）',
          vtText,
          '',
          '简历摘要：' + String(c.resume || '').slice(0, 2200),
          '重要常识（避免把正常现象当疑点）：毕业/入职时间差、当月离职次月入职、毕业前实习转正、短期在职——这些都不算问题，不得追问、不得列为红旗。',
          '要求（严格遵守）：',
          '1) 对【验证任务清单】里的每个维度，出 1-2 个能证实/证伪该点的深挖问题（问实现细节、指标、取舍、异常处理），问题要能戳穿"会用≠精通"；',
          '2) questions 总数 4-7 条，dim 字段必须对应任务清单里的维度名；',
          '3) mustVerify 3-5 条：从任务清单提炼最关键的当面验证点；',
          '4) redFlags 1-3 条：真正的造假/能力不符风险（不是正常求职节奏）；',
          '5) 每个问题 why 写清"这条对应哪个验证任务、想验证什么"。',
          '只输出 JSON：{"mustVerify":[""],"questions":[{"dim":"","q":"","why":""}],"redFlags":[""]}',
        ].join('\n')
        let out = ''
        out = await llmText(prompt)
        let parsed = null
        try { const j2 = extractJson(out); if (j2) parsed = j2 } catch (e) {}
        if (!parsed) { replyJson(res, 200, { ok: false, reason: '生成失败', raw: String(out).slice(0, 300) }); return }
        replyJson(res, 200, { ok: true, prep: parsed, basedOn: { rule: 'interview-copilot-v1' } })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== 语音转写：候选人录音 → 文本（macOS Speech，本地/在线混合）=====
  // 音频落临时文件，afconvert 归一为 wav（Speech 需要），转写完即删
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/stt',
    handler: async (req, res) => {
      const a = await readPost(req, res, 12 * 1024 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const STT = fileURLToPath(new URL('./vendor/stt/stt', import.meta.url))
        if (!existsSync(STT)) { replyJson(res, 200, { ok: false, reason: 'no-stt-binary' }); return }
        if (!a.contentBase64) { replyJson(res, 400, { error: 'contentBase64 required' }); return }
        const buf = Buffer.from(String(a.contentBase64), 'base64')
        if (!buf.length) { replyJson(res, 400, { error: 'empty audio' }); return }
        if (buf.length > 10 * 1024 * 1024) { replyJson(res, 400, { error: 'audio exceeds 10MB' }); return }
        const ext = (String(a.filename || 'audio.m4a').match(/\.[a-z0-9]+$/i) || ['.m4a'])[0].toLowerCase()
        const tmpdir = join(d, 'tmp'); ensure(tmpdir)
        const src = join(tmpdir, 'stt_' + Date.now() + ext)
        writeFileSync(src, buf)
        let target = src
        // Speech 支持的格式：aiff/wav/caf/m4a。其他用系统 afconvert 转 wav
        if (['.aiff', '.aif', '.wav', '.caf', '.m4a'].indexOf(ext) < 0 || ext === '.mp3') {
          const wav = src + '.wav'
          try { spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', src, wav], { timeout: 60000 }) } catch (e) {}
          if (existsSync(wav)) target = wav
        }
        const r = spawnSync(STT, [target], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
        const out = String((r && r.stdout) || '').trim()
        try { unlinkSync(target); if (target !== src) try { unlinkSync(src) } catch (e) {} else unlinkSync(src) } catch (e) {}
        const lines = out.split('\n')
        const diag = lines.filter(l => l.indexOf('onDevice=') === 0 || l.indexOf('ERR:') === 0)
        const text = lines.filter(l => l.indexOf('onDevice=') !== 0 && l.indexOf('ERR:') !== 0).join(' ').trim()
        if (!text) { replyJson(res, 200, { ok: false, reason: diag.join(' ') || 'no-speech-recognized' }); return }
        replyJson(res, 200, { ok: true, text, diag: diag.join(' ') })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // ===== AI 面试官：对话式初面，长在人机契约上 =====
  // 会话 = 工作草稿（ai_interviews/<cid>.json）；只有最终结构化结论进事件账本（ai_interview.completed）
  // 人确认后才写 feedback.submitted 并推进阶段——AI 产出永远是"建议"，入库必经人手
  const ivSessionFile = (d, cid) => join(d, 'ai_interviews', cid + '.json')
  const ivRead = (d, cid) => { try { return JSON.parse(readFileSync(ivSessionFile(d, cid), 'utf8')) } catch (e) { return null } }
  const ivWrite = (d, cid, sess) => { mkdirSync(join(d, 'ai_interviews'), { recursive: true }); writeFileSync(ivSessionFile(d, cid), JSON.stringify(sess, null, 1)) }
  function buildInterviewPrompt(p, c, sess) {
    const dims = (p.scorecard && p.scorecard.softDims) || []
    const anchors = dims.map(dd => dd.name + '（权重' + dd.weight + '%）：' + (dd.levels || []).map(lv => lv.level + '=' + lv.anchor).join('；')).join('\n')
    const covered = Object.keys(sess.covered || {})
    const diag = c.deep || {}
    const flags = (diag.weak && diag.weak.length) ? '简历初筛疑点（必须当面求证，让候选人解释）：' + diag.weak.join('、') : ''
    const transcript = (sess.messages || []).map(m => (m.role === 'ai' ? '[面试官] ' : '[候选人] ') + m.text + (m.target ? '（考察：' + m.target + '）' : '')).join('\n')
    return [
      '# Role',
      '你是岗位「' + (p.title || '') + '」的结构化面试官。任务是按行为锚定评分卡（BARS）逐维取证，产出可审计的面试结论。',
      '',
      '# 铁律',
      '1. 一次只问一个问题，针对「覆盖最少/证据最弱」的维度；问题必须贴锚点（问实例、问数字、问归因）。',
      '2. 候选人每答一轮：从原话提取可引用证据，对照锚点给该维初步档位 L0-L3。',
      '3. 严禁脑补：候选人没答出来的，档位按证据不足处理（L0/L1），evidence 写「候选人未提供有效证据」。',
      '4. ' + (flags || '无已知简历疑点。'),
      '5. 每个维度至少一问一答后（已覆盖：' + (covered.join('、') || '尚无') + '），才可输出最终结论。',
      '',
      '# 评分卡维度与锚点',
      anchors || '（无评分卡）',
      '',
      '# 候选人简历（已脱敏）',
      String(c.resume || '').replace(/［已丢弃］/g, '').slice(0, 4000),
      '',
      '# 对话至今',
      transcript || '（尚无对话，请开第一个问题）',
      '',
      '# 输出（严格 JSON，二选一）',
      '未完成：{"done":false,"question":"下一个问题","target":"维度名","reason":"为何问这个"}',
      '全部覆盖：{"done":true,"dims":[{"dim":"维度名","level":"L0|L1|L2|L3","evidence":"候选人原话摘录","confidence":0-1}],"summary":"一句话总体面评","overall":"S|A|B|C"}',
    ].join('\n')
  }
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/ai-interview',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d)
        const s = fold(d)
        const c = s.byId[a.candidateId]
        if (!c) { replyJson(res, 400, { error: 'candidate not found' }); return }
        const p = s.positions.find(x => x.id === c.pid)
        if (!p || !(p.scorecard && p.scorecard.softDims && p.scorecard.softDims.length)) { replyJson(res, 400, { error: '该岗位无评分卡，AI 面试官需要 BARS 锚点才能逐维取证' }); return }
        let sess = ivRead(d, c.id)
        if (a.action === 'start' || !sess) {
          sess = { cid: c.id, position: p.title, messages: [], covered: {}, status: 'active', created: new Date().toISOString(), suggestion: null }
        }
        if (a.action === 'reply' && a.text) sess.messages.push({ role: 'human', text: String(a.text).slice(0, 2000), ts: new Date().toISOString() })
        if (a.action === 'reset') sess = { cid: c.id, position: p.title, messages: [], covered: {}, status: 'active', created: new Date().toISOString(), suggestion: null }
        const g = await llmDeepAssess(buildInterviewPrompt(p, c, sess))
        if (!g.ok) { ivWrite(d, c.id, sess); replyJson(res, 200, { ok: false, reason: g.reason, session: sess }); return }
        let out = null
        try {
          const m2 = g.text.match(/\{[\s\S]*\}/)
          out = JSON.parse(m2[0].replace(/```json|```/g, ''))
        } catch (e) { out = null }
        if (out && out.done) {
          const dims = (out.dims || []).map(x => ({ dim: x.dim, level: /^L[0-3]$/.test(String(x.level)) ? x.level : 'L0', evidence: String(x.evidence || '').slice(0, 300), confidence: Number(x.confidence) || 0.5 }))
          sess.status = 'done'; sess.suggestion = { dims, summary: String(out.summary || '').slice(0, 300), overall: ['S', 'A', 'B', 'C'].indexOf(out.overall) >= 0 ? out.overall : 'B' }
          sess.updatedAt = new Date().toISOString()
          ivWrite(d, c.id, sess)
          appendEvent(d, {
            type: 'ai_interview.completed', actor: 'agent', subject: { kind: 'candidate', id: c.id },
            payload: { turns: sess.messages.length, dims, summary: sess.suggestion.summary, overall: sess.suggestion.overall, positionId: p.id },
            basedOn: { rule: 'ai-interviewer-v1', model: (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash' },
            inputHash: hash(String(c.resume || '') + '|' + sess.messages.length), causedBy: c.seqs ? c.seqs[c.seqs.length - 1] : null,
          })
          replyJson(res, 200, { ok: true, done: true, session: sess })
          return
        }
        if (out && out.question) {
          sess.messages.push({ role: 'ai', text: String(out.question).slice(0, 1200), target: String(out.target || ''), reason: String(out.reason || ''), ts: new Date().toISOString() })
          if (out.target) { const k = (p.scorecard.softDims.find(x => x.name === out.target) || {}).name; if (k) sess.covered[k] = true }
        } else {
          sess.messages.push({ role: 'ai', text: '（解析异常，请点「重问」或继续回答）', target: '' })
        }
        sess.updatedAt = new Date().toISOString()
        ivWrite(d, c.id, sess)
        replyJson(res, 200, { ok: true, done: false, session: sess })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // 多次采样取共识：评 N 次（temperature=0 已降随机，多次再取中位数消除残余波动）
  function median(arr) { const a = arr.filter(x => typeof x === 'number').sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2) }
  async function llmDeepAssessConsensus(prompt, n) {
    n = n || 3
    const runs = []
    for (let i = 0; i < n; i++) {
      const r = await llmDeepAssess(prompt)
      const d = r.ok ? parseDeepAssess(r.text) : null
      if (d) runs.push(d)
    }
    if (!runs.length) return null
    // 总分取中位数 → 推导 grade（统一口径）
    const medScore = median(runs.map(r => r.score))
    const grade = medianScoreToGrade(medScore)
    // 逐维对齐分取中位数
    const dimMap = {}
    for (const r of runs) for (const a of (r.alignment || [])) {
      dimMap[a.dim] = dimMap[a.dim] || []
      if (a.score != null) dimMap[a.dim].push(a.score)
    }
    // 红牌取共识（出现在 ≥2 次里才承认）
    const flagCount = {}
    const flagSample = {}
    for (const r of runs) for (const f of (r.redFlags || [])) {
      const k = f.type
      flagCount[k] = (flagCount[k] || 0) + 1
      flagSample[k] = f
    }
    const consensusFlags = Object.keys(flagCount).filter(k => flagCount[k] >= Math.ceil(n / 2)).map(k => flagSample[k])
    // 取一次最接近中位分的样本作为主报告（strengths/conclusion/stageFit 用它）
    runs.sort((a, b) => Math.abs((a.score || 0) - medScore) - Math.abs((b.score || 0) - medScore))
    const base = runs[0]
    base.score = medScore
    base.grade = grade
    base.alignment = base.alignment.map(a => ({ ...a, score: a.score != null && dimMap[a.dim] ? median(dimMap[a.dim]) : a.score }))
    base.redFlags = consensusFlags
    base.samples = runs.length
    base.sampleScores = runs.map(r => r.score)
    return base
  }
  function medianScoreToGrade(score) {
    const s = typeof score === 'number' ? score : 0
    if (s >= 85) return 'S'; if (s >= 75) return 'A'; if (s >= 60) return 'B'; return 'C'
  }
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/deep-assess',
    handler: async (req, res) => {
      const a = await readPost(req, res, 256 * 1024)
      if (!a) return
      try {
        const d = dataDir(); ensure(d); migrateLegacy(d)
        const r = await assessCandidate(d, a.candidateId)
        if (!r.ok) { replyJson(res, 200, r); return }
        replyJson(res, 200, { ok: true, candidateId: a.candidateId, diag: r.diag, tier: r.diag && r.diag.tier, advanced: r.to, engine: r.engine, seq: r.seq })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // AI 生成结构化岗位 JD：优先 LLM（OD 专家提示词），失败降级规则引擎
  const JD_PROMPT = (p) => [
    '# Role',
    '你是一位精通组织发展（OD）与业务架构的资深 HR 专家。',
    '',
    '# Background',
    '我需要为公司的一个岗位生成/迭代一份高度专业、可落地的岗位职责说明书（JD）。',
    '业务背景/调整说明：' + (p.businessContext || '（首次制定，无特殊变更）'),
    '岗位名称：' + (p.title || '（未命名）'),
    '部门：' + (p.dept || '未填') + '；城市：' + (p.city || '未填'),
    '能力要求：' + (p.abilities || '未填') + '；硬门槛：' + (p.gates || '未填'),
    p.sourceText ? ('\n# 已有 JD 原文（必须在此基础上结构化：保留原文的事实信息与职责，不要凭空发明；可优化表述与结构）\n' + String(p.sourceText).slice(0, 6000)) : '',
    '',
    '# Rules',
    '1. 严格遵守"动词 + 工作内容 + 商业目的/结果"的公式撰写核心职责。',
    '2. 每一条核心职责必须明确对应的产出物或考核指标（KPI）。',
    '3. 区分决策与执行边界，避免空洞和模糊的词汇（如"协助"、"等"）。',
    '',
    '# Output Format',
    '请输出结构化的 Markdown 文本，包含：',
    '1. 职务核心目的（1-2句）',
    '2. 组织定位与协作网络',
    '3. 核心职责与 KPI：**严格不超过 8 条**（6-8 条，太多就没有重点）。每条职责写成一个完整句子，采用"动词 + 工作内容 + 商业目的/结果"，并在同一条内附上产出物或 KPI；不要把"产出物""KPI""目的"单独列成一条职责。',
    '4. 任用门槛（技能、经验、复杂度级别）',
    '5. 迭代对照说明（若为更新版，简述本次业务变化导致了哪些职责的增减）',
    '',
    '4. 每条职责必须聚焦、可衡量；禁止把同一职责拆成"职责/产出物/KPI"多条重复表述。',
    '只输出 Markdown 正文，不要额外解释。',
  ].join('\n')

  async function llmGenerateJD(p) {
    const llm = (typeof ctx.get === 'function' && ctx.get('llm')) || ctx.llm
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }
    const provider = (config && config.jdProvider) || 'magpie'
    const model = (config && config.jdModel) || 'workbuddy/deepseek-v4.1-flash'
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider, model,
        messages: [{ role: 'user', content: [{ type: 'text', text: JD_PROMPT(p) }] }],
      })) {
        if (chunk && typeof chunk.text === 'string' && chunk.type !== 'block-start') text += chunk.text
      }
    } catch (e) {
      return { ok: false, reason: 'llm-error: ' + String((e && e.message) || e) }
    }
    text = (text || '').trim()
    if (text.length < 40) return { ok: false, reason: 'llm-empty' }
    return { ok: true, markdown: text, provider, model }
  }

  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/generate-jd',
    handler: async (req, res) => {
      const a = await readPost(req, res, 64 * 1024)
      if (!a) return
      try {
        const base = emptyJD()
        base.title = a.title || ''; base.dept = a.dept || ''; base.city = a.city || ''
        base.band = (a.bandMin || a.bandMax) ? ((a.bandMin || 0) + '–' + (a.bandMax || 0) + 'K') : ''
        base.meta.basedOnBusiness = a.businessContext || ''
        const g = await llmGenerateJD(a)
        let jd, source
        if (g.ok) {
          jd = parseJDMarkdown(g.markdown, base)
          const fallback = ruleJD(a)
          if (!jd.responsibilities || jd.responsibilities.length < 3) jd.responsibilities = fallback.responsibilities
          if (!jd.corePurpose) jd.corePurpose = fallback.corePurpose
          if (!jd.orgPosition) jd.orgPosition = fallback.orgPosition
          if (!jd.qualifications || !(jd.qualifications.skills || []).length) jd.qualifications = fallback.qualifications
          jd.meta.generatedBy = 'llm:' + g.model
          source = 'llm'
        } else {
          jd = ruleJD(a)
          source = 'rule'
          jd.meta.llmError = g.reason
        }
        jd.meta.at = new Date().toISOString()
        const markdown = g.ok ? g.markdown : jdToMarkdown(jd)
        replyJson(res, 200, { ok: true, source, jd, markdown, llmError: source === 'rule' ? g.reason : undefined })
      } catch (e) { replyJson(res, 400, { error: String((e && e.message) || e) }) }
    },
  }))

  // 薪酬分位值 + AI 建议（数据来源：本年度薪酬报告基准）
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/salary-benchmark',
    resource: async (request) => {
      try {
        const u = new URL(request.url)
        const q = {
          title: u.searchParams.get('title') || '', dept: u.searchParams.get('dept') || '',
          city: u.searchParams.get('city') || '', abilities: u.searchParams.get('abilities') || '',
          expYears: u.searchParams.get('expYears') || '',
          bandMin: u.searchParams.get('bandMin') || '', bandMax: u.searchParams.get('bandMax') || '',
          positionId: u.searchParams.get('positionId') || '',
        }
        // 本岗位实际发出的 Offer 薪资（闭环校准依据）——必须绑定具体岗位，否则不采集（口径一致性）
        let actual = null
        let calibFactor = null
        if (q.positionId) {
          try {
            const d0 = dataDir(); ensure(d0)
            const ev0 = readEvents(d0)
            const ks0 = []
            for (const e of ev0) {
              if (e.type !== 'offer.sent' && e.type !== 'hire.confirmed') continue
              const cid = (e.subject || {}).id
              const cc = fold(d0).byId[cid]
              if (!cc || cc.pid !== q.positionId) continue
              const mm = String((e.payload || {}).salary || '').match(/(\d+(?:\.\d+)?)\s*[kK]/)
              if (mm) ks0.push(Number(mm[1]))
            }
            if (ks0.length) {
              ks0.sort((a, b) => a - b)
              actual = { count: ks0.length, min: ks0[0], max: ks0[ks0.length - 1], median: ks0.length % 2 ? ks0[(ks0.length - 1) / 2] : Math.round((ks0[ks0.length / 2 - 1] + ks0[ks0.length / 2]) / 2 * 10) / 10 }
            }
          } catch (e) {}
        }
        // 自校准系数：该岗位历史建议 P50 vs 实招中位的偏差（实招数据足够时应用）
        try {
          const d0 = dataDir(); const ev0 = readEvents(d0); const s0 = fold(d0)
          if (q.title && actual && actual.count >= 1) {
            // 找该岗位最近一次建议 P50
            let advP50 = null
            for (const e of ev0) {
              if (e.type === 'salary.advised' && ((e.subject || {}).id === q.positionId) && (e.payload || {}).P50 != null) advP50 = (e.payload || {}).P50
            }
            // 同 title 的历史（无 positionId 时按 title 找最近建议）
            if (advP50 == null) {
              for (const e of ev0) {
                if (e.type === 'salary.advised' && (e.payload || {}).title === q.title && (e.payload || {}).P50 != null) advP50 = (e.payload || {}).P50
              }
            }
            if (advP50 != null && advP50 > 0) {
              const bias = (actual.median - advP50) / advP50
              if (Math.abs(bias) >= 0.1) calibFactor = 1 + bias * 0.6   // 应用 60% 修正，避免过冲
            }
          }
        } catch (e) {}
        // 候选人现薪（该岗位进复试/面试候选人的现薪）→ 三源加权最硬一源
        let currentSalaries = []
        try {
          const d0 = dataDir(); const ev0 = readEvents(d0); const s0 = fold(d0)
          for (const e of ev0) {
            if (e.type !== 'feedback.submitted') continue
            const v = (e.payload || {}).currentSalary
            if (typeof v !== 'number' || v <= 0) continue
            const cc = s0.byId[(e.subject || {}).id]
            if (q.positionId && cc && cc.pid === q.positionId) currentSalaries.push(v)
          }
        } catch (e) {}
        let res2 = salaryBenchmark(q)
        // 应用校准系数到建议区间（并标注）
        if (res2 && calibFactor && res2.P50 != null) {
          const r1 = (x) => Math.round(x * calibFactor * 10) / 10
          res2 = { ...res2, P25: r1(res2.P25), P50: r1(res2.P50), P75: r1(res2.P75),
            suggest: { min: r1(res2.suggest.min), mid: r1(res2.suggest.mid), max: r1(res2.suggest.max) },
            calibrated: true, calibFactor: Math.round(calibFactor * 100) / 100,
            positioning: (res2.positioning || '') + '（已按本岗位实招数据校准 ×' + (Math.round(calibFactor * 100) / 100) + '）' }
        }
        // 报告匹配不到（noData）时：用 LLM 做市场估算（标注 AI 估算，替代粗粒度岗位族表）
        if (res2 && res2.noData) {
          try {
            const prompt = [
              '你是资深薪酬顾问。请根据中国招聘市场行情，给出下面岗位的月薪分位值（税前，单位 K/月）。',
              '岗位：' + (q.title || '') + '；部门：' + (q.dept || '未填') + '；城市：' + (q.city || '未填') + '；经验：' + (q.expYears || '未填') + ' 年',
              '能力要求：' + (q.abilities || '未填'),
              actual ? ('【本岗位实招参考】已有 ' + actual.count + ' 次实际 Offer 薪资：最低 ' + actual.min + 'K，中位 ' + actual.median + 'K，最高 ' + actual.max + 'K。请以此为锚点校准估算（实招数据优先级高于市场行情）。') : '',
              '要求：结合岗位的行业与稀缺性给合理区间（如 AI/算法类高于传统岗位；新兴复合岗位要考虑溢价）。不要编造具体公司数据。',
              '只输出 JSON：{"P25":数字,"P50":数字,"P75":数字,"basis":"一句话说明依据（岗位稀缺性/行业水平/城市差异）","confidence":"high|mid|low"}',
            ].join('\n')
            const txt = await llmText(prompt)
            let est = null
            try { const m = String(txt).match(/\{[\s\S]*\}/); if (m) est = JSON.parse(m[0]) } catch (e) {}
            if (est && typeof est.P25 === 'number' && typeof est.P50 === 'number' && typeof est.P75 === 'number') {
              res2 = {
                ...res2, noData: false, aiEstimate: true,
                P25: est.P25, P50: est.P50, P75: est.P75,
                suggest: { min: est.P25, mid: est.P50, max: est.P75 },
                source: 'AI 市场估算（非薪酬报告数据，仅供参考）',
                positioning: 'AI 估算：P25 ' + est.P25 + 'K / P50 ' + est.P50 + 'K / P75 ' + est.P75 + 'K（' + (est.confidence === 'high' ? '置信高' : est.confidence === 'low' ? '置信低' : '置信中') + '）' + (est.basis ? '：' + est.basis : ''),
                reason: '该岗位未在本地薪酬报告中找到基准，以下为 AI 基于市场行情的估算（仅供参考，建议结合公司预算与实招反馈校准）：' + (est.basis || ''),
              }
            }
          } catch (e) {}
        }
        // 三源加权：候选人现薪（0.45）+ 实招（0.35）+ 报告/估算（0.20）
        let blend = null
        try {
          const { blendSalaryEvidence } = await import('./salary.js')
          const ev2 = { currentSalaries }
          if (actual) ev2.actualOffers = actual
          if (res2 && res2.P25 != null) ev2.report = res2.aiEstimate ? null : { P25: res2.P25, P50: res2.P50, P75: res2.P75 }
          if (res2 && res2.P25 != null && res2.aiEstimate) ev2.estimate = { P25: res2.P25, P50: res2.P50, P75: res2.P75 }
          ev2.samePosition = !!q.positionId
          if ((currentSalaries.length + (actual ? actual.count : 0)) >= 1) {
            blend = blendSalaryEvidence(ev2)
            if (blend) {
              res2 = { ...res2, P25: blend.P25, P50: blend.P50, P75: blend.P75, suggest: blend.suggest,
                blended: true, confidence: blend.confidence, evidenceBasis: blend.basis, evidenceCount: blend.evidenceCount,
                positioning: '综合' + blend.basis.length + '类证据加权（置信' + (blend.confidence === 'high' ? '高' : blend.confidence === 'mid' ? '中' : '低') + '）：' + blend.basis.join(' + ') }
            }
          }
        } catch (e) {}
        return new Response(JSON.stringify({ ok: true, ...res2, actual, currentSalaries, blended: !!(res2 && res2.blended) }), {
          status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    },
  }))

  /* ============ Client 实时读取 ============ */
  dispose.push(ctx.webServer.register({
    kind: 'exact', path: '/api/ai-recruiting/board',
    resource: async () => {
      try {
        const d = config && config.dataDir
          ? config.dataDir
          : join((ctx.workingDirectory && ctx.workingDirectory.defaultDirectory) || process.cwd(), 'recruiting')
        ensure(d); migrateLegacy(d); project(d)
        return new Response(JSON.stringify(buildDashboard(d)), {
          status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
          status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }
    },
  }))

  dispose.push(ctx.systemPrompt.section({
    name: 'tool:recruit', order: 900,
    text: [
      'AI 招聘工作台：事实层是 append-only 的 events.jsonl，状态全部由 fold 派生。任何"改状态"的冲动都要先翻译成一条事件。',
      '人只在判断点出现，永不直接编辑状态；淘汰与 Offer 只能经 recruit_decide。机的产出必带证据、置信度与规范版本，低置信必须停下转人。',
      '判断由你读简历原文做出：先 recruit_evaluation_packet 取资料包与因果链，再 recruit_record_assessment 落库；不要用公式算分，缺证据判「未判定」。',
      '在结论处停下来问人，人回一个词就用 recruit_decide 落库；人的纠偏用 recruit_calibrate，产出是规范版本建议而非改分。用 recruit_replay 追溯任意结论，用 recruit_standards 查看版本链。',
      '来源渠道固定码只用于统计，不进评分与排序。',
    ].join(' '),
  }))

  const cleanup = () => { for (const f of dispose) { try { if (typeof f === 'function') f() } catch (e) { /* ignore */ } } }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  return cleanup
}
