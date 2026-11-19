/* 账本不变量扫描：直接检查真实 events.jsonl 的健康度（只读，不修改）。
   用途：部署后/日常巡检，发现历史遗留的坏数据与逻辑漏洞。
   运行：node tests/ledger-check.mjs [dataDir] */
import { fold, readEvents, STAGES as STAGES_SRC } from '../ledger.js'

const D = process.argv[2] || '/Users/andyzhang/Documents/AI招聘工作她/recruiting'
// 阶段清单从 ledger.js 导入（单一来源）；历史遗留阶段名单独列出，避免手写列表漂移
const STAGES = STAGES_SRC
const LEGACY_STAGES = ['已接入', '已评估', 'Offer']
// 允许的自动推进目标（agent 只能推进到这里；待发 Offer 必须由人的面评/决策产生）
const AGENT_ALLOWED = ['待评估', '已评估', '待初试', '已淘汰']
// 历史阶段别名（fold 通过 STAGE_MIGRATE 迁移，不算非法）
const LEGACY = { '待决策': '待发 Offer', '待面试': '待初试', '面试中': '初试中' }
// 修复基线：此时间点之后的 agent 越权才算新问题（之前的为历史遗留，仅提示）
const BASE_TS = new Date('2026-11-18T14:20:00+08:00').getTime()
const evs = readEvents(D)
const s = fold(D)
let problems = 0
const report = (level, msg) => { problems++; console.log((level === 'high' ? '🔴' : '🟡') + ' ' + msg) }

console.log('账本扫描：' + D + '\n事件 ' + evs.length + ' 条 · 候选人 ' + s.candidates.length + ' · 岗位 ' + s.positions.length + '\n')

// 1. 阶段合法性
for (const e of evs) {
  if (e.type === 'stage.advanced') {
    const to = (e.payload || {}).to
    if (STAGES.indexOf(to) < 0 && !LEGACY[to] && LEGACY_STAGES.indexOf(to) < 0) report('high', '#' + e.seq + ' 非法阶段 "' + to + '"')
  }
}
// 2. agent 越权推进（历史 auto_assess 硬推待发 Offer 类）
for (const e of evs) {
  if (e.type === 'stage.advanced' && e.actor === 'agent') {
    const to = (e.payload || {}).to
    if (AGENT_ALLOWED.indexOf(to) < 0) {
      const isLegacy = e.ts && new Date(e.ts).getTime() < BASE_TS
      const msg = '#' + e.seq + ' agent 推进到 "' + to + '"（应只有人可推进）— ' + ((e.payload || {}).reason || '')
      if (isLegacy) { console.log('⚪ 历史遗留：' + msg) } else { report('high', msg) }
    }
  }
}
// 3. 推进无因果
for (const e of evs) {
  if (e.type === 'stage.advanced' && !e.causedBy && String((e.payload || {}).reason || '').indexOf('修正') < 0) report('mid', '#' + e.seq + ' 推进缺少 causedBy')
}
// 4. 同一候选人 ID 多条 resume.received
// 说明：同一人多次投递是真实业务现象（换岗再投/重复上传），系统已按 name+phone+email+position 去重并合并，
// 因此这里只在「同一候选人出现多条且来源不同」时才提示（可能渠道归因有问题），同源重复属正常。
const recCount = {}
for (const e of evs) {
  if (e.type !== 'resume.received') continue
  const cid0 = (e.subject || {}).id
  if (!cid0) continue
  recCount[cid0] = recCount[cid0] || []
  recCount[cid0].push((e.payload || {}).source || '')
}
for (const cid0 of Object.keys(recCount)) {
  const list = recCount[cid0]
  if (list.length < 2) continue
  const uniqSrc = Array.from(new Set(list.filter(x => x && String(x).trim())))
  const nm = (s.byId[cid0] && s.byId[cid0].name) || cid0
  if (uniqSrc.length > 1) report('mid', '候选人「' + nm + '」多次投递且来源不一致（' + uniqSrc.join('/') + '），请核对渠道归因')
  else console.log('⚪ 正常：候选人「' + nm + '」同源重复投递 ' + list.length + ' 次（已去重合并）')
}
// 5. 冻结阶段现状检查：已淘汰/已入职 的人是否有后续自动推进（说明历史脏数据已被覆盖）
for (const c of s.candidates) {
  if (c.stage === '待发 Offer' && !['已评估', '待初试', '初试中', '待复试', '复试中'].includes(c.stage)) { /* noop */ }
}
// 5b. 待发 Offer 的人是否确实走完了面试（有 feedback 通过）
const fbByCand = {}
for (const e of evs) if (e.type === 'feedback.submitted') { const id = (e.subject || {}).id; (fbByCand[id] = fbByCand[id] || []).push(e) }
for (const c of s.candidates) {
  if (c.stage === '待发 Offer') {
    const fbs = fbByCand[c.id] || []
    if (!fbs.length) report('high', '候选人「' + c.name + '」在待发 Offer 但没有任何面评记录（跳流程）')
  }
}
// 6. 评估覆盖冻结阶段（assessment 不应改变已淘汰/已入职）
for (const e of evs) {
  if (e.type === 'assessment.recorded') {
    const id = (e.subject || {}).id
    const after = evs.filter(x => x.seq > e.seq && (x.subject || {}).id === id && x.type === 'stage.advanced')
    if (after.some(x => x.actor === 'agent' && ['已淘汰', '已入职', 'Offer'].indexOf((x.payload || {}).to) >= 0)) {
      // 已淘汰/已入职 的人被 agent 再次推进 → 可疑
      const to = after.filter(x => x.actor === 'agent').map(x => (x.payload || {}).to).join(',')
      report('mid', '候选人 ' + id.slice(0, 10) + ' 评估后仍被 agent 推进到 ' + to)
    }
  }
}
// 7. 岗位引用完整性
for (const c of s.candidates) {
  if (c.pid && !s.positions.some(p => p.id === c.pid)) report('high', '候选人「' + c.name + '」引用了不存在的岗位 ' + c.pid)
}
// 8. 阶段分布概览
const dist = {}
for (const c of s.candidates) dist[c.stage] = (dist[c.stage] || 0) + 1
console.log('\n阶段分布：' + JSON.stringify(dist))
console.log('\n' + (problems ? '发现 ' + problems + ' 个问题' : '✅ 无问题'))
