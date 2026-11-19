/* 岗位 JD：结构化职责说明书 + 版本闭环 + LLM 生成（规则兜底）。
   从「单次文本生成」转向「结构化人机协作 + 动态知识库闭环」：
   - 结构化 schema：核心目的 / 组织定位 / 核心职责(动词+内容+目的+KPI) / 任用门槛 / 迭代对照
   - 版本化：每次生成是对上版的迭代，带 diff，旧版留档
   - 生成：优先 LLM（按 OD 专家提示词），失败/无模型时用规则引擎产出可用的结构化草稿
*/

export const JD_SCHEMA_VERSION = 1

/** 稳定的 JD 结构（用于人机协作编辑与渲染）*/
export function emptyJD() {
  return {
    schemaVersion: JD_SCHEMA_VERSION,
    corePurpose: '',                 // 职务核心目的（1-2 句）
    orgPosition: '',                 // 组织定位与协作网络
    responsibilities: [],            // [{ action, content, businessGoal, kpi }] 6-8 条
    qualifications: { skills: [], experience: '', complexity: '' }, // 任用门槛
    iterationDiff: '',               // 迭代对照说明
    meta: { generatedBy: '', at: '', basedOnBusiness: '', version: 1 },
  }
}

const DEPT_TEMPLATES = {
  '零售': {
    purpose: '通过门店运营与团队管理，达成销售业绩与服务质量目标，维护品牌门店形象。',
    org: '向区域运营经理汇报，横向协同商品、市场、人事与财务；向下管理门店店员与排班。',
    resp: [
      ['拆解', '门店月度销售目标并分配到班次与个人', '确保业绩可追踪、可达成', '月度销售额达成率 ≥100%'],
      ['编排', '门店人员排班与人力调度', '匹配客流高峰，控制人力成本', '人效达标、高峰缺编率 <5%'],
      ['处理', '客户投诉与服务纠纷并闭环', '维护口碑与复购', '客诉 24h 闭环率 ≥95%、满意度 ≥4.5'],
      ['管控', '门店损耗、库存与成本', '降低运营成本', '损耗率 ≤ 目标值、盘点差异 <1%'],
      ['带教', '店员培训与梯队建设', '提升团队能力与留存', '新人上手周期 ≤2 周、离职率可控'],
    ],
    skills: ['门店运营', '团队管理', '数据分析', '客户服务'],
    experience: '3 年以上零售门店管理经验，有独立带店经历',
    complexity: '中高：直接影响门店盈亏与团队稳定性',
  },
  '电商': {
    purpose: '通过线上店铺运营与活动策划，驱动 GMV 增长与用户转化效率提升。',
    org: '向电商负责人汇报，协同商品、设计、投放、客服团队。',
    resp: [
      ['策划', '店铺大促活动并落地执行', '拉动大促 GMV', '大促 GMV 达成率 ≥100%'],
      ['优化', '投放策略与 ROI', '提升获客效率', 'ROI ≥ 目标值、获客成本下降'],
      ['复盘', '店铺数据并输出改进方案', '支撑决策与迭代', '周报准时率 100%、改进项落地率 ≥80%'],
      ['管理', '商品结构与上下架', '提升动销与转化', '动销率、转化率提升'],
      ['协同', '跨部门推进活动上线', '保障活动按时交付', '活动按期上线率 100%'],
    ],
    skills: ['店铺运营', '数据分析', '活动策划', '投放优化'],
    experience: '2 年以上电商店铺运营经验',
    complexity: '中：影响店铺 GMV 与投放效率',
  },
  '研发': {
    purpose: '通过技术方案设计、开发与团队协作，交付稳定、可扩展的产品功能。',
    org: '向技术负责人汇报，协同产品、设计、测试与运维。',
    resp: [
      ['设计', '核心模块技术方案与架构', '保障可扩展与可维护', '设计评审通过、返工率低'],
      ['开发', '核心功能并保证质量', '按时交付可用功能', '需求按期交付率、线上缺陷率'],
      ['优化', '系统性能与稳定性', '提升用户体验与可用性', '关键链路 P95 延迟、可用性 ≥99.9%'],
      ['协作', '代码评审与团队知识共享', '提升团队整体质量', '评审覆盖率、规范遵守率'],
      ['排查', '线上问题与故障', '快速恢复与根因治理', 'MTTR、故障复现率下降'],
    ],
    skills: ['系统设计', '编码实现', '性能优化', '协作沟通'],
    experience: '3 年以上相关技术栈开发经验',
    complexity: '高：直接影响产品交付质量与系统稳定',
  },
}

