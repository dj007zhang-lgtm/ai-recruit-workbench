/* JD / 招聘文案的合规与质量质检（纯规则，无 LLM）。
   借鉴开源 JD analyzer 的「偏见词检测 + 要求分类」思路，替换为中文招聘场景词表。
   输出只做提示，不阻断流程——判断仍是人的事。 */

const RISK_WORDS = [
  // [词, 类别, 等级, 建议]
  ['仅限男', '性别歧视', 'high', '性别限定涉嫌就业歧视，建议删除'],
  ['仅限女', '性别歧视', 'high', '性别限定涉嫌就业歧视，建议删除'],
  ['限男', '性别歧视', 'high', '性别限定涉嫌就业歧视，建议删除'],
  ['限女', '性别歧视', 'high', '性别限定涉嫌就业歧视，建议删除'],
  ['男性优先', '性别歧视', 'high', '「优先」同样构成歧视表述，建议删除'],
  ['女性优先', '性别歧视', 'high', '「优先」同样构成歧视表述，建议删除'],
  ['男士优先', '性别歧视', 'high', '性别倾向表述，建议删除'],
  ['女士优先', '性别歧视', 'high', '性别倾向表述，建议删除'],
  ['已婚已育', '婚育歧视', 'high', '婚育状况与岗位能力无关，涉嫌歧视'],
  ['已婚未育', '婚育歧视', 'high', '婚育状况与岗位能力无关，涉嫌歧视'],
  ['未婚', '婚育歧视', 'high', '婚育状况与岗位能力无关，涉嫌歧视'],
  ['是否怀孕', '婚育歧视', 'high', '涉及隐私与歧视，必须删除'],
  ['生育状况', '婚育歧视', 'high', '涉及隐私与歧视，必须删除'],
  ['35岁以下', '年龄歧视', 'high', '年龄上限涉嫌年龄歧视，建议改为能力要求'],
  ['30岁以下', '年龄歧视', 'high', '年龄上限涉嫌年龄歧视，建议改为能力要求'],
  ['28岁以下', '年龄歧视', 'high', '年龄上限涉嫌年龄歧视，建议改为能力要求'],
  ['年龄不超过', '年龄歧视', 'high', '年龄上限涉嫌年龄歧视'],
  ['年轻有活力', '年龄歧视', 'mid', '年龄暗示性表述，建议改为能力描述'],
  ['年轻化', '年龄歧视', 'mid', '年龄暗示性表述'],
  ['90后', '年龄歧视', 'mid', '代际标签，建议删除'],
  ['95后', '年龄歧视', 'mid', '代际标签，建议删除'],
  ['00后', '年龄歧视', 'mid', '代际标签，建议删除'],
  ['本地户口', '户籍歧视', 'high', '户籍限制涉嫌歧视，除特殊岗位需说明法律依据'],
  ['限本地', '户籍歧视', 'high', '地域/户籍限制涉嫌歧视'],
  ['不招外地', '户籍歧视', 'high', '地域限制涉嫌歧视'],
  ['形象气质佳', '外貌歧视', 'mid', '外貌要求与多数岗位能力无关，建议删除'],
  ['五官端正', '外貌歧视', 'mid', '外貌要求，建议删除'],
  ['身高', '外貌歧视', 'mid', '身高要求需有岗位相关性依据'],
  ['无纹身', '外貌歧视', 'mid', '外貌限制需谨慎'],
  ['不招少数民族', '民族歧视', 'high', '民族歧视，必须删除'],
  ['限汉族', '民族歧视', 'high', '民族歧视，必须删除'],
]

// 学历/院校限制：不是当然违法，但需有岗位相关性依据
const EDU_WORDS = ['985', '211', '双一流', '统招本科', '全日制本科', '统招全日制']

const MUST_HINT = /(必须|要求|至少|需具备|须具备|硬性|一定)/
const NICE_HINT = /(优先|加分|更好|更佳|熟悉者优先|有.*经验者优先)/
const DUTY_VERBS = ['主导', '负责', '参与', '统筹', '搭建', '落地', '推进', '设计', '维护']

/** 质检 JD / 招聘文案。text 可以是 JD 结构化文本或原文 */
export function checkPosting(text) {
  const t = String(text || '')
  const lower = t.toLowerCase()
  const risks = []
  for (const [w, cat, level, advice] of RISK_WORDS) {
    if (t.indexOf(w) >= 0) risks.push({ word: w, category: cat, level, advice })
  }
  const eduHits = EDU_WORDS.filter(w => t.indexOf(w) >= 0)
  if (eduHits.length) risks.push({ word: eduHits.join('/'), category: '学历/院校限制', level: 'low', advice: '学历或院校限制需能说明与岗位职责的相关性，否则易被认定为不合理限制' })

  // 要求分类（must / nice）
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean)
  const must = lines.filter(l => MUST_HINT.test(l))
  const nice = lines.filter(l => NICE_HINT.test(l))
  // 年限门槛
  const years = (t.match(/(\d+)\s*年以上/) || [])[1] || null
  // 职责动词分布
  const verbs = {}
  for (const v of DUTY_VERBS) { const n = (t.match(new RegExp(v, 'g')) || []).length; if (n) verbs[v] = n }
  const duties = lines.filter(l => /^[-*·\d]/.test(l) || DUTY_VERBS.some(v => l.indexOf(v) >= 0)).length
  // 薪资透明度
  const hasSalary = /(\d+\s*[kK]|[0-9]+\s*-\s*[0-9]+\s*[kK千万]|薪资面议|薪酬面议)/.test(t)

  const suggestions = []
  if (risks.some(r => r.level === 'high')) suggestions.push('存在高风险表述，建议先删除再发布（涉及就业歧视合规风险）')
  if (!must.length) suggestions.push('未能识别"硬性要求"，建议明确 must-have，减少无关投递')
  if (!hasSalary) suggestions.push('未写薪资范围：写明薪资区间的 JD 投递转化率明显更高')
  if (duties < 3) suggestions.push('职责条目偏少（' + duties + ' 条），建议按"动作 + 对象 + 产出"补充')
  if (!years) suggestions.push('未写明经验年限门槛，建议明确（或用能力要求替代年限）')
  if (Object.keys(verbs).length && !verbs['主导'] && !verbs['负责']) suggestions.push('职责描述缺少"负责/主导"等权责动词，建议明确责任边界')

  const highCount = risks.filter(r => r.level === 'high').length
  let score = 100 - highCount * 20 - risks.filter(r => r.level === 'mid').length * 8 - risks.filter(r => r.level === 'low').length * 3
  if (!hasSalary) score -= 5
  if (duties < 3) score -= 5
  score = Math.max(0, Math.min(100, score))

  return {
    score,
    risks,
    structure: { must: must.length, nice: nice.length, years: years ? Number(years) : null, verbs, duties, hasSalary },
    suggestions,
    summary: highCount ? '发现 ' + highCount + ' 处高风险合规表述' : (risks.length ? '有 ' + risks.length + ' 处待确认表述' : '未发现明显歧视性表述'),
  }
}
