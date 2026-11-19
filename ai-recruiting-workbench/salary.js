/* 薪酬基准数据（本年度薪酬报告，按岗位族 × 城市等级 的月薪分位值，单位 K）。
   数据来源：2026 年度薪酬调研报告（示例基准，可按企业实际采购的报告替换/扩充）。
   这是 AI 薪酬建议的「数据来源」——建议不是凭空编，而是基于分位值 + 城市/经验推算。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
// 结构化薪酬报告数据（由《任仕达2026市场展望与薪酬报告》抽取，岗位→一线/二线月薪区间）
let REPORT_DATA = null
export function loadReportData() {
  if (REPORT_DATA) return REPORT_DATA
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    REPORT_DATA = JSON.parse(readFileSync(join(here, 'salary-report.json'), 'utf8'))
  } catch (e) { REPORT_DATA = { positions: [] } }
  return REPORT_DATA
}
// 按岗位名在报告里模糊匹配（取标题包含关系最长者）
// 中文岗位名匹配：bigram 相似度（子串包含太严格，如「Java开发工程师」vs「应用开发Java工程师」互不包含）
function normPos(x) {
  return String(x || '').toLowerCase().replace(/[\s·\-—（）()、，,.，\/]/g, '')
}
// 通用后缀/修饰词（不区分岗位）：去掉后取「专有词」，避免「Java开发工程师」误配「产品开发工程师」
const GENERIC_WORDS = /工程师|开发|经理|总监|专员|主管|助理|技术|资深|高级|中级|初级|岗位|职位|负责|师|岗/g
function coreWord(x) {
  return normPos(x).replace(GENERIC_WORDS, '')
}
function matchIn(list, t) {
  const tc = coreWord(t)
  let best = null, score = 0
  for (const p of list || []) {
    const pt = String(p.title || '')
    const pc = coreWord(pt)
    let sc = 0
    if (normPos(pt) === normPos(t)) sc = 1000
    // 只接受「专有词完全相同」的匹配（忽略工程师/经理/资深等通用后缀）：
    // 包含关系在中文岗位名里歧义太大（前端≠数字前端、电商运营≠电商总监、U3D客户端≠客户经理），
    // 错配比不匹配更糟——不匹配会走 AI 市场估算。
    else if (tc && pc && tc === pc) sc = 500
    if (sc > score) { score = sc; best = p }
  }
  return { best, score }
}
export function matchReportPosition(title) {
  const data = loadReportData()
  const t = String(title || '').trim()
  if (!t) return null
  // 先查任仕达（月薪，一线/二线）
  const a = matchIn(data.positions, t)
  if (a.best && a.score >= 75) return { kind: 'rands', pos: a.best, score: a.score }
  // 再查白皮书（年薪折算月薪）
  const b = matchIn(data.report2, t)
  if (b.best && b.score >= 75) return { kind: 'baipishu', pos: b.best, score: b.score }
  return null
}

export const SALARY_REPORT_VERSION = '任仕达 2026 市场展望与薪酬报告'
export const SALARY_REPORT_UPDATED = '2026-01'

// 城市等级系数（一线/新一线/二线/其他）
export const CITY_TIER = {
  '一线': 1.0, '新一线': 0.9, '二线': 0.8, '其他': 0.7,
}

const CITY_TIER_MAP = {
  '一线': ['北京', '上海', '深圳', '广州'],
  '新一线': ['杭州', '成都', '武汉', '南京', '西安', '苏州', '重庆', '长沙', '郑州', '天津', '东莞', '宁波', '青岛', '合肥', '佛山'],
  '二线': ['厦门', '福州', '济南', '沈阳', '无锡', '昆明', '大连', '哈尔滨', '长春', '南昌', '贵阳', '南宁', '常州', '温州', '嘉兴', '石家庄', '太原'],
}

export function cityTier(city) {
  const c = String(city || '').trim()
  for (const tier of ['一线', '新一线', '二线']) {
    if (CITY_TIER_MAP[tier].some(x => c.indexOf(x) >= 0 || x.indexOf(c) >= 0 && c)) return tier
  }
  return '其他'
}

// 经验系数：以 3-5 年为 1.0 基准
function expFactor(expYears) {
  const y = Number(expYears) || 0
  if (!y) return 1.0
  if (y < 1) return 0.75
  if (y < 3) return 0.9
  if (y <= 5) return 1.0
  if (y <= 8) return 1.15
  return 1.3
}

/**
 * 生成薪酬分位值 + AI 建议区间。
 * @param {object} p { title, dept, city, abilities, expYears, bandMin, bandMax }
 */
