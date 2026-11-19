# AI 招聘工作台 · 插件能力

设计权威见 [WORKSPACE-DESIGN.md](../../WORKSPACE-DESIGN.md)。本页只描述**已实现并验证**的能力。

## 界面交互（ATS 习惯 + AI 自动化 + 可纠偏）

- **ATS 骨架**：顶部阶段漏斗可点击筛选；左栏候选人列表（姓名/阶段/置信度）；右栏详情（AI 建议、逐维证据可展开、简历原文、影响面、判断动作、时间线）。
- **AI 一键初筛**：顶部「⚡ AI 一键初筛」对全部待评估候选人批量跑 `auto_assess`——读脱敏原文，逐维抽简历原句作证据，证据强度+量化决定分数（58–90 有区分度），抽不到证据判「未判定」，给出建议与置信度；全程在界面上出结果，不依赖另开会话。
- **可纠偏成长**：每个候选人可「改判（校准）」，必选原因码+维度，写入校准池；聚类达阈值生成规范变更建议。采纳/补一句/淘汰/Offer 都写事件。
- **本地简历入口**：顶部「＋ 接入简历」，选来源/岗位，多选文件，自动上传→留档→解析→脱敏→去重→进列表。
- 姓名从文件名清洗（「张涛U3D简历.pdf」→「张涛」）；未关联岗位不显示 undefined。

## 数据如何沉淀（首要前提）

不是状态表，是**事件溯源**。`events.jsonl` 是唯一事实来源，append-only；`candidates.jsonl` / `positions.json` / `calibration.jsonl` / `projections/state.json` 全部由 `fold(events)` 派生，**永不被直接写**。`events.log` 是同一事件的人类可读镜像，供看板与审计阅读。

一条事件包含：`seq / ts / actor(human|agent|system) / actorId / type / subject / payload / evidence[] / basedOn{l0,l1,rule,model,prompt} / inputHash / causedBy / correlationId`。

- **状态是派生的**：手工改状态文件不影响 `fold()` 的结果（已验证）。
- **流程是因果链**：每条事件有 `causedBy`，可区分机自动推进与人决策推进。
- **结论可追溯**：任意结论能追到产生它的事件、依据、证据、规范版本（已验证）。
- `migrateLegacy()` 把旧格式数据一次性转成初始事件（幂等）。

## 人的操作路径 / 机的规范（契约在工具层强制，不是文档口号）

`HUMAN_CONTRACT` 与 `MACHINE_CONTRACT` 是代码常量，工具执行时校验：

| 契约 | 强制点 |
|---|---|
| 人永不直接编辑状态 | 所有写工具只 `appendEvent`，状态由 fold 派生 |
| 淘汰 / Offer 只能由人 | `recruit_decide` 是唯一入口；且必须留理由 |
| 改判必选原因码、纠偏必带维度 | `recruit_calibrate` 校验五选一原因码 |
| 机的产出必带证据 / 置信度 / 规范版本 / 输入哈希 | `recruit_record_assessment` 强制校验 |
| 每维无证据判未判定 | `recruit_record_assessment` 强制 |
| 禁止自动淘汰路由 | `recruit_record_assessment` 拒绝含「淘汰」的 route |
| 低置信停下转人 | 收件箱派生规则 |

判断仍由 Agent 读简历原文做出，工具只做机械性工作。`recruit_evaluation_packet` 返回原文、评分卡、闸门、禁问、历史纠偏与**回放链**；`recruit_replay` 重建完整因果链与当时的规范版本。

## 校准 = 规范的新版本，不是改分

`recruit_calibrate` 写 `correction.made`；按 `维度 × 原因码` 聚类，达 3 次自动追加 `standard.proposed`（变更建议，不直接生效）。`recruit_standards` 暴露版本链、建议、验证记录与聚类状态。后续应接回归重放（在历史事件集上验证新规范是否变准且不引入误杀）→ `standard.validated` → `standard.released`，旧版本永不删除。

## 三个目标（观察层 / 操作层 / 能力层）

