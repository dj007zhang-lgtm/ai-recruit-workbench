/* 技能抽取与岗位技能缺口（ESCO 分类思路：L语言/K知识/S技能/C证书）。
   LLM 不参与本模块：纯确定性词典匹配，输出可复现、可审计——用于证据增强与缺口展示，
   不替代 BARS 判档（判断仍由 Agent 读原文做出）。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

let CACHE = null
export function loadSkills() {
  if (CACHE) return CACHE
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    CACHE = JSON.parse(readFileSync(join(here, 'vendor', 'skills.json'), 'utf8'))
  } catch (e) { CACHE = { skills: [] } }
  return CACHE
}

/**
 * 从文本抽取技能。长别名优先并占用区间，避免「react」误吞「react native」。
 * 返回 [{ name, cat, group, hits }]，按 hits 降序。
 */
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g
/** 在文本中找 alias 的所有匹配位置。
 *  纯 ASCII alias 必须词边界（避免 od 命中 Xcode、java 命中 javascript）；
 *  含中文的 alias 直接子串匹配（中文无词边界）。 */
function aliasPositions(text, alias) {
  const isAscii = /^[\x00-\x7f]+$/.test(alias)
  const out = []
  if (isAscii) {
    const esc = alias.replace(RE_SPECIAL, '\\$&')
    let re
    try { re = new RegExp('(?<![a-z0-9])' + esc + '(?![a-z0-9])', 'g') } catch (e) { return out }
    let m
    while ((m = re.exec(text)) !== null) { out.push(m.index); if (m.index === re.lastIndex) re.lastIndex++ }
    return out
  }
  let from = 0
  for (;;) {
    const i = text.indexOf(alias, from)
    if (i < 0) break
    out.push(i)
    from = i + alias.length
  }
  return out
}

export function extractSkills(text) {
  const t = String(text || '').toLowerCase()
  if (!t) return []
  const all = loadSkills().skills || []
  const items = []
  for (const s of all) {
    for (const a of (s.alias || [])) {
      const al = String(a).toLowerCase().trim()
      if (al.length < 2) continue
      items.push({ skill: s, alias: al, len: al.length })
    }
  }
  items.sort((x, y) => y.len - x.len)
  const taken = new Array(t.length).fill(false)
  const hitMap = {}
  for (const it of items) {
    for (const idx of aliasPositions(t, it.alias)) {
      let free = true
      for (let i = idx; i < idx + it.len; i++) if (taken[i]) { free = false; break }
      if (free) {
        for (let i = idx; i < idx + it.len; i++) taken[i] = true
        const key = it.skill.name
        hitMap[key] = hitMap[key] || { name: it.skill.name, cat: it.skill.cat, group: it.skill.group, hits: 0 }
        hitMap[key].hits += 1
      }
    }
  }
  return Object.values(hitMap).sort((a, b) => b.hits - a.hits)
}

/** 岗位技能需求：从 title/abilities/gates/JD/评分卡维度名 抽取 */
export function jobSkillDemand(position) {
  if (!position) return []
  const parts = [position.title || '', ...(position.abilities || []), ...(position.gates || []), position.jd || '']
  const dims = (position.scorecard && position.scorecard.softDims) || []
  for (const d of dims) parts.push(d.name || '')
  return extractSkills(parts.join('\n'))
}

/** 技能缺口：候选人技能 vs 岗位需求 → { matched, missing, rate } */
export function skillGap(candSkills, demand) {
  const have = new Set((candSkills || []).map(x => x.name))
  const matched = [], missing = []
  for (const d of (demand || [])) (have.has(d.name) ? matched : missing).push(d)
  const rate = demand && demand.length ? Math.round(matched.length / demand.length * 100) : null
  return { matched, missing, rate }
}

/** 岗位主技术栈组（从技能库需求推导，按命中数排序） */
export function techStackGroups(position) {
  const demand = jobSkillDemand(position).filter(x => x.group && x.group.indexOf('技术栈') === 0)
  const cnt = {}
  for (const d of demand) cnt[d.group] = (cnt[d.group] || 0) + 1
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map(g => ({ group: g, count: cnt[g] }))
}

/**
 * 技术栈对口判定（技能库驱动，唯一口径）：
 * 返回 { fit: 'match'|'mismatch'|'unknown', jobStack, jobStacks, candStacks, stackRate, reason }
 * 语义：岗位有明确主栈、简历几乎不含该栈技能却明显命中其他栈 → mismatch（硬否决）
 */
export function stackFit(position, resume) {
  const groups = techStackGroups(position)
  if (!groups.length) return { fit: 'unknown', jobStacks: [], candStacks: [], stackRate: null, reason: '岗位未体现明确技术栈，跳过栈匹配' }
  const primary = groups[0].group
  const demand = jobSkillDemand(position).filter(x => x.group === primary)
  const cand = extractSkills(resume)
  const inPrimary = cand.filter(x => x.group === primary)
  const candGroups = {}
  for (const x of cand) if (x.group && x.group.indexOf('技术栈') === 0) candGroups[x.group] = (candGroups[x.group] || 0) + 1
  const others = Object.keys(candGroups).filter(g => g !== primary)
  const jobNames = demand.slice(0, 4).map(x => x.name).join('/')
  if (!inPrimary.length && others.length) {
    return { fit: 'mismatch', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: others, stackRate: 0,
      reason: '岗位要求以「' + primary + '」技术栈为主（' + jobNames + '），但简历几乎不含相关技能，反而集中在「' + others.join('/') + '」——技术方向不对口' }
  }
  if (!inPrimary.length) {
    return { fit: 'unknown', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: 0,
      reason: '简历未明确体现岗位主栈「' + primary + '」相关技能（' + jobNames + '）' }
  }
  const rate = Math.min(100, Math.round(inPrimary.length / Math.max(1, demand.length) * 100))
  return { fit: 'match', jobStack: primary, jobStacks: groups.map(g => g.group), candStacks: [], stackRate: rate,
    reason: '简历命中岗位主栈「' + primary + '」' + inPrimary.length + ' 项（栈覆盖 ' + rate + '%）' }
}