function numK(x) { if (x == null) return 0; const m = String(x).match(/[\d.]+/); return m ? Number(m[0]) : 0 }

export function salaryBenchmark(p) {
  // 第一优先：查结构化薪酬报告（真实数据，按岗位名匹配）
  const hit = matchReportPosition(p.title)
  if (hit) {
    const tier = cityTier(p.city)
    const ef = expFactor(p.expYears)
    const round = (x) => Math.round(x / 100) / 10
    let P25, P50, P75, srcName, detail
    if (hit.kind === 'rands') {
      const rp = hit.pos
      const band = (tier === '一线') ? rp.tier1 : rp.tier2
      P25 = round(band[0] * ef); P50 = round((band[0] + band[1]) / 2 * ef); P75 = round(band[1] * ef)
      srcName = '任仕达 2026 薪酬报告'
      detail = rp.title + '：月薪 ' + rp.tier1[0] + '-' + rp.tier1[1] + '（一线）/ ' + rp.tier2[0] + '-' + rp.tier2[1] + '（二线）元'
    } else {
      const rp = hit.pos  // 白皮书 monthly=[P10,P50,P90]
      P25 = round(rp.monthly[0] * ef); P50 = round(rp.monthly[1] * ef); P75 = round(rp.monthly[2] * ef)
      srcName = '2026行业薪酬与人才洞察白皮书'
      detail = rp.title + '（' + (rp.industry || '') + '）：年固定 ' + rp.annual[0] + '/' + rp.annual[1] + '/' + rp.annual[2] + ' 元（P10/P50/P90），折月薪'
    }
    const bmin = numK(p.bandMin), bmax = numK(p.bandMax)
    let positioning = ''
    if (bmin || bmax) {
      if (bmax && bmax < P25) positioning = '你填的薪资上限低于报告 P25，可能招不到人'
      else if (bmin && bmin > P75) positioning = '你填的薪资下限高于报告 P75，成本偏高'
      else if (bmin >= P25 && bmax <= P75) positioning = '你的薪资区间落在报告 P25–P75 内，合理'
      else positioning = '你的薪资区间与报告有偏差，参考调整'
    }
    return {
      report: srcName, role: hit.pos.title, cityTier: tier, expFactor: ef,
      P25, P50, P75, suggest: { min: P25, mid: P50, max: P75 },
      positioning: positioning || ('报告区间 P25–P75：' + P25 + '–' + P75 + 'K（' + tier + '城市，经验系数 ' + ef + '）'),
      reason: srcName + ' · ' + detail + '，经验系数 ' + ef + ' 折算。',
      source: srcName + '（真实报告数据）', matched: true,
    }
  }
  // 报告匹配不到：不再用粗粒度岗位族表硬估（那会给出误导性数字），交由调用方用 LLM 估算
  return {
    report: SALARY_REPORT_VERSION, reportUpdated: SALARY_REPORT_UPDATED,
    role: null, cityTier: cityTier(p.city), expFactor: expFactor(p.expYears), cityFactor: CITY_TIER[cityTier(p.city)],
    P25: null, P50: null, P75: null, suggest: null,
    positioning: '该岗位未在本地薪酬报告中找到对应基准，已改用 AI 市场估算',
    reason: '未在报告中匹配到该岗位，不使用粗粒度推测数据。',
    source: '本地薪酬报告基准（' + SALARY_REPORT_VERSION + '）', noData: true,
  }
}

/**
 * 建议准确性自校准：对比「历史建议分位值」与「实招薪资」，偏差超阈值则修正。
 * @param {Array} history [{ P50, actualMedian, ... }]
 * @returns {{ bias: number|null, sample: number, correction: object|null }}
 */
