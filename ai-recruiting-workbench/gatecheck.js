import { structureResume } from './deepscore.js'
/* 硬门槛 AI 分析：让模型读简历原文，对每条硬门槛给出「是否满足 + 人话依据 + 置信」。
   这不是关键词匹配——模型要理解简历里的事实（学历/专业/年限/技术栈/资质），
   判断候选人是否真的满足门槛，并说明"看到了什么 → 所以判定什么"。
   证据不足时明确标 pending 请人核实，绝不编造。 */

export function buildGatePrompt(position, resume) {
  const gates = (position && position.gates) || []
  const sc = position && position.scorecard
  const hardGates = (sc && Array.isArray(sc.hardGates) && sc.hardGates.length)
    ? sc.hardGates.map(g => (typeof g === 'string' ? g : g.item)).filter(Boolean)
    : gates
  const list = (hardGates.length ? hardGates : ['（无明确硬门槛）']).map((g, i) => (i + 1) + '. ' + g).join('\n')
  return [
    '# Role',
    '你是资深招聘官，正在核对候选人是否满足岗位的「硬性门槛」。你要读简历原文，做出真实判断，而不是找关键词。',
    '',
    '# 岗位',
    '名称：' + ((position && position.title) || '未命名'),
    '硬门槛（逐条核对）：',
    list,
    '',
    '# 第一步：先分类，再判定（最容易出错的地方）',
    '岗位门槛列表里常混着两类东西，处理方式完全不同：',
    '- 【硬门槛】表述含「必须/要求/需具备/XX及以上/限」，或明确年限「3年以上」→ 不满足则淘汰。',
    '- 【优先条件】表述含「优先/加分/最好/更佳/者优先」→ 不满足**不影响通过**，只作同等条件下参考。',
    '  · 例：「硕士优先」「有大厂经验优先」「英语六级优先」都是优先条件，本科/无大厂/无六级**不能判 fail**。',
    '- 【软性要求】表述含「熟悉/了解/掌握/具备…能力」→ 属于 BARS 判档范畴，**不作为门槛判定**。',
    '- 【岗位职责】表述含「负责/参与/推动」→ 这是对岗位工作的描述，不是对候选人的要求，跳过。',
    '输出时为每条标注 type："hard" | "preferred" | "soft" | "duty"。',
    '**只有 type=hard 且 verdict=fail 才算不通过。** type=preferred 的项即使不满足，verdict 也应标 pass（附说明）。',
    '',
    '# 判断原则（重要）',
    '- 读懂简历的实际含义：例如「2018-2022 就读于XX大学软件工程」= 全日制本科计算机相关专业；「专升本/自考/函授/成人教育」≠ 统招全日制。',
    '- 【英文简历等价识别】海外/外企简历用英文表述，需等价理解，不得因语言不同判「缺证据」：',
    '  · 学历：Bachelor / B.S. / BSc / BS = 本科；Master / M.S. / MSc = 硕士；Ph.D. / PhD / Doctorate = 博士；Associate degree = 专科；',
    '  · 学制：4-year program / four-year undergraduate = 四年制本科；B.Eng / B.Tech = 工学学士；',
    '  · 专业：Computer Science / CS / Software Engineering / Information Technology / Electrical Engineering and Computer Science = 计算机相关专业；',
    '  · 统招等价：Full-time / On-campus / Regular program = 全日制；Part-time / Online / Distance learning / Open University = 非全日制（相当于函授/成人教育）；',
    '  · 学校层次：QS/THE/US News 排名前列的海外高校，或国内 985/211/双一流，按「名校」理解；',
    '  · 毕业时间：海外本科/硕士常见 5 月、6 月、12 月毕业，与中国 6-7 月/3-4 月不同，不得因毕业月份异常判疑点。',
    '- 若简历中英文混排，按语义取并集判断，不因某一语言版本缺失就判不满足。',
    '- 不要因为"没写某些字"就判不通过；要看简历里的事实能否推出结论。',
    '- 证据确实不足以判断时，标 pending，并说明缺什么信息，不要猜。',
    '',
    '# 关键区分：缺证据 vs 证据矛盾（务必分清，这是最容易判错的地方）',
    '- 【缺证据 pending】：简历确实没提这件事，看不出会不会。例：完全没写学历。→ 留人核实。',
    '- 【证据矛盾 fail】：简历写了相反的事实，等于反证。例：技能栏自述「熟练掌握 Java 后端」，',
    '  但项目/工作经历里所有后端实现都是 Python+Flask，没有一处 Spring/Java 后端项目证据。',
    '  这不是"信息不足"，而是"自述与事实矛盾"——对技术栈门槛，**项目经历是硬证据，技能自述是软证据**，',
    '  软硬冲突时以项目经历为准，判 fail。',
    '- 对「核心技术栈」类门槛尤其如此：判断依据必须是项目/工作经历里的实际技术使用，',
    '  而不是技能列表的自述。技能栏可以随便写，项目经历编不了。',
    '- 只有当简历**完全没有**项目/工作经历可判断时，技术栈门槛才标 pending。',
    '',
    '- verdict：pass=明确满足 / fail=明确不满足或证据矛盾 / pending=信息不足需核实。',
    '',
    '# 候选人简历原文',
    structureResume(resume, 8000),
    '',
    '# 输出（严格 JSON，对每条门槛都要有，顺序与上面一致）',
    '{',
    '  "gates": [',
    '    { "gate": "门槛原文", "type": "hard|preferred|soft|duty", "verdict": "pass|fail|pending", "reason": "人话说明：从简历看到什么（引用事实），所以是否满足", "evidence": "引用的简历原文片段（无则空字符串）" }',
    '  ],',
    '  "summary": "一句话总评：候选人整体是否过门槛、关键短板/亮点"',
    '}',
    '只输出 JSON，不要额外文字。',
  ].join('\n')
}

/** 解析模型返回的门槛分析 */
export function parseGateResult(text) {
  const t = String(text || '')
  const m = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/\{[\s\S]*\}/)
  let raw = m ? (m[1] || m[0]) : t
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}')
  if (i >= 0 && j > i) raw = raw.slice(i, j + 1)
  try {
    const o = JSON.parse(raw)
    if (!o || !Array.isArray(o.gates)) return null
    // 规范化 verdict
    for (const g of o.gates) {
      const v = String(g.verdict || '').toLowerCase()
      g.verdict = (v === 'pass' || v === 'fail' || v === 'pending') ? v : 'pending'
      // 门槛类型：只有 hard 才可能触发淘汰；缺省按 hard 处理（保守，但由下面的一致性校验兜底）
      const ty = String(g.type || '').toLowerCase()
      g.type = (ty === 'hard' || ty === 'preferred' || ty === 'soft' || ty === 'duty') ? ty : 'hard'
      // 一致性兜底：表述含「优先/加分/最好/更佳」的项，即使模型判了 fail，也降级为 pass（优先条件不淘汰人）
      if (g.type === 'hard' && /优先|加分|最好|更佳|更优/.test(String(g.gate || ''))) {
        g.type = 'preferred'
        if (g.verdict === 'fail') { g.verdict = 'pass'; g.reason = '（优先条件，不满足不影响通过）' + (g.reason || '') }
      }
      // 非 hard 类型不允许 fail
      if (g.type !== 'hard' && g.verdict === 'fail') { g.verdict = 'pass'; g.reason = '（' + g.type + '，不计入淘汰）' + (g.reason || '') }
      g.reason = String(g.reason || '').slice(0, 300)
      g.evidence = String(g.evidence || '').slice(0, 300)
    }
    return o
  } catch (e) { return null }
}