function deptKey(dept) {
  if (!dept) return ''
  for (const k of Object.keys(DEPT_TEMPLATES)) if (dept.indexOf(k) >= 0) return k
  return ''
}

function splitList(x) {
  if (Array.isArray(x)) return x.map(s => String(s).trim()).filter(Boolean)
  return String(x || '').split(/[、,，\n>]/).map(s => s.trim()).filter(Boolean)
}

/** 规则引擎：产出具结构与可用性的 JD 草稿（无 LLM 时兜底，也是 LLM 失败时的降级）*/
export function ruleJD(p) {
  const title = String(p.title || '').trim() || '未命名岗位'
  const dept = String(p.dept || '')
  const city = String(p.city || '')
  const key = deptKey(dept)
  const tmpl = DEPT_TEMPLATES[key] || DEPT_TEMPLATES['研发']
  const gates = splitList(p.gates)
  const abilities = splitList(p.abilities)

  const jd = emptyJD()
  jd.corePurpose = tmpl.purpose
  jd.orgPosition = tmpl.org
  jd.responsibilities = tmpl.resp.map(r => ({ action: r[0], content: r[1], businessGoal: r[2], kpi: r[3] }))
  // 把岗位能力项补充为职责（若有）
  for (const a of abilities) {
    if (jd.responsibilities.length >= 8) break
    jd.responsibilities.push({ action: '负责', content: a + '相关工作的落地与优化', businessGoal: '支撑岗位核心目标达成', kpi: '相关指标达成' })
  }
  jd.qualifications = {
    skills: abilities.length ? abilities : tmpl.skills,
    experience: gates.length ? gates.join('；') : tmpl.experience,
    complexity: tmpl.complexity,
  }
  jd.meta.generatedBy = 'rule-engine'
  jd.meta.at = new Date().toISOString()
  jd.meta.basedOnBusiness = String(p.businessContext || '')
  return jd
}

/** JD 结构 → Markdown（供展示/导出/存储的统一渲染）*/
export function jdToMarkdown(jd) {
  const L = []
  L.push(`# ${jd.title || '岗位职责说明书'}${jd.dept ? '（' + jd.dept + '）' : ''}`)
  if (jd.city || jd.band) L.push(`\n**工作地点**：${jd.city || '待定'}　**薪资范围**：${jd.band || '面议'}`)
  L.push('\n## 1. 职务核心目的')
  L.push(jd.corePurpose || '（待补充）')
  L.push('\n## 2. 组织定位与协作网络')
  L.push(jd.orgPosition || '（待补充）')
  L.push('\n## 3. 核心职责与 KPI')
  ;(jd.responsibilities || []).forEach((r, i) => {
    L.push(`${i + 1}. **${r.action}**${r.content} —— *目的*：${r.businessGoal}；*KPI*：${r.kpi}`)
  })
  L.push('\n## 4. 任用门槛')
  const q = jd.qualifications || {}
  L.push(`- 技能：${(q.skills || []).join('、') || '（待补充）'}`)
  L.push(`- 经验：${q.experience || '（待补充）'}`)
  L.push(`- 复杂度级别：${q.complexity || '（待补充）'}`)
  if (jd.iterationDiff) {
    L.push('\n## 5. 迭代对照说明')
    L.push(jd.iterationDiff)
  }
  return L.join('\n')
}

