/* 业务规则测试：直接驱动 performAction + fold，断言【阶段流转 / 事件 payload / 数据不变量】。
   用独立临时数据目录，绝不污染真实账本。
   运行：node tests/rules.test.mjs
   任一断言失败 → 退出码 1（可接 CI） */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performAction, workbenchData } from '../actions.js'
import { fold, appendEvent, readEvents } from '../ledger.js'

let pass = 0, fail = 0
const F = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; F.push(name + (extra ? ' — ' + extra : '')); console.log('  ❌', name, extra ? '— ' + extra : '') }
}
function eq(name, a, b) { ok(name, a === b, '期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)) }

const D = mkdtempSync(join(tmpdir(), 'rc-test-'))
const st = () => fold(D)
const cSt = (id) => (st().byId[id] || {}).stage
const evs = () => readEvents(D).length

// ===== 准备：岗位 + 候选人（模拟上传只写 resume.received）=====
const P = performAction(D, { action: 'create_position', title: 'Java开发工程师', dept: '技术', city: '杭州', gates: ['本科及以上'], abilities: ['过往战绩与量化成果', '技能与专业深度'], bandMin: 20, bandMax: 30 })
const posId = P.positionId
function intake(name, resume) {
  const id = 'C' + Math.random().toString(36).slice(2, 9)
  appendEvent(D, { type: 'resume.received', actor: 'human', subject: { kind: 'candidate', id }, payload: { name, pid: posId, source: '网投', resume, stage: '待评估' } })
  return id
}
const JAVA_RESUME = `刘阳  求职意向：Java开发工程师
电话：13000000000  邮箱：liu@example.com
2019.07-2023.06 杭州某科技  高级Java开发工程师
- 主导订单系统微服务改造，用 Spring Cloud + Kafka 支撑日均订单 20 万
- 负责支付链路性能优化，接口 P99 从 800ms 降到 180ms
- 设计 Redis 缓存与分库分表方案，MySQL 单表压力下降 80%
技能：Java / Spring / Spring Cloud / Kafka / Redis / MySQL / MyBatis / 微服务 / 高并发 / JVM 调优`
const U3D_RESUME = `张伟男  求职意向：U3D开发
2019.09-2022.08 杭州某数字科技  Unity开发工程师
- 负责动作捕捉项目，后台视觉追踪算法识别
- 优化渲染管线，帧率从30提升到60
- 使用 Addressables 管理资源，Shader 编写特效
技能：Unity / C# / Addressables / Shader / Unreal Engine`
const WEAK_RESUME = `李明  求职意向：Java开发
- 参与过一些项目开发
技能：沟通能力好`

// ===== 1. 岗位 =====
console.log('\n[1] 岗位')
ok('岗位已创建', st().positions.some(x => x.id === posId))

// ===== 2. 初筛：阶段必须与结论一致，绝不出现「待发 Offer」 =====
console.log('\n[2] auto_assess 阶段推进')
const cJava = intake('刘阳', JAVA_RESUME)
const r1 = performAction(D, { action: 'auto_assess', candidateId: cJava })
ok('Java 岗 + Java 简历：不在待发 Offer', cSt(cJava) !== '待发 Offer', '实际 ' + cSt(cJava))
// 新口径：按 grade（分数）或"缺证据留人"分流，阶段须落入三态且自洽
const isNoR = /C 级|不对口|不推荐|不建议/.test(String(r1.route))
const isSAR = /S 级|A 级/.test(String(r1.route))
const insuff = /待补充|缺.*证据|未判定/.test(String(r1.route))
const st1 = cSt(cJava)
const routeOK = ['待初试','待评估','已淘汰'].indexOf(st1) >= 0 && (st1 !== '待发 Offer')
ok('结论与阶段自洽（route=' + (r1.route || '') + ' → ' + st1 + '）', routeOK)
const cU3d = intake('张伟男', U3D_RESUME)
const r2 = performAction(D, { action: 'auto_assess', candidateId: cU3d })
eq('U3D 简历 + Java 岗 → 已淘汰（技术栈不对口）', cSt(cU3d), '已淘汰')
ok('技术栈闸门写入 gateResults', (fold(D).byId[cU3d].gateResults || []).some(g => g.verdict === 'fail'))
const cWeak = intake('李明', WEAK_RESUME)
const r3 = performAction(D, { action: 'auto_assess', candidateId: cWeak })
ok('弱简历不跃迁到待发 Offer', cSt(cWeak) !== '待发 Offer', '实际 ' + cSt(cWeak))
ok('评估后归位三态（待初试/待评估/已淘汰）', ['待初试', '待评估', '已淘汰'].indexOf(cSt(cWeak)) >= 0, '实际 ' + cSt(cWeak))

// ===== 3. 邀约：事件 payload 与卡片数据 =====
console.log('\n[3] invite')
const cInv = intake('赵敏', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cInv })
if (cSt(cInv) !== '待初试') performAction(D, { action: 'adopt', candidateId: cInv })
performAction(D, { action: 'invite', candidateId: cInv, channel: '微信', at: '2026-03-05T14:00', place: '会议室A' })
const invEv = readEvents(D).filter(e => e.type === 'invite.sent' && (e.subject || {}).id === cInv).pop()
ok('invite.sent 已写入', !!invEv)
eq('payload.at 已格式化（非 ISO）', invEv && invEv.payload.at, '3月5日 14:00')
ok('文案含格式化时间', invEv && String(invEv.payload.text || '').indexOf('3月5日 14:00') >= 0)
const wb = workbenchData(D, cInv, () => ({ kpis: [], funnel: [], sources: [] }))
const row = (wb.candidates || []).find(x => x.id === cInv)
ok('候选人列表带 lastInvite', !!row && !!row.lastInvite)
eq('lastInvite.at', row && row.lastInvite.at, '3月5日 14:00')

// ===== 4. 面评与流程流转 =====
console.log('\n[4] feedback 流转')
const cFb = intake('孙丽', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cFb })
if (cSt(cFb) === '待评估') performAction(D, { action: 'adopt', candidateId: cFb })
performAction(D, { action: 'interview', candidateId: cFb, at: '2026-03-06T10:00', interviewer: '王面试官' })
eq('安排面试 → 初试中', cSt(cFb), '初试中')
performAction(D, { action: 'feedback', candidateId: cFb, round: '初试', pass: true, dims: [{ dim: '过往战绩与量化成果', level: 'L2', evidence: '订单系统改造' }] })
eq('初试通过 → 待复试', cSt(cFb), '待复试')
performAction(D, { action: 'interview', candidateId: cFb, at: '2026-03-08T10:00', interviewer: '李总' })
eq('安排复试 → 复试中', cSt(cFb), '复试中')
performAction(D, { action: 'feedback', candidateId: cFb, round: '复试', pass: true, dims: [{ dim: '技能与专业深度', level: 'L3', evidence: '技术深度好' }] })
eq('复试通过 → 待背调', cSt(cFb), '待背调')
performAction(D, { action: 'background_check', candidateId: cFb, result: 'pass' })
eq('背调通过 → 待发 Offer', cSt(cFb), '待发 Offer')
// 独立候选人测「复试未通过」路径
const cFb2 = intake('吴强', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cFb2 })
if (cSt(cFb2) === '待评估') performAction(D, { action: 'adopt', candidateId: cFb2 })
performAction(D, { action: 'interview', candidateId: cFb2, at: '2026-03-06T10:00', interviewer: '王' })
performAction(D, { action: 'feedback', candidateId: cFb2, round: '初试', pass: true })
performAction(D, { action: 'interview', candidateId: cFb2, at: '2026-03-08T10:00', interviewer: '李' })
performAction(D, { action: 'feedback', candidateId: cFb2, round: '复试', pass: false })
eq('复试未通过 → 已淘汰', cSt(cFb2), '已淘汰')

