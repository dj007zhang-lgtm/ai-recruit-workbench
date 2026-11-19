/* 评分卡：由 JD（岗位要求）派生，不是手填。双轨制——硬门槛（一票否决）+ 软价值（梯度权重）。
   科学设计原则：行为动词+量化结果导向、反伪相关/歧视、动态对齐业务、AI评分+人工校准闭环。 */

import { detectJobStackGroup, STACK_LABELS } from './deepscore.js'

export const SCORECARD_VERSION = 1

export function emptyScorecard() {
  return {
    schemaVersion: SCORECARD_VERSION,
    hardGates: [],        // [{ item, rule, rejectIf }] 一票否决
    softDims: [],         // [{ name, weight, levels: [{ level:'L0'..'L3', anchor:'客观描述', score:0-100 }] }] BARS
    antiBias: ['性别', '年龄', '婚育', '民族', '宗教', '户籍', '院校出身歧视', '星座'],
    businessFocus: '',    // 动态对齐的业务重点
    meta: { fromJDVersion: '', generatedBy: '', at: '' },
  }
}

const DEPT_SOFT = {
  '零售': [
    { name: '过往战绩与量化成果', weight: 40, levels: [
      { level: 'L0', anchor: '仅罗列门店日常职责，无任何业绩/人效/损耗数据', score: 0 },
      { level: 'L1', anchor: '提及销售额/客诉等指标，但无具体数字或归因', score: 40 },
      { level: 'L2', anchor: '给出可核实的门店业绩/人效/损耗改善量化结果', score: 75 },
      { level: 'L3', anchor: '多店或规模化场景下实现显著量化提升（如扭亏/GMV大幅增长）', score: 100 },
    ] },
    { name: '技能与专业深度', weight: 30, levels: [
      { level: 'L0', anchor: '无门店运营相关技能描述', score: 0 },
      { level: 'L1', anchor: '提及排班/陈列/客诉等单项技能', score: 40 },
      { level: 'L2', anchor: '覆盖排班+目标拆解+客诉+损耗中多项，有实操案例', score: 75 },
      { level: 'L3', anchor: '全链路精通且能沉淀方法/带教他人', score: 100 },
    ] },
    { name: '行业与赛道匹配', weight: 20, levels: [
      { level: 'L0', anchor: '无零售/连锁相关经历', score: 0 },
      { level: 'L1', anchor: '相关零售经验但非同等业态', score: 50 },
      { level: 'L2', anchor: '头部零售/连锁门店管理经验', score: 100 },
    ] },
    { name: '职业成长与经验积累', weight: 10, levels: [
      { level: 'L0', anchor: '经历与岗位所需能力无关联，看不出积累方向', score: 0 },
      { level: 'L1', anchor: '有相关经历，能力有一定积累', score: 60 },
      { level: 'L2', anchor: '经历层层递进，能力持续迭代与拓宽', score: 100 },
    ] },
  ],
  '电商': [
    { name: '过往战绩与量化成果', weight: 40, levels: [
      { level: 'L0', anchor: '仅职责描述，无 GMV/ROI/转化等数据', score: 0 },
      { level: 'L1', anchor: '提及 GMV/流量增长但无成本/ROI/毛利口径', score: 40 },
      { level: 'L2', anchor: '有可核实的 GMV/ROI/转化率量化提升', score: 75 },
      { level: 'L3', anchor: '规模化店铺/大促下实现显著增长且有归因', score: 100 },
    ] },
    { name: '技能与专业深度', weight: 30, levels: [
      { level: 'L0', anchor: '无电商运营相关技能', score: 0 },
      { level: 'L1', anchor: '掌握店铺运营/数据分析单项', score: 40 },
      { level: 'L2', anchor: '覆盖运营+投放+复盘多项，有实操', score: 75 },
      { level: 'L3', anchor: '全链路精通并能搭建体系/带团队', score: 100 },
    ] },
    { name: '行业与赛道匹配', weight: 20, levels: [
      { level: 'L0', anchor: '无电商/线上运营经历', score: 0 },
      { level: 'L1', anchor: '相关电商经验但业态不同', score: 50 },
      { level: 'L2', anchor: '头部电商平台/品牌运营经验', score: 100 },
    ] },
    { name: '职业成长与经验积累', weight: 10, levels: [
      { level: 'L0', anchor: '经历与岗位所需能力无关联，看不出积累方向', score: 0 },
      { level: 'L1', anchor: '有相关经历，能力有一定积累', score: 60 },
      { level: 'L2', anchor: '经历层层递进，能力持续迭代与拓宽', score: 100 },
    ] },
  ],
  '研发': [
    { name: '过往战绩与量化成果', weight: 40, levels: [
      { level: 'L0', anchor: '仅罗列技术职责，无任何性能/规模/成果数据', score: 0 },
      { level: 'L1', anchor: '提及系统/项目但无指标或体量', score: 40 },
      { level: 'L2', anchor: '有可核实的技术指标（QPS/延迟/可用性）或项目规模数据', score: 75 },
      { level: 'L3', anchor: '大规模/高复杂度系统下实现显著指标提升并有归因', score: 100 },
    ] },
    { name: '技能与专业深度', weight: 30, levels: [
      { level: 'L0', anchor: '无岗位核心技术栈描述', score: 0 },
      { level: 'L1', anchor: '会用语但无深度案例', score: 40 },
      { level: 'L2', anchor: '精通核心栈且有架构/性能/复杂问题解决案例', score: 75 },
      { level: 'L3', anchor: '技术深度突出，主导过关键系统设计或技术突破', score: 100 },
    ] },
    { name: '行业与赛道匹配', weight: 20, levels: [
      { level: 'L0', anchor: '无相关行业/业务形态经历', score: 0 },
      { level: 'L1', anchor: '相关技术但业务形态不同', score: 50 },
      { level: 'L2', anchor: '目标行业/相近业务形态头部经历', score: 100 },
    ] },
    { name: '职业成长与经验积累', weight: 10, levels: [
      { level: 'L0', anchor: '经历与岗位所需能力无关联，看不出积累方向', score: 0 },
      { level: 'L1', anchor: '有相关经历，能力有一定积累', score: 60 },
      { level: 'L2', anchor: '经历层层递进，能力持续迭代与拓宽', score: 100 },
    ] },
  ],
}

