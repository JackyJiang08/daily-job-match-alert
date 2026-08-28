# Daily Job Match Alert 使用与来源决策

## 最终分工

- **career-ops**：负责 Greenhouse、Lever、Ashby、Workday 等公开 ATS 和公司 career board；保留它原有的去重与申请 pipeline。本项目通过 `sources.careerOps` 可选读取它的 scan history。
- **Daily Job Match Alert**：直接读取两个 SimplifyJobs GitHub 列表（默认启用），保存完整 JD，先本地预筛，再调用 Claude Code / Codex CLI 的订阅登录对 Data 与 AI/ML 两版简历分别做语义评分，生成每日文件。
- **邮件提醒通道（规划中，未启用）**：`intake/eml` 的 `.eml` 解析器每晚都会运行，但目前没有任何邮件被投递进去；Himalaya 邮箱读取已实现但 `sources.himalaya.enabled` 为 `false`。Handshake、Simplify、Wellfound、ZipRecruiter、Jobright 目前都不在采集范围内。
- **macOS launchd**：负责每天固定时间直接运行本地脚本，不依赖 OpenClaw Gateway 常驻。

## 日报时间与文件规则

任务每天 **20:00 America/Chicago** 运行，文件夹和文件名使用第二天的投递日期。例如 2026-08-27 晚上运行后，只生成：

```text
~/Desktop/Daily Job Match Alert/2026-08-28/
├── Daily Job Match Alert - 2026-08-28.html
└── Daily Job Match Alert - 2026-08-28.xlsx
```

桌面日报目录不保留 `latest.html`、CSV、JSON、检查文件或验证图片。JSON 只在系统临时目录中用于构建 XLSX，完成后自动删除。

XLSX 的 `Matches` 表固定 11 列：Company、Title、Location、Role Type、Posted At、Data Score、AI Score、Recommended Resume、Why It Matches、Gaps / Verify、Posting Link。Posting Link 显示域名、点击打开完整 URL；两列分数共用三色色阶。因语义评审不可用而保留本地分数的岗位，会在 Why It Matches 开头标注 `[unreviewed]`。完整 JD、薪资、雇佣类型、来源、发现时间和 freshness 依据只保留在 HTML 报告中。`Run Summary` 表列出计数、Scoring model 和全部 warning，`Notes` 表解释各字段。

## 降级语义：任何单点故障，桌面仍有产物

| 故障 | 行为 | 在哪里看到 |
|---|---|---|
| 某个采集源抛错 | 该源为空，其他源继续 | warning `collector / <源名>` |
| 岗位页面抓不到 | 保留到后续夜晚重试，最多 3 次后关闭 | warning `enrichment / <源>`，含 attempts 计数 |
| `.eml` 文件畸形或超过 5 MB | 只跳过该文件，同目录其他文件照常解析 | warning `collector / Email files` |
| Claude CLI 缺失 / 版本过低 / API-key 登录 / batch 重试后仍失败 | 相关岗位保留本地分数并标记 `unreviewed` | warning `llm / <engine>`；XLSX 前缀 `[unreviewed]`，HTML 橙色 `Match level: unreviewed` |
| 模型漏答岗位 id | 补审一次，仍缺的标为 `unreviewed` | warning `llm / <engine>` |
| 实际模型与 `semanticMatching.model` 不一致 | 本次结果照用 | `MODEL MISMATCH` warning |
| XLSX 生成失败 | 保留 HTML 与去重 state，同目录写入 `XLSX-FAILED.txt`，进程 exit 1 | warning `report / XLSX` + 标记文件 |
| 报告生成前的致命错误 | 输出目录直接写 `ERROR-<运行日期>.html`，并尽力发 macOS 通知 | 错误页本身 |

LLM batch 失败会在 10 秒后重试一次。`unreviewed` 岗位只有本地分数达到阈值才会进入报告，因此模型故障当晚得到的是一份本地排序的清单，而不是空页面。修复后再次成功运行，`XLSX-FAILED.txt` 会自动移除。

`npm run chaos`（`scripts/chaos-check.sh`）用独立的临时 config、state 和输出目录依次跑四个场景——基线、全部采集源断网、订阅 CLI 不可用、畸形 `.eml`——并断言每个场景都仍生成当日文件夹和 HTML。它不会写真实桌面或真实 `state/`，也不会调用订阅 CLI；CI 每次都会运行。

## 各来源怎么自动化

| 来源 | 推荐方式 | 当前状态 |
|---|---|---|
| SimplifyJobs Summer 2027 | 直接读取公开 GitHub README | 默认启用 |
| SimplifyJobs New Grad | 直接读取公开 GitHub README | 默认启用 |
| Greenhouse 等公开 ATS | career-ops provider / 官方公开接口 | 可选，`sources.careerOps` |
| Handshake | 建多个较窄的 daily saved-search alerts，再从专用邮件文件夹读取 | 规划中，未启用 |
| Simplify 网站 | 设置 Match Preferences 和 daily email | 规划中，未启用 |
| Wellfound | 设置 saved search 为 daily email | 规划中，未启用 |
| ZipRecruiter | 设置 job alert email；尽量解析到最终公司 ATS 链接 | 规划中，未启用 |
| Jobright | 优先使用账户内 alert/email；若只有 App push，则作为补充手动发现源 | 规划中，未启用 |