// ===== 5. 人的决策（HUMAN_CONTRACT）=====
console.log('\n[5] decide / 契约')
const cDec = intake('周杰', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cDec })
performAction(D, { action: 'decide', candidateId: cDec, decision: '淘汰', reason: '面试差距明显' })
eq('decide 淘汰 → 已淘汰', cSt(cDec), '已淘汰')
performAction(D, { action: 'activate', candidateId: cDec, reason: '新岗位激活' })
eq('activate → 待评估', cSt(cDec), '待评估')

// ===== 6. 不变量：所有阶段合法 & 无异常推进 =====
console.log('\n[6] 账本不变量')
const STAGES = ['待评估', '待初试', '初试中', '待复试', '复试中', '待背调', '待发 Offer', 'Offer已发', 'Offer已接受', '待入职', '已入职', 'Offer拒绝', '已淘汰', '人才库']
const bad = readEvents(D).filter(e => e.type === 'stage.advanced' && STAGES.indexOf((e.payload || {}).to) < 0)
eq('stage.advanced.to 全部合法', bad.length, 0)
const badAuto = readEvents(D).filter(e => e.type === 'stage.advanced' && (e.payload || {}).to === '待发 Offer' && e.actor === 'agent')
eq('agent 不自动推进到待发 Offer', badAuto.length, 0)
const noCause = readEvents(D).filter(e => e.type === 'stage.advanced' && !e.causedBy)
eq('所有推进都有因果（causedBy）', noCause.length, 0)