/** 从 LLM 返回的 Markdown 尽力解析回结构（解析不全则保留原文进 raw）*/
export function parseJDMarkdown(md, base) {
  const jd = Object.assign(emptyJD(), base || {})
  jd.raw = md
  const text = String(md || '')
  // 按标题切段：支持 ## 一、 ## 1. ## 1 等
  const sectionOf = (kw, nextKws) => {
    const re = new RegExp('##[^\\n]*' + kw + '[^\\n]*\\n')
    const m = text.match(re)
    if (!m) return ''
    const s = text.indexOf(m[0]) + m[0].length
    let e = text.length
    for (const nk of nextKws) {
      const nr = new RegExp('##[^\\n]*' + nk + '[^\\n]*\\n')
      const mm = text.slice(s).match(nr)
      if (mm) { e = Math.min(e, s + text.slice(s).indexOf(mm[0])) }
    }
    return text.slice(s, e).trim()
  }
  const purpose = sectionOf('核心目的', ['组织定位', '协作网络'])
  const org = sectionOf('组织定位', ['核心职责', '职责与'])
  const respBlock = sectionOf('核心职责', ['任用门槛', '任职门槛', '门槛'])
  const qualBlock = sectionOf('任用门槛', ['迭代对照', '迭代', '版本'])
  const iterBlock = sectionOf('迭代对照', [])

  const stripBold = (x) => String(x || '').replace(/\*\*/g, '').trim()
  if (purpose) jd.corePurpose = stripBold(purpose.split(/\n---/)[0].trim())
  if (org) jd.orgPosition = org.replace(/\n---[\s\S]*$/, '').trim()

  // 职责：表格行一条=一条职责。严格过滤表头/分隔行；动词拆出；正文去加粗；上限 8 条
  const MAX_RESP = 8
  const resp = []
  const cleanCell = (x) => String(x || '').replace(/\*\*/g, '').replace(/^[\s|]+|[\s|]+$/g, '').trim()
  if (respBlock) {
    for (const line of respBlock.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('|')) continue
      const cells = t.split('|').map(c => c.trim())
      // 去掉首尾空 cell（markdown 表格两端有 |）
      if (cells[0] === '') cells.shift()
      if (cells[cells.length - 1] === '') cells.pop()
      if (cells.length < 2) continue
      const first = cleanCell(cells[0])
      const joined = cells.join(' ')
      // 过滤表头行与分隔行
      if (/^[-:\s]+$/.test(joined)) continue
      if (/核心职责|序号|^#$|产出物\s*\/\s*KPI|动词\s*\+/.test(joined) && /动词|产出物|核心职责/.test(joined)) continue
      // 第一列若是纯数字序号，取第 2 列为内容；否则首列就是内容
      let contentCell, outKpi
      if (/^\d+$/.test(first)) { contentCell = cells[1] || ''; outKpi = cells[2] || '' }
      else { contentCell = cells[0] || ''; outKpi = cells[1] || '' }
      contentCell = cleanCell(contentCell)
      outKpi = cleanCell(outKpi)
      if (!contentCell || contentCell.length < 4) continue
      // 不强拆动词，避免切碎名词。action 留空，content 为完整职责句（标准 JD 写法）
      let action = '', content = contentCell
      // 正文里若含"目的："则抽出
      let goal = ''
      const gm = content.match(/目的[：:]\s*([^；;\n]+)/)
      if (gm) { goal = gm[1].trim(); content = content.replace(/目的[：:][^；;\n]+/, '').trim() }
      resp.push({ action, content, businessGoal: goal, kpi: outKpi })
      if (resp.length >= MAX_RESP) break
    }
    // 无表格时退化为有序列表
    if (!resp.length) {
      for (const line of respBlock.split('\n')) {
        const m = line.match(/^\s*\d+[.、)]\s*(.+)/) || line.match(/^\s*[-*]\s+(.+)/)
        if (m) {
          const txt = cleanCell(m[1])
          resp.push({ action: '负责', content: txt.replace(/KPI[：:].*$/, '').trim(), businessGoal: '', kpi: (txt.match(/KPI[：:]\s*([^；;\n]+)/) || [])[1] || '' })
          if (resp.length >= MAX_RESP) break
        }
      }
    }
  }
  if (resp.length) jd.responsibilities = resp

  // 门槛：抓经验/技能/复杂度
  if (qualBlock) {
    const q = jd.qualifications
    const exp = qualBlock.match(/\**经验\**\s*[：:]\s*\**([^\n]+)/) || qualBlock.match(/(?:经验|工作年限)[：:]\s*\**([^\n]+)/)
    const complexity = qualBlock.match(/复杂度[^：:]*[：:]\s*\**([^\n]+)/)
    const skills = []
    for (const line of qualBlock.split('\n')) {
      const m = line.match(/^\s*[-*]\s+\**([^：:*]{2,12})\**\s*[：:]/)
      if (m && !/经验|学历|复杂度|能力素质/.test(m[1])) skills.push(m[1].trim())
    }
    if (exp) q.experience = stripBold(exp[1])
    if (complexity) q.complexity = stripBold(complexity[1])
    if (skills.length) q.skills = skills
  }
  if (iterBlock) jd.iterationDiff = iterBlock.trim()
  return jd
}