- **① 实时数据看板 + 环比**：`recruit_dashboard` + `GET /api/ai-recruiting/board`，8 项 KPI 全带环比、漏斗与渠道环比、20s 自动刷新。主面板与会话首屏精简条。看板是**只读观察层**。
- **② 流程节点化 + 自动化**：六节点（接入/评估/面试/决策/Offer/入职），每节点显示人数、自动推进次数、挂载的 AI 能力。
- **③ AI 能力提效提质**：能力调用表 + 免人工率、判断可追溯率、未判定维数、节省工时。
- **人的唯一操作入口是收件箱**：主面板左侧按风险排序、一次一件事；右侧可点证据原文、看影响面，做「采纳 / 补一句 / 改判 / 淘汰 / Offer」五类动作；动作经 `POST /api/ai-recruiting/action` 写入事件账本，状态派生、收件箱自动减一、时间线加一条；支持 ↑↓ 切换、Enter 采纳、一键回滚。

## 工具（13 个 `recruit_*`）

`recruit_dashboard` `recruit_overview` `recruit_report` `recruit_positions` `recruit_add_position` `recruit_intake` `recruit_evaluation_packet` `recruit_record_assessment` `recruit_inbox` `recruit_decide` `recruit_calibrate` `recruit_replay` `recruit_standards`

## 验证

- 4 个 JS 模块语法通过；零外部依赖。
- 26 项测试通过：迁移幂等、事件只追加、敏感字段不进账本、投影派生、去重留痕、人机契约强制、causedBy、回放、规范版本建议、看板与路由、改状态文件不影响 fold。
- `client.js` 在 `sidebar.panellist`（右侧插件栏 / Global panel icons）注册图标，`id=ai-recruiting` 与 `main` 的 `key` 一致；侧栏按钮由 owner 渲染，`label` 取注册元数据。对照 `@local/content-writer-workbench`、`@local/char-writer-studio` 的写法验证一致。`dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-sidebar` 保证激活顺序。
- **未验证**：主面板/精简条/侧栏图标的实际渲染外观与详情页（无浏览器控制；带参 `Slots.listSubTree` 在本 harness 上被工具侧拒绝，catalog 不含 occupants）。安装与 slot 注册不等于用户所见，需在 GUI 右侧插件栏确认。
- **需重启彻底清理旧 Host 模块 generation**：升级时可能遇到 `duplicate exact route`，已用换路径 + `ctx.effect` 清理缓解。

## 交互动作（界面动作 == 一次工具调用）

`actions.js` 的 `performAction()` 是唯一实现，`recruit_decide` / `recruit_calibrate` 工具与 HTTP 动作端点都调它。动作：`adopt` / `ask` / `override` / `eliminate` / `offer` / `rollback` / `decide` / `calibrate`。契约在服务端强制：淘汰与 Offer 必留理由、改判必选原因码、补一句必填、AI 不自动淘汰。回滚用追加补偿事件（append-only 不删事件）。

观察层端点 `GET /api/ai-recruiting/workbench`（一次拉看板+收件箱+详情+因果链+契约），动作端点 `POST /api/ai-recruiting/action`。

## 职位岗位 · AI 生成结构化 JD（人机协作 + 迭代闭环）

「职位岗位」页 = 职位列表 + 新建职位。新建可填业务背景/变更点，点「⚡ AI 生成岗位 JD」：
- **真调 LLM**：Host `ctx.llm.stream`（provider magpie / model workbuddy/deepseek-v4.1-flash），按 OD 专家提示词产出：核心目的 / 组织定位与协作网络 / 6-8 条核心职责（动词+内容+目的+KPI）/ 任用门槛（技能·经验·复杂度）/ 迭代对照。LLM 不可用自动降级本地规则引擎。
- **结构化**：返回 jd 对象（corePurpose/orgPosition/responsibilities[{action,content,businessGoal,kpi}]/qualifications/iterationDiff），界面按结构渲染，保留 Markdown 原文可「看/改原文」。
- **可迭代**：填变更点再生成，产出带「V1→V2 迭代对照」的新版本；jdObj 随 position.created 存事件账本，旧版以事件留档可追溯。
- **人机协作**：AI 草稿 → 人改 → 保存，不是一次性文本。

端点 `POST /api/ai-recruiting/generate-jd`。验证：运行实例真调模型返回 source=llm、8-9 条带 KPI 职责、迭代对照。