不直接抓登录网站的原因不是技术上完全做不到，而是这些平台的条款通常明确限制机器人、脚本或 scraping。登录态浏览器自动化也容易遇到 MFA、验证码、页面变更和封号风险。邮件通道启用后也只用于"发现链接"；一旦链接落到公开 Greenhouse/Lever/Ashby 等 ATS，后续优先直接监控雇主端。

## 私有简历与更新窗口

在私有 `config.json` 的 `resumeSources.dataPdf` 和 `resumeSources.aiPdf` 中保存两份 PDF 路径。每次任务运行前都会比较 SHA-256；覆盖同一路径的 PDF 后，下一次运行会自动更新 gitignored 的文本简历。如果文件名或目录改变，只需修改私有配置。PDF、提取文本、配置、邮件、日志、状态和报告都不会被 Git 跟踪。

## 费用保护

默认 `semanticMatching.engine` 是 `claude_subscription`，要求 Claude Code **2.1.250 或更新版本**（更旧版本在发送任何 batch 之前就会被拒绝并降级为本地评分）。先运行 `claude auth login --claudeai`，不要选择 `--console`（后者是 API 计费入口）。程序运行前检查 Claude 订阅登录，并从子进程环境中移除 OpenAI、Anthropic、Bedrock、Vertex、Google 的 API key 变量。认证方式不符时相关岗位降级为 `unreviewed` 并记录 warning，不会自动切换为按量 API。

Codex 的 ChatGPT 订阅登录仍可作为可选引擎 `codex_subscription`。订阅 CLI 的运行会消耗对应计划额度，但不会产生 OpenAI Platform/Anthropic API 按量账单。

## 模型固定与审计

`semanticMatching.model` 会传给 `claude --model`。可填 Claude Code 别名 `fable`、`opus`、`sonnet`（各自解析为该系列最新模型），或完整模型名如 `claude-fable-5`；示例配置固定为 `fable`。每个 batch 的 `claude --print --output-format json` 返回都会解析实际使用的模型（`modelUsage` 中输出 token 最多的条目），记录为每个岗位的 `scoringModel`，并显示在 HTML 页眉和 XLSX Run Summary 的 Scoring model 行。无法解析时记为 `unknown` 并给出 warning；若配置的模型与实际模型在别名展开后前缀不一致（例如配置 `fable` 但实际是 `claude-sonnet-5`），当批结果照常使用，但会在 warning 面板中显著提示 `MODEL MISMATCH`。没有任何语义评审的运行显示 `local_only` 或 `none`。

## 邮件通道（规划中）

目前不需要做任何邮箱配置。将来启用时：在邮箱里建立 `job-alerts` label/folder，把各平台的提醒规则自动移入该目录，运行 `himalaya account configure`，再把 `config.json` 的 `sources.himalaya.enabled` 改为 `true`。Himalaya collector 只执行 envelope list 和 `message read --preview`，不会标已读、移动、删除或发送邮件。不要把邮箱密码写进 `config.json`；使用 OAuth、App Password 搭配 macOS Keychain，或安全的 password command。

## 第一次启用

```bash
cp config.example.json config.json
claude auth login --claudeai
claude --version            # 需要 2.1.250+
# 编辑 config.json 中的 PDF 路径与偏好
npm run resume:sync
npm test
npm run demo
npm run chaos
npm run run
chmod +x scripts/run-launchd.sh scripts/install-launchd.sh
./scripts/install-launchd.sh 20 0
```

先手动成功运行一次，以确认网络、Desktop 文件夹权限都正常，再安装定时任务。完整的验收清单见 [VERIFICATION.md](VERIFICATION.md)。

## 无人值守的一天

- **触发**：LaunchAgent 执行 `scripts/run-launchd.sh` → `src/launchd-dispatch.mjs`。到达计划时间且当天尚未成功时执行完整运行（`scheduled`）；其他启动（开机/登录时的 `RunAtLoad`、手动 load）走 `catchup`，只有 `state.lastSuccessfulRun` 距今超过 26 小时才补跑。`install-launchd.sh` 请显式传入小时和分钟（脚本自身兜底值是 06:30）。
- **投递日期**：00:00–14:00（含）运行使用当天日期，14:00 之后生成次日目录。因此正常的 20:00 运行产生明天的文件夹，漏跑后的早晨补跑仍能填上今天的。
- **锁**：`state/.lock` 保存持有者 PID。持有者存活时第二个实例直接退出；PID 已死的陈旧锁自动清除。
- **State**：`state/state.json` 记录每个规范化 URL（原始与跳转目标），同一岗位不会重复出现；每次运行修剪距最近一次尝试超过 90 天的条目。
- **日志**：`state/logs/daily-YYYY-MM-DD.log`，仅保留最近 30 个；日志目录不可用时回落到 `/tmp/daily-job-match-alert-<日期>.log`。
- **致命错误**：输出目录写 `ERROR-YYYY-MM-DD.html`，并尽力发 macOS 通知；补跑路径稍后重试。

## 参考链接

- career-ops: https://github.com/santifer/career-ops
- SimplifyJobs internships: https://github.com/SimplifyJobs/Summer2027-Internships
- SimplifyJobs New Grad: https://github.com/SimplifyJobs/New-Grad-Positions
- Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
- Handshake saved searches: https://support.joinhandshake.com/hc/en-us/articles/218693388-Saving-Job-Searches-and-Receiving-Job-Alerts
- Simplify match preferences: https://help.simplify.jobs/articles/7272801-setting-your-job-match-preferences
- Wellfound saved searches: https://help.wellfound.com/article/782-saved-searches
