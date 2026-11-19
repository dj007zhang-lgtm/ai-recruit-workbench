# @local/ai-recruiting-workbench

**AI 招聘工作台 harness 插件** —— 已安装（`application: applied`，零警告）。

**设计权威：[WORKSPACE-DESIGN.md](../WORKSPACE-DESIGN.md)**。设计从四个前提推导，不是从 PRD 转写：

| 前提 | 答案 |
|---|---|
| 数据沉淀 | `events.jsonl` append-only 事件账本；状态全部由 `fold()` 派生，永不直接写 |
| 流程沉淀 | 每条事件带 `causedBy`，流程是因果链，可回放、可审计、可统计 |
| 人的操作路径 | 人只在判断点出现，永不编辑状态；`HUMAN_CONTRACT` 在工具层强制 |
| 机的规范与校准 | `MACHINE_CONTRACT` 强制产出必带证据/置信度/版本/哈希；校准产物是规范新版本，不是改分 |

界面是账本的投影，不是起点。**看板是看板，流程是流程，AI 能力是 AI 能力 —— 三块并列、用 tab 分开，互不干扰**：① 数据看板（只读观察，8 项 KPI 带环比、漏斗、渠道）② 流程（节点条 + 收件箱 + 判断动作）③ AI 能力（调用表、提质指标、规范版本链、人机契约）。

## 已落地

- `ledger.js`：事件追加、fold 派生、project 投影、replay 因果回放、规范版本链、旧数据迁移（幂等）。
- `index.js`：13 个 `recruit_*` 工具；所有写操作只追加事件，所有读操作只读投影。
- `dashboard.js` + `client.js`：实时看板（8 项 KPI 全带环比、六节点、AI 能力表）、`main` 主面板（`key=ai-recruiting`）、会话首屏精简实时条，以及**右侧插件栏图标**（`sidebar.panellist`，`id=ai-recruiting` 与 `main` 的 key 一致，侧栏按钮由 owner 渲染）。
- `GET /api/ai-recruiting/board` 实时路由。
- `recruit_replay`：任意结论可追溯到事件、依据、证据、规范版本。
- `recruit_standards`：版本链与校准聚类；聚类达 3 次自动生成 `standard.proposed`。

## 契约在代码里，不在口号里

- 淘汰 / Offer 只能经 `recruit_decide`，且必须留理由。
- `recruit_record_assessment` 强制：每维有证据、缺证据判未判定、必带 confidence、拒绝自动淘汰路由。
- `recruit_calibrate` 校验五选一原因码。
- 状态文件被手工改动不影响 `fold()` 结果（已验证）。

## 三个 tab（并列分区，不揉在一起）

① **数据看板**：只读观察层，8 项 KPI 全带环比、漏斗/渠道环比、节点概览；带「去处理 N 条待办 →」跳到流程。② **流程**：节点条 + 收件箱（一次一件事）+ 判断动作 + 证据 + 影响面 + 时间线。③ **AI 能力**：能力调用表、提质指标、规范版本链与校准聚类、人机契约。

## 验证

- 4 个 JS 模块语法通过；零外部依赖。
- 26 项测试通过：迁移幂等、事件只追加、敏感字段不进账本、投影派生、去重留痕、人机契约强制、causedBy、回放、规范版本建议、看板与 HTTP 路由、改状态文件不影响 fold。
- 新会话实测（见交付报告）与 GUI 路由 HTTP 200。
- **未验证**：主面板/精简条实际渲染、图标、详情页（无浏览器控制）。带参 `Slots.listSubTree` 在本 harness 上被工具侧拒绝（`input must be an object`），catalog 不含 occupants，因此侧栏图标是否已显示**需你在 GUI 右侧插件栏确认**：应出现「AI 招聘工作台」图标，点击切到主面板。
- **已知**：升级时旧 Host 模块 generation 可能残留 `duplicate exact route`；已用换路径 + `ctx.effect` 清理缓解，彻底清理需重启应用。

## 交互（已实现）

主面板 = 收件箱（左，按风险排序）+ 候选人详情（右）。动作：采纳 / 补一句 / 改判 / 淘汰 / Offer，均经 `POST /api/ai-recruiting/action` 写入事件账本；状态派生、收件箱自动减一、时间线加一条。证据可点开原文、影响面前置、↑↓ 切换、Enter 采纳、一键回滚（追加补偿事件）。

**界面动作 == 一次工具调用**：`actions.js` 的 `performAction()` 是唯一实现，`recruit_decide` / `recruit_calibrate` 与 HTTP 端点都调它，界面无法绕过账本。契约在服务端强制：淘汰与 Offer 必留理由、改判必选原因码、补一句必填、AI 不自动淘汰。