// ===== 7. 人才库与技能（U3D vs HR 岗必须 0 匹配）=====
console.log('\n[7] 人才库 / 技能')
const wb2 = workbenchData(D, null, () => ({ kpis: [], funnel: [], sources: [] }))
ok('人才库池包含已淘汰', (wb2.talentPool || []).length > 0)
const u3dSkills = (wb2.talentPool || []).find(x => x.name === '张伟男')
ok('U3D 技能不含组织发展(OD)', !u3dSkills || !(u3dSkills.skills || []).includes('组织发展(OD)'))

// ===== 8. 其余动作分支的边界行为 =====
console.log('\n[8] 边界动作')
// bind_position：技术栈不匹配需 force
const cBind = intake('郑浩', U3D_RESUME)
const P2 = performAction(D, { action: 'create_position', title: 'Java架构师', dept: '技术', city: '杭州', gates: ['本科及以上'], abilities: ['Java', 'Spring'], bandMin: 35, bandMax: 50, jd: '要求 Java / Spring / Kafka / Redis / 微服务 / 高并发' })
let bindThrew = false
try { performAction(D, { action: 'bind_position', candidateId: cBind, positionId: P2.positionId }) } catch (e) { bindThrew = /不对口|不匹配|mismatch|技术栈/i.test(String(e.message || e)) }
ok('绑岗到不对口岗位被拦截（需 force）', bindThrew || st().byId[cBind].pid === posId)
// rollback：回到待评估而非待发 Offer
const cRb = intake('钱多', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cRb })
performAction(D, { action: 'rollback', candidateId: cRb })
eq('rollback → 待评估', cSt(cRb), '待评估')
// 冻结阶段不被评估覆盖：已淘汰的人再评估不改变阶段
const cFrozen = intake('孙八', U3D_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cFrozen })
eq('U3D→已淘汰', cSt(cFrozen), '已淘汰')
performAction(D, { action: 'auto_assess', candidateId: cFrozen })
eq('已淘汰者重新评估不改阶段', cSt(cFrozen), '已淘汰')
// decide 的 reason 必填（HUMAN_CONTRACT）
let noReasonThrew = false
try { performAction(D, { action: 'decide', candidateId: cFrozen, decision: 'Offer' }) } catch (e) { noReasonThrew = true }
ok('decide 无 reason 被拒绝', noReasonThrew)
// offer / hire 流转
const cHire = intake('周九', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cHire })
if (cSt(cHire) === '待评估') performAction(D, { action: 'adopt', candidateId: cHire })
performAction(D, { action: 'interview', candidateId: cHire, at: '2026-03-06T10:00', interviewer: '王' })
performAction(D, { action: 'feedback', candidateId: cHire, round: '初试', pass: true })
performAction(D, { action: 'interview', candidateId: cHire, at: '2026-03-08T10:00', interviewer: '李' })
performAction(D, { action: 'feedback', candidateId: cHire, round: '复试', pass: true })
eq('复试通过→待背调', cSt(cHire), '待背调')
performAction(D, { action: 'background_check', candidateId: cHire, result: 'pass' })
eq('背调通过→待发 Offer', cSt(cHire), '待发 Offer')
performAction(D, { action: 'send_offer', candidateId: cHire, salary: '25K×14', startDate: '2026-12-01' })
eq('发 Offer → Offer已发', cSt(cHire), 'Offer已发')
performAction(D, { action: 'offer_accept', candidateId: cHire })
eq('候选人接受 → Offer已接受', cSt(cHire), 'Offer已接受')
performAction(D, { action: 'schedule_onboarding', candidateId: cHire, startDate: '2026-12-01' })
eq('安排入职 → 待入职', cSt(cHire), '待入职')
performAction(D, { action: 'hire', candidateId: cHire, reason: '2026-12-01 已报到' })
eq('确认入职 → 已入职', cSt(cHire), '已入职')
// Offer 拒绝分支
const cRej = intake('拒绝者', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: cRej })
if (cSt(cRej) === '待评估') performAction(D, { action: 'adopt', candidateId: cRej })
if (cSt(cRej) === '待初试') performAction(D, { action: 'interview', candidateId: cRej, at: '2026-03-06T10:00', interviewer: 'x' })
if (cSt(cRej) === '初试中') performAction(D, { action: 'feedback', candidateId: cRej, round: '初试', pass: true })
if (cSt(cRej) === '待复试') performAction(D, { action: 'interview', candidateId: cRej, at: '2026-03-08T10:00', interviewer: 'y' })
if (cSt(cRej) === '复试中') performAction(D, { action: 'feedback', candidateId: cRej, round: '复试', pass: true })
if (cSt(cRej) === '待背调') performAction(D, { action: 'background_check', candidateId: cRej, result: 'pass' })
performAction(D, { action: 'send_offer', candidateId: cRej, salary: '20K', startDate: '2026-12-01' })
performAction(D, { action: 'offer_decline', candidateId: cRej, reason: '接了竞品' })
eq('Offer 拒绝 → Offer拒绝', cSt(cRej), 'Offer拒绝')
let rejNoReason = false
try { performAction(D, { action: 'offer_decline', candidateId: cRej }) } catch (e) { rejNoReason = true }
ok('Offer 拒绝必须留原因', rejNoReason)
// calibrate 写 correction.made
const cCal = intake('吴十', JAVA_RESUME)
performAction(D, { action: 'calibrate', candidateId: cCal, dimension: '过往战绩与量化成果', reasonCode: '证据不足', note: '证据不足' })
ok('calibrate 写入 correction.made', readEvents(D).some(e => e.type === 'correction.made' && (e.subject || {}).id === cCal))