export function calibration(history) {
  const rows = (history || []).filter(h => h && h.P50 != null && h.actualMedian != null)
  if (!rows.length) return { bias: null, sample: 0, correction: null }
  // 实招 vs 建议的相对偏差（正=实招更高=建议偏低）
  const ratios = rows.map(h => (h.actualMedian - h.P50) / Math.max(1, h.P50))
  const bias = ratios.reduce((a, b) => a + b, 0) / ratios.length
  const correction = Math.abs(bias) >= 0.08 && rows.length >= 2
    ? { factor: Math.round((1 + bias) * 100) / 100, note: bias > 0 ? '实招普遍高于建议，已上调' : '实招普遍低于建议，已下调' }
    : null
  return { bias: Math.round(bias * 1000) / 10, sample: rows.length, correction }
}

/**
 * 三源薪资证据加权建议：
 *  evidence = { currentSalaries:[候选人现薪K], actualOffers:{median,count}, report:{P25,P50,P75}, estimate:{P25,P50,P75} }
 *  权重：候选人现薪 0.45（你要招到至少得出这个数）> 本岗位实招 0.35 > 报告/估算 0.20
 * 返回 {P25,P50,P75,basis:[...],confidence}
 */
export function blendSalaryEvidence(ev) {
  // 口径严格分离：
  //  同一岗位的「实招成交价」— 最准（我们为这个岗位真实付出的钱），可作锚点
  //  同一岗位「已面候选人的现薪」— 只是『他们目前值多少』的参考，不能与实招同权平均
  //  报告/估算 — 市场基线
  // 正确做法：实招足够时以实招为准；否则用「现薪区间 × 溢价」或市场基线；三者不混算。
  const out = { basis: [], confidence: 'low', samePosition: !!ev.samePosition }
  const off = ev.actualOffers
  const cur = (ev.currentSalaries || []).filter(x => typeof x === 'number' && x > 0).sort((a, b) => a - b)
  const rep = ev.report || ev.estimate
  const med = (arr) => arr.length % 2 ? arr[(arr.length - 1) / 2] : Math.round((arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2 * 10) / 10

  // ① 有本岗位实招：直接采信实招（唯一同口径成交数据），现薪只作旁证
  if (off && off.count >= 1 && off.median != null) {
    const P25 = off.min, P50 = off.median, P75 = off.max
    out.P25 = P25; out.P50 = P50; out.P75 = P75
    out.suggest = { min: P25, mid: P50, max: P75 }
    out.basis.push('本岗位实招 ' + off.count + ' 次成交（' + off.min + '–' + off.max + 'K，中位 ' + off.median + 'K）')
    if (cur.length) out.basis.push('旁证：' + cur.length + ' 名候选人现薪中位 ' + med(cur) + 'K')
    if (rep && rep.P50 != null) out.basis.push('旁证：市场基线 P50 ' + rep.P50 + 'K')
    out.confidence = off.count >= 2 ? 'high' : 'mid'
    out.anchor = 'actual'
    return out
  }
  // ② 无实招，但有一批同岗位候选人的现薪：这是「招到人要给多少」的合理代理
  if (cur.length >= 2) {
    const m = med(cur)
    // 换工作通常需 10%~20% 涨幅才能打动；区间 = 现薪中位 ~ 中位上浮 20%
    const P25 = Math.round(m * 10) / 10, P50 = Math.round(m * 1.1 * 10) / 10, P75 = Math.round(m * 1.2 * 10) / 10
    out.P25 = P25; out.P50 = P50; out.P75 = P75
    out.suggest = { min: P25, mid: P50, max: P75 }
    out.basis.push('同岗位候选人现薪 ' + cur.length + ' 人中位 ' + m + 'K（按换岗 10–20% 涨幅推算）')
    if (rep && rep.P50 != null) out.basis.push('对照：市场基线 P50 ' + rep.P50 + 'K')
    out.confidence = cur.length >= 3 ? 'mid' : 'low'
    out.anchor = 'current'
    return out
  }
  // ③ 只有 1 个现薪 / 只有市场基线：以基线为主，现薪仅提示
  if (rep && rep.P50 != null) {
    out.P25 = rep.P25; out.P50 = rep.P50; out.P75 = rep.P75
    out.suggest = { min: rep.P25, mid: rep.P50, max: rep.P75 }
    out.basis.push((ev.report ? '薪酬报告' : 'AI 市场估算') + '（P50 ' + rep.P50 + 'K）')
    if (cur.length === 1) out.basis.push('参考：1 名候选人现薪 ' + cur[0] + 'K')
    out.confidence = 'low'
    out.anchor = 'market'
    return out
  }
  return null
}