## 评分卡（由 JD 派生，双轨制）

正确链路：**JD（岗位要求，根）→ 评分卡（派生）→ 初筛打分**。不再是手填路径。
- 「职位岗位」新建页：先填岗位信息 → 生成 JD → 点「⚡ 由 JD 生成评分卡」。
- 评分卡结构：第一轨硬性门槛（一票否决，逐条 rejectIf）+ 第二轨业务价值软维度（权重 + 三档打分区间：过往战绩/技能深度/行业匹配/稳定性）+ 反伪相关黑名单（性别/年龄/院校歧视等不计分）+ 业务重点对齐。
- 端点：`POST /generate-scorecard`（传 jdObj，LLM 按 OD/数据分析师提示词生成，规则兜底）。scorecard 随 position.created 存账本，版本可追溯。
- 打分：`POST /score-resume {candidateId}`——用该岗位评分卡对简历 LLM 打分，产出【总分/分项得分表+扣分原因+原文依据/核心优势/潜在风险】，写入 assessment.recorded 事件（可追溯）。规则兜底保证不空跑。

实测：JD(llm,9职责)→评分卡(llm,硬门槛+40/30/20/10)→简历打分(llm,58分/不推荐/分项原文依据)，全程入账本。

## 深度适配性评估（JD→评分卡→深度初筛 环环相扣）

从"表层关键词匹配"升级为"底层业务场景与问题解决路径对齐"，四位资深 HRBP 范式：
1. **隐性上下文灌注**：岗位支持 context 字段（业务阶段/团队短板/汇报风格/文化/排雷项），评估时注入，避免 AI 盲人摸象。
2. **评估逻辑重构**：`deepassess.js` + `POST /deep-assess` 调 LLM 按 HRBP prompt 诊断——去水分（忽略"赋能/抓手/主导"等）、区分平台光环vs个人战功、任务相似性、能力迁移半径。
3. **双向证伪**：正向举证（每条优势带简历原文依据）+ 反向排雷（Red Flags：指标矛盾/权限错配/连续性断层/文化排异/证据存疑）。
4. **证据链+可执行**：输出 S/A/B/C 评级 + 场景对齐 + 优势证据链 + Red Flags + 3-5 个刺穿包装的面试验证题。
- **防幻觉**：硬门槛（学历/统招/专业/年限）一律用规则引擎判定，LLM 不推翻；prompt 明确禁止推测院校性质、禁止脑补简历未写信息。
- 结果存 assessment.recorded 事件（可追溯），详情页 DeepAssessView 展示。

实测 10 人：1 A级进初试 / 1 C级不推荐 / 8 B级需面试排雷，每人 4-6 条具体红牌+面试题，不再"全员通过"。

## 评级分流与复捞（S/A 自动进初试 · C 自动淘汰 · B 转人）

- **S/A → 自动进初试**；**C → 自动淘汰**（授权动作）；**B → 分"需面试排雷"和"低置信待复核"两档留人**。
- **双评一致性防误杀**：A/S/C 是不可逆动作，单次 LLM 评级方差大（实测同简历可 A/B 反复），故**再评一次，两次同级才采信**；不一致→降 B 转人工，绝不擅自推进/淘汰。
- **C 自动淘汰可复捞**：淘汰写 decision.made（actor=agent, auto, reversible, 理由全留）。淘汰区（漏斗「已淘汰」）可查看淘汰理由 + 「重新激活」按钮一键捞回待评估，事件留档可追溯。
- B 分档依据：分数≥66 且无「连续性断层」→ 需面试排雷；否则→低置信待复核。
- 收件箱按"人要做什么"分层：待决策/需拍板·推荐/建议淘汰待确认/待绑定岗位/需面试排雷/低置信待复核/待初筛/待补录。

## 尚未实现（按设计顺序）

1. **回归重放引擎**（人的操作主入口）：一次一件事、三个疑点、证据可点开、影响面前置、≤3 次点击、键盘流、批量处理、秒批护栏。
2. **回归重放引擎**：用新规范重放历史事件集，量化「机变准了多少」，再发布 `standard.released`。
3. MCP bundle / 定时任务 / Agent 预设（需单独授权）。
