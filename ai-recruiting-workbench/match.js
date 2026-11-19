/* 岗位自动匹配：一份简历 → 在招岗位中哪个最合适（先匹配岗位，再按该岗位评分卡筛选）。
   纯确定性、可解释：简历技能 vs 各岗位需求技能的重合度 + 关键词命中。
   命中不足阈值则返回低置信，交由人分配（不硬塞）。 */
import { extractSkills, jobSkillDemand, skillGap } from './skills.js'

function normText(x) { return String(x || '').toLowerCase() }

/**
 * @param {object} cand { resume, appliedPid? }
 * @param {Array} positions 在招岗位列表（含 title/dept/gates/abilities/jd）
 * @returns {{ best, ranked:[{positionId,title,score,reasons,gateFail}], confident:boolean }}
 */
export function matchPositions(cand, positions) {
  const resume = cand.resume || ''
  const candSkills = extractSkills(resume)
  const candSkillNames = candSkills.map(x => x.name)
  const hay = normText(resume)
  const ranked = []
  for (const p of (positions || [])) {
    if ((p.status || '在招') !== '在招') continue
    const demand = jobSkillDemand(p)               // 该岗位需求的技能
    const gap = skillGap(candSkills, demand)
    const reasons = []
    let score = 0
    // ① 技能重合：岗位需求里有多少被简历命中
    if (demand.length) {
      const rate = gap.rate != null ? gap.rate : 0
      score += rate * 0.7                          // 最多 70 分
      if (gap.matched.length) reasons.push('技能命中 ' + gap.matched.length + '/' + demand.length + '（' + gap.matched.slice(0, 4).map(x => x.name).join('/') + '）')
      if (gap.missing.length) reasons.push('缺 ' + gap.missing.slice(0, 3).map(x => x.name).join('/'))
    }
    // ② 岗位名称/能力关键词在简历中出现
    const kws = [p.title, ...(p.abilities || [])].filter(Boolean)
    const hit = kws.filter(k => k && hay.indexOf(normText(k)) >= 0)
    if (hit.length) { score += Math.min(20, hit.length * 6); reasons.push('关键词命中：' + hit.slice(0, 3).join('、')) }
    // 学历等硬门槛由初筛阶段判定，不在「选哪个岗位」阶段否决（避免误杀）
    ranked.push({ positionId: p.id, title: p.title, score: Math.round(score * 10) / 10, reasons, skillRate: gap.rate })
  }
  ranked.sort((a, b) => b.score - a.score)
  const best = ranked[0] || null
  // 置信：最高分 ≥25 且明显高于第二（差 ≥8）→ 可信自动分配
  const second = ranked[1] ? ranked[1].score : -999
  // 置信：最优岗位有实际技能命中(rate>0) 且分数≥15 且领先第二名≥5 → 自动分配；否则留人
  const confident = !!best && best.score >= 15 && (best.skillRate || 0) > 0 && (best.score - second) >= 5
  return { best, ranked, confident }
}
