# AI 招聘工作台

基于 DeepSeek Harness 的 AI 招聘插件：简历接入即分流（AI 初筛·BARS 逐维判档）、全流程看板、面试 Copilot、校准闭环。数据全部本地（事件账本），候选人信息不进 Git。数据目录 `recruiting/` 本地生成，不入库。

## 快速开始

**前置要求**：[DeepSeek Harness](https://deepseek.com) 桌面版（含 Node 运行时与 LLM 网关）· macOS 12+（OCR/STT 用系统能力）· Python 3.10+

```bash
# 1. 克隆
git clone https://github.com/dj007zhang-lgtm/ai-recruit-workbench.git
cd ai-recruit-workbench

# 2. 安装 Python 依赖（PDF 解析）
pip3 install pdfminer.six

# 3. 把插件链接进 DSH profile（路径按你的 DSH 安装调整）
mkdir -p ~/.dsh/profiles/desktop/node_modules/@local
ln -s "$(pwd)/ai-recruiting-workbench" ~/.dsh/profiles/desktop/node_modules/@local/ai-recruiting-workbench

# 4. 重启 DeepSeek Harness → 左侧「AI 招聘工作台」出现即成功
```

## 已知限制

- OCR（扫描件识别）与语音转写依赖 macOS Vision/Speech，**仅 macOS arm64 可用**（vendor/ocr 为预编译二进制）；其他平台正文简历可用，扫描件不可用。
- 「导入 JD（链接）」依赖本机 Chrome（headless），路径取标准安装位置。
- LLM 能力走 DSH 内置网关，需在 Harness 中配置 DeepSeek 账号。
- `recruiting/` 为本地数据目录（已被 .gitignore 排除），**请勿放入后提交**；钩子会拦截。

## 设计权威


**[WORKSPACE-DESIGN.md](<WORKSPACE-DESIGN.md>)** —— 工作台不是"功能清单翻译成界面"，而是从四个前提推导：

1. **数据沉淀**：`events.jsonl` append-only 事件账本；状态全部由 `fold()` 派生，永不直接写。
2. **流程沉淀**：每条事件带 `causedBy`，流程是因果链，可回放、可审计、可统计。
3. **人的操作路径**：人只在判断点出现，永不编辑状态；`HUMAN_CONTRACT` 在工具层强制。
4. **机的规范与校准**：`MACHINE_CONTRACT` 强制产出必带证据/置信度/规范版本/输入哈希；校准产物是规范新版本，不是改分。

界面是账本的投影。**看板 / 流程 / AI 能力三块并列，用 tab 分区，互不干扰**。

## 交付

- **[ai-recruiting-workbench/](<ai-recruiting-workbench/README.md>)** —— 已安装的 harness 插件 bundle（`@local/ai-recruiting-workbench`）。15 个 `recruit_*` 工具、事件账本、派生投影、因果回放、规范版本链、实时看板（8 项 KPI 带环比 / 六节点 / AI 能力表）、**可交互收件箱主面板**（采纳/补一句/改判/淘汰/Offer/回滚，动作写进账本）、`sidebar.panellist` 侧栏图标、`GET /workbench` 与 `POST /action` 端点。

- **[recruiting/](<recruiting/README.md>)** —— 数据目录：`events.jsonl`（权威）、`projections/`（派生）、`standards/`、`assessments/`、`metrics.jsonl`。纯文本、可 git、可带走。

## 验证状态

- 4 个 JS 模块语法通过；零外部依赖。
- 26 项测试通过（事件只追加、迁移幂等、脱敏未落盘、投影派生、人机契约强制、causedBy、回放、规范版本建议、看板与路由、改状态文件不影响 fold）。
- 新会话实测 13/13 工具、回放含 `← #4` 因果箭头与 `basedOn` / `inputHash`。
- GUI 路由 HTTP 200。
- **未验证**：主面板/精简条渲染外观、图标、详情页（无浏览器控制）。
- **未实现**：回归重放引擎（用新规范重放历史事件，量化「机变准了多少」再发布版本）、秒批护栏与批量处理、MCP / 定时任务 / Agent 预设。

## 数据与入口

`recruiting/` 是**空态**：无预置职位、无演示候选人、无编造评分或环比基线。工作台顶部有「＋ 接入简历」本地文件入口，选文件即留档、解析、脱敏、去重、写事件，新候选人自动进入收件箱。

## 接入能力

邮箱（IMAP/POP3 抓附件，`fetch_mail.py`）、本地上传与解析（`POST /api/ai-recruiting/upload`，docx/rtf/html/txt/文字版 PDF，扫描件降级待补录）、原件留档与回溯激活（`files/` + `events.jsonl` + `recruit_replay` / `activate`）、数据穿透与分析（`recruit_drill` / `recruit_dashboard`）。详见 [插件 README](<ai-recruiting-workbench/README.md>)。

## 历史产物（仅作留存，非交付主体）

`workbench.html`（单文件网页原型）、`prototype.html`（PRD 可视化稿）、`PRD-V3.2-对齐修订稿.md`、`V3.0-最小闭环与版本计划.md`。