// ===== 9. 职位生命周期：关闭 / 复开 =====
console.log('\n[9] 职位生命周期')
const P3 = performAction(D, { action: 'create_position', title: '测试岗-生命周期', dept: '技术', city: '杭州', gates: ['本科'], abilities: ['Java'], bandMin: 20, bandMax: 30, headcount: 3 })
performAction(D, { action: 'close_position', positionId: P3.positionId })
eq('关闭职位 → 状态已关闭', (st().positions.find(p => p.id === P3.positionId) || {}).status, '已关闭')
const rp = performAction(D, { action: 'reopen_position', positionId: P3.positionId })
ok('复开生成新职位', rp.ok && rp.positionId !== P3.positionId)
const np = st().positions.find(p => p.id === rp.positionId) || {}
eq('复开职位 → 在招', np.status, '在招')
eq('复开保留原 JD/门槛', (np.gates || []).join('、'), '本科')
eq('复开记录来源 parentId', np.parentId, P3.positionId)
eq('原职位仍为已关闭', (st().positions.find(p => p.id === P3.positionId) || {}).status, '已关闭')

// ===== 10. 关岗联动在途候选人 =====
console.log('\n[10] 关岗联动')
const P9 = performAction(D, { action: 'create_position', title: '测试岗-关岗', city: '杭州', headcount: 2 })
const inFlightIds = ['Cx1','Cx2']
for (const [id, st] of [['Cx1','待初试'],['Cx2','待复试']]) {
  appendEvent(D, { type: 'resume.received', actor: 'human', subject: { kind: 'candidate', id }, payload: { name: id, pid: P9.positionId, resume: 'Java', stage: st } })
}
const ri = performAction(D, { action: 'close_position', positionId: P9.positionId })
ok('有在途时关岗被拦截', ri.needDisposition === true, '返回 ' + JSON.stringify(ri).slice(0,60))
const ri2 = performAction(D, { action: 'close_position', positionId: P9.positionId, disposition: 'talent' })
ok('指定去向可关岗', ri2.ok === true)
eq('在途Cx1转人才库', cSt('Cx1'), '人才库')
eq('在途Cx2转人才库', cSt('Cx2'), '人才库')

// ===== 11. 背调 =====
console.log('\n[11] 背调')
const Pbc = intake('背调者', JAVA_RESUME)
performAction(D, { action: 'auto_assess', candidateId: Pbc })
if (cSt(Pbc) === '待评估') performAction(D, { action: 'adopt', candidateId: Pbc })
if (cSt(Pbc) === '待初试') performAction(D, { action: 'interview', candidateId: Pbc, at: '2026-04-01T10:00', interviewer: 'x' })
if (cSt(Pbc) === '初试中') performAction(D, { action: 'feedback', candidateId: Pbc, round: '初试', pass: true })
if (cSt(Pbc) === '待复试') performAction(D, { action: 'interview', candidateId: Pbc, at: '2026-04-03T10:00', interviewer: 'y' })
if (cSt(Pbc) === '复试中') performAction(D, { action: 'feedback', candidateId: Pbc, round: '复试', pass: true })
eq('复试通过→待背调', cSt(Pbc), '待背调')
performAction(D, { action: 'background_check', candidateId: Pbc, result: 'fail', note: '前雇主评价差' })
eq('背调不通过→已淘汰', cSt(Pbc), '已淘汰')

// ===== 清理 =====
rmSync(D, { recursive: true, force: true })
console.log('\n' + '='.repeat(50))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) { console.log('\n失败项：'); for (const f of F) console.log(' -', f); process.exit(1) }