function deptKey(dept) {
  if (!dept) return ''
  for (const k of Object.keys(DEPT_SOFT)) if (dept.indexOf(k) >= 0) return k
  return ''
}

function splitList(x) {
  if (Array.isArray(x)) return x.map(s => String(s).trim()).filter(Boolean)
  return String(x || '').split(/[、,，\n>]/).map(s => s.trim()).filter(Boolean)
}

/** 规则引擎：由 JD 对象/岗位信息生成双轨评分卡（LLM 失败时兜底，也可作 LLM 结果的骨架校验）*/
export function ruleScorecard(p, jd) {
  const dept = String(p.dept || (jd && jd.dept) || '')
  const key = deptKey(dept)
  const gates = splitList(p.gates)
  const abilities = splitList(p.abilities)
  const sc = emptyScorecard()

  // 硬门槛：来自 JD 的硬门槛 + 经验底线，一票否决
  const hard = []
  for (const g of gates) hard.push({ item: g, rule: '需明确满足', rejectIf: '未满足则标记不推荐' })
  if (jd && jd.qualifications && jd.qualifications.experience) {
    hard.push({ item: jd.qualifications.experience, rule: '经验底线', rejectIf: '年限或对口经验不足则一票否决' })
  }
  if (!hard.length) hard.push({ item: '满足岗位基本任职要求', rule: '底线过滤', rejectIf: '明显不符则标记不推荐' })
  // 核心技术栈对口（一票否决）：岗位有明确技术栈时，候选人技术方向必须对口
  const stackGroup = detectJobStackGroup(p)
  if (stackGroup && STACK_LABELS[stackGroup]) {
    hard.unshift({ item: '核心技术栈：' + STACK_LABELS[stackGroup].name, rule: '技术方向一致', rejectIf: '简历技术方向明显不对口（如 U3D 投 Java 后端）则一票否决', stackGroup })
  }
  sc.hardGates = hard

  // 软价值维度：部门模板 + 用 JD 能力项补充技能维度描述
  const tmpl = DEPT_SOFT[key] || DEPT_SOFT['研发']
  sc.softDims = tmpl.map(d => ({ name: d.name, weight: d.weight, levels: d.levels }))
  if (abilities.length) {
    const skillDim = sc.softDims.find(d => d.name.indexOf('技能') >= 0)
    if (skillDim && skillDim.levels[2]) skillDim.levels[2].anchor = '完整覆盖：' + abilities.join('、') + '，有实操案例'
  }
  // 业务重点（动态对齐）
  sc.businessFocus = String(p.businessContext || (jd && jd.meta && jd.meta.basedOnBusiness) || '')
  sc.meta.generatedBy = 'rule-engine'
  sc.meta.at = new Date().toISOString()
  sc.meta.fromJDVersion = jd && jd.meta ? 'v' + (jd.meta.version || 1) : ''
  return sc
}

/** 评分卡 → Markdown（展示/存原文用）*/
export function scorecardToMarkdown(sc, title) {
  const L = []
  L.push(`# ${title || '岗位'} · 初筛评分卡（100 分制 · 双轨制）`)
  if (sc.businessFocus) L.push(`\n**业务重点对齐**：${sc.businessFocus}`)
  L.push('\n## 第一轨：硬性门槛（一票否决）')
  ;(sc.hardGates || []).forEach(g => L.push(`- ${g.item}（${g.rule}；${g.rejectIf}）`))
  L.push('\n## 第二轨：业务价值与能力匹配（加权得分）')
  ;(sc.softDims || []).forEach(d => {
    L.push(`\n### ${d.name}（权重 ${d.weight}%）`)
    ;(d.levels || []).forEach(lv => L.push(`- [${lv.level}] ${lv.anchor}：${lv.score} 分`))
  })
  L.push('\n> 反伪相关黑名单：' + (sc.antiBias || []).join('、') + '（不计分，不歧视）')
  L.push('\n> AI 评分需人工校准闭环：定期抽查被淘汰者召回率、跟踪高分者面试效度，反向调权。')
  return L.join('\n')
}