端点：`GET /api/ai-recruiting/workbench`（看板+收件箱+详情+因果链+契约）、`POST /api/ai-recruiting/action`、`GET /api/ai-recruiting/board`。

> **数据目录已重置为空态**：没有预置职位、候选人、评分、邀约、决策或编造的环比基线。旧演示数据已移出工作区（备份在 `/tmp/ai-recruiting-demo-backup-*.tar.gz`）。首次打开是空的，接入第一份简历后才产生数据。

## 四个现实问题（已落地）

**1. 邮箱怎么接，简历怎么抓**
`fetch_mail.py` 用 Python 标准库 `imaplib`/`poplib` + `email`，IMAP/POP3 over SSL，只读、不删邮件。配置 `recruiting/mail.json`（模板 `mail.example.json`）：host / port / user / 应用专用密码 / folder / criteria（默认 UNSEEN）。密码可用环境变量 `RECRUIT_MAIL_PASSWORD` 避免明文。
扫邮件 → 取简历附件（pdf/docx/doc/rtf/html/txt/图片）→ 按 `Message-ID + 附件 SHA256` 去重（`mail_seen.json`）→ 原件落 `recruiting/inbox/`。
```
python3 fetch_mail.py --config recruiting/mail.json --check          # 只验配置
python3 fetch_mail.py --config recruiting/mail.json                   # 抓取留档
python3 fetch_mail.py --config recruiting/mail.json --upload http://127.0.0.1:62947   # 抓完直接入库
```
**需要你给**：邮箱地址、IMAP/POP3 服务器、应用专用密码。没有凭据就无法真连，脚本不会假装接通。也可以不接邮箱，只用本地上传。

**2. 本地简历怎么上传、怎么解析**

**界面入口**：工作台顶部（三个 tab 之上）的「＋ 接入简历」按钮 —— 可选来源渠道与关联岗位，支持多选文件，选完自动上传、自动刷新并切到流程 tab 显示新候选人。这才是入口，不是只有一个端点。

`POST /api/ai-recruiting/upload`，body 为 `{name, filename, contentBase64, positionId, source, phone, email}`，上限 20MB。Host 留档原件 → 调 `parse_resume.py` → 脱敏 → 三键去重 → 写 `resume.received` 事件。
解析能力（自带依赖，不依赖系统）：
| 格式 | 方式 |
|---|---|
| `.docx` | `python-docx`（段落 + 表格） |
| `.doc/.rtf/.html` | macOS `textutil` |
| `.txt/.md/.csv/.json` | 直接解码（utf-8/gb18030/big5） |
| **文字版 `.pdf`** | 插件自带 `vendor/pypdf`（已打包） |
| **扫描件 PDF / 图片** | 环境无 OCR，**降级为 `needsOcr`**：原件留档、收件箱出现「待补录」，人/Agent 用 `backfill` 补录文本后再进评估 |

**3. 简历和流程在哪留档，怎么回溯激活**
- 原件：`recruiting/files/<candidateId>/<原文件名>`，不可变；重复投递追加新原件、不新建人。
- 事实：`recruiting/events.jsonl`（append-only，含 `files`、`mail`、`parse`、`inputHash`、`causedBy`）。
- 派生：`projections/state.json`、`candidates.jsonl` 等，只由 fold 生成。
- 回溯：`recruit_replay(subjectId)` 给出完整因果链、每步 `basedOn`、当时规范版本；`GET /api/ai-recruiting/archive` 列出全部原件。
- 激活：`activate` 动作把「人才库 / 已淘汰」的候选人重新拉回「待评估」，必须写原因，追加 `stage.advanced` 事件（不删历史）。

**4. 数据怎么穿透、怎么分析**
- 穿透：`GET /api/ai-recruiting/drill?metric=&stage=&source=` 或 `recruit_drill` 工具，从看板指标 / 阶段 / 渠道下钻到候选人名单，每条带原件路径、事件数、最近事件。再进 `recruit_workbench` 看详情、`recruit_replay` 看因果链、原件本身可直接打开。
- 分析：`recruit_dashboard`（8 项 KPI 带环比、漏斗、渠道、节点、AI 效能）、`recruit_report`（漏斗/来源/效率）、`recruit_standards`（规范版本链与校准聚类）。所有数字从事件账本重算，不是另存一份统计表。

## 待实现（按设计顺序）

1. **回归重放引擎**：新规范在历史事件集上重放 → 量化「机变准了多少」→ 再发布 `standard.released`。
3. MCP bundle / 定时任务 / Agent 预设（需单独授权）。
