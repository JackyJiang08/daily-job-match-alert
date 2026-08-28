# Daily Job Match Alert 使用与来源决策

## 最终分工

- **career-ops**：负责 Greenhouse、Lever、Ashby、Workday 等公开 ATS 和公司 career board；保留它原有的去重与申请 pipeline。
- **Daily Job Match Alert companion**：读取 career-ops 的新记录，并直接读取两个 SimplifyJobs GitHub 列表、官方提醒邮件；保存完整 JD，先本地预筛，再调用 Codex CLI/Claude Code 的订阅登录对 Data 与 AI/ML 两版简历分别做语义评分，生成每日文件。
- **OpenClaw / Himalaya**：可作为只读邮件入口和后续通知层。你的 Mac 已安装 Himalaya，但还没有配置邮箱账户。
- **macOS launchd**：负责每天固定时间直接运行本地脚本。即使 OpenClaw Gateway 没有常驻，日报仍能生成。

## 日报时间与文件规则

任务每天 **20:00 America/Chicago** 运行，文件夹和文件名使用第二天的投递日期。例如 2026-08-27 晚上运行后，只生成：

```text
~/Desktop/Daily Job Match Alert/2026-08-28/
├── Daily Job Match Alert - 2026-08-28.html
└── Daily Job Match Alert - 2026-08-28.xlsx
```

桌面日报目录不保留 `latest.html`、CSV、JSON、检查文件或验证图片。JSON 只在系统临时目录中用于构建 XLSX，完成后自动删除。

如果 XLSX 生成失败，pipeline 会以 exit code 1 结束，但不会删除已经生成的 HTML，也不会回滚当日去重 state；同目录会出现包含错误详情的 `XLSX-FAILED.txt`。问题修复后重新运行成功，失败标记会自动移除并恢复为 HTML、XLSX 两个文件。

## 各来源怎么自动化

| 来源 | 推荐方式 | 是否直接抓登录网站 |
|---|---|---|
| Greenhouse 等公开 ATS | career-ops provider / 官方公开接口 | 可以抓公开接口，不登录 |
| SimplifyJobs Summer 2027 | 直接读取公开 GitHub README | 可以 |
| SimplifyJobs New Grad | 直接读取公开 GitHub README | 可以 |
| Handshake | 建多个较窄的 daily saved-search alerts，再从专用邮件文件夹读取 | 不建议 |
| Simplify 网站 | 设置 Match Preferences 和 daily email | 不建议 |
| Wellfound | 设置 saved search 为 daily email | 不建议 |
| ZipRecruiter | 设置 job alert email；尽量解析到最终公司 ATS 链接 | 不建议 |
| Jobright | 优先使用账户内 alert/email；若只有 App push，则作为补充手动发现源 | 不建议 |

原因不是技术上完全做不到，而是这些平台的条款通常明确限制机器人、脚本或 scraping。登录态浏览器自动化也容易遇到 MFA、验证码、页面变更和封号风险。邮件只用于“发现链接”；一旦链接落到公开 Greenhouse/Lever/Ashby 等 ATS，后续优先直接监控雇主端。

## 私有简历与更新窗口

在私有 `config.json` 的 `resumeSources.dataPdf` 和 `resumeSources.aiPdf` 中保存两份 PDF 路径。每次任务运行前都会比较 SHA-256；覆盖同一路径的 PDF 后，下一次运行会自动更新 gitignored 的文本简历。如果文件名或目录改变，只需修改私有配置。PDF、提取文本、配置、邮件、日志、状态和报告都不会被 Git 跟踪。

## 费用保护

默认 `semanticMatching.engine` 是 `claude_subscription`。先运行 `claude auth login --claudeai`，不要选择 `--console`（后者是 API 计费入口）。程序运行前检查 Claude 订阅登录，并从子进程环境中移除 OpenAI、Anthropic、Bedrock、Vertex、Google 的 API key 变量。认证方式不符时任务直接失败，不会自动切换为按量 API。

Codex 的 ChatGPT 订阅登录仍可作为可选引擎 `codex_subscription`。订阅 CLI 的运行会消耗对应计划额度，但不会产生 OpenAI Platform/Anthropic API 按量账单。

## 推荐的邮箱设置

在邮箱里建立 `job-alerts` label/folder，把 Handshake、Simplify、Wellfound、ZipRecruiter、Jobright 的提醒规则自动移入该目录。然后运行一次：

```bash
himalaya account configure
```

配置完成后，把 `config.json` 的 `sources.himalaya.enabled` 改为 `true`，填入账户别名和 folder。Daily Job Match Alert 只执行 envelope list 和 `message read --preview`，不会标已读、移动、删除或发送邮件。不要把邮箱密码写进 `config.json`；使用 OAuth、App Password 搭配 macOS Keychain，或安全的 password command。

## 第一次启用

```bash
cp config.example.json config.json
claude auth login --claudeai
# 编辑 config.json 中的 PDF 路径与偏好
npm run resume:sync
npm test
npm run run
chmod +x scripts/run-daily.sh scripts/install-launchd.sh
./scripts/install-launchd.sh 20 0
```

先手动成功运行一次，以确认网络、Desktop 文件夹权限和邮箱读取权限都正常，再安装定时任务。

## 参考链接

- career-ops: https://github.com/santifer/career-ops
- SimplifyJobs internships: https://github.com/SimplifyJobs/Summer2027-Internships
- SimplifyJobs New Grad: https://github.com/SimplifyJobs/New-Grad-Positions
- Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
- Handshake saved searches: https://support.joinhandshake.com/hc/en-us/articles/218693388-Saving-Job-Searches-and-Receiving-Job-Alerts
- Simplify match preferences: https://help.simplify.jobs/articles/7272801-setting-your-job-match-preferences
- Wellfound saved searches: https://help.wellfound.com/article/782-saved-searches
