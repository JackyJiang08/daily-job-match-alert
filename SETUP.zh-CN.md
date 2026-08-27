# Daily Job Match Alert 使用与来源决策

## 最终分工

- **career-ops**：负责 Greenhouse、Lever、Ashby、Workday 等公开 ATS 和公司 career board；保留它原有的去重与申请 pipeline。
- **Daily Job Match Alert companion**：读取 career-ops 的新记录，并直接读取两个 SimplifyJobs GitHub 列表、官方提醒邮件；保存完整 JD，先本地预筛，再调用 Codex CLI/Claude Code 的订阅登录对 Data 与 AI/ML 两版简历分别做语义评分，生成每日文件。
- **OpenClaw / Himalaya**：可作为只读邮件入口和后续通知层。你的 Mac 已安装 Himalaya，但还没有配置邮箱账户。
- **macOS launchd**：负责每天固定时间直接运行本地脚本。即使 OpenClaw Gateway 没有常驻，日报仍能生成。

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

## 还需要你提供的四项信息

1. Data 简历的 Markdown/纯文本版。
2. AI/ML 简历的 Markdown/纯文本版。
3. 地点、Remote、是否需要 sponsorship、毕业时间/可开始时间等硬条件。
4. 希望日报完成的本地时间；示例安装命令使用每天 06:30。

## 费用保护

默认 `semanticMatching.engine` 是 `codex_subscription`。程序运行前会检查 `codex login status` 必须明确显示 ChatGPT 登录，并从子进程环境中移除 OpenAI、Anthropic、Bedrock、Vertex、Google 的 API key 变量。若认证方式不符，任务直接失败，不会自动切换为按量 API。

Claude Code 也可以设为 `claude_subscription`，但必须先完成 Claude 订阅登录。当前这台 Mac 的 Codex 已使用 ChatGPT 登录；Claude Code 已安装但尚未登录。订阅 CLI 的运行会消耗订阅计划额度，但不会产生 OpenAI Platform/Anthropic API 按量账单。

## 推荐的邮箱设置

在邮箱里建立 `job-alerts` label/folder，把 Handshake、Simplify、Wellfound、ZipRecruiter、Jobright 的提醒规则自动移入该目录。然后运行一次：

```bash
himalaya account configure
```

配置完成后，把 `config.json` 的 `sources.himalaya.enabled` 改为 `true`，填入账户别名和 folder。Daily Job Match Alert 只执行 envelope list 和 `message read --preview`，不会标已读、移动、删除或发送邮件。不要把邮箱密码写进 `config.json`；使用 OAuth、App Password 搭配 macOS Keychain，或安全的 password command。

## 第一次启用

```bash
cp config.example.json config.json
cp resumes/data.example.md resumes/data.md
cp resumes/ai.example.md resumes/ai.md
# 替换两份简历内容并编辑 config.json
npm test
npm run run
chmod +x scripts/run-daily.sh scripts/install-launchd.sh
./scripts/install-launchd.sh 6 30
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
