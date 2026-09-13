# Daily Job Match Alert 使用与来源决策

## 最终分工

- **career-ops**：负责 Greenhouse、Lever、Ashby、Workday 等公开 ATS 和公司 career board；保留它原有的去重与申请 pipeline。本项目通过 `sources.careerOps` 可选读取它的 scan history。
- **Daily Job Match Alert**：直接读取两个 SimplifyJobs GitHub 列表（默认启用），保存完整 JD，先本地预筛，再调用 Claude Code 的订阅登录对 Data 与 AI/ML 两版简历分别做语义评分，生成每日文件。
- **邮件提醒通道（规划中，未启用）**：`intake/eml` 的 `.eml` 解析器每晚都会运行，但目前没有任何邮件被投递进去；Himalaya 邮箱读取已实现但 `sources.himalaya.enabled` 为 `false`。Handshake、Simplify、Wellfound、ZipRecruiter、Jobright 目前都不在采集范围内。
- **macOS launchd**：负责每天固定时间直接运行本地脚本，不依赖 OpenClaw Gateway 常驻。

## 日报时间与文件规则

任务每天 **20:00 America/Chicago** 运行，文件夹和文件名使用第二天的投递日期。例如 2026-08-27 晚上运行后，只生成：

```text
~/Desktop/Daily Job Match Alert/2026-08-28/
├── Daily Job Match Alert - 2026-08-28.html
├── Daily Job Match Alert - 2026-08-28.xlsx
└── warnings.txt            # 仅当本次运行有 warning 时生成
```

桌面日报目录不保留 `latest.html`、CSV、JSON、检查文件或验证图片。JSON 只在系统临时目录中用于构建 XLSX，完成后自动删除。

XLSX 的 `Matches` 表列数随启用的简历轨道数变化：前 5 列固定为 Company、Title、Location、Role Type、Posted At，接着每个启用轨道一列 `<label> Score`（按配置顺序），然后是 Recommended Resume、Why It Matches、Gaps / Verify、Posting Link。示例配置的三条轨道（Data、LLM、AI Agent）共 12 列，单轨道为 10 列。Posting Link 显示域名、点击打开完整 URL；所有分数列共用一个三色色阶；Recommended Resume 是公式，取分数最高轨道的 label，并列时取靠前的轨道。因语义评审不可用而保留本地分数的岗位，会在 Why It Matches 开头标注 `[unreviewed]`。完整 JD、薪资、雇佣类型、来源、发现时间和 freshness 依据只保留在 HTML 报告中。`Run Summary` 表列出计数、Resume tracks（启用轨道列表）、Scoring model 和 warning 条数（并注明 see warnings.txt），不再逐条列出；`Notes` 表解释各字段。

HTML 报告面向"早上打开就能做决定"：页眉只有两行（标题；可读日期 + 匹配数，如 `September 11, 2026 · 9 matches`）。顶部工具栏为纯内联 JS、无外部依赖、离线可用，支持按 best score / 公司 / 发布时间排序，按 role type 与推荐轨道筛选，以及按公司或标题搜索。每张卡片：左侧色环显示 best score，标题一行，第二行 `公司 · 地点 · role type`，下方一行紧凑的逐轨分数（`Data 74 · LLM 87 · AI Agent 85`）加醒目的 `Apply with LLM Resume` 标签；`Unreviewed`、`Location unverified`、`Fetch blocked`、`Posting removed`、`Login wall`、`Email only` 等语义标记以统一样式的小徽标显示；理由与 gaps 各默认显示前两条、其余点击展开；JD 折叠；投递按钮（所有外链在新标签页打开）。多地点岗位在卡片与 xlsx Location 列中统一以 " · " 连接。回看窗口、评分模型、启用轨道、硬过滤排除计数与被排除岗位清单、本日运行次数与最近更新时间、状态提示等运行元数据全部收进页面底部默认折叠的 **Run Details**。Pipeline warnings 不再出现在 HTML 中，而是写入同目录的 `warnings.txt`（每行一条 `[stage / source] message`，首行注明日期与条数，零 warning 时不生成）。页面支持 `prefers-color-scheme` 深色模式与移动端单列；样式令牌与脚本在 `src/report-theme.mjs`，组件在 `src/report-components.mjs`，`src/report.mjs` 只负责组装数据。

Workday 招聘站（`*.myworkdayjobs.com`）的岗位页由浏览器端渲染，HTML 抓取拿不到 JD。这类岗位改走租户公开的 JSON 接口（`/wday/cxs/...`），enrichment 记为 `workday_cxs`；接口失败时回退到原有 HTML 路径。

地点与毕业窗口是确定性资格，由 `src/eligibility.mjs` 在 `isEligible` 中对每个岗位强制执行，与评分引擎无关：地点含明确非美国家/地区/城市标识（列表 `NON_US_LOCATION_MARKERS` 可扩展）即排除，含美国标识即通过（同一字符串中美国标识优先），仅写 `Remote` 或为空则通过但在 Gaps 追加 "Location unverified — confirm US eligibility"，HTML 卡片显示 `Location unverified` 徽标。毕业窗口由 `preferences.graduationDate`（示例 `2027-05`）驱动，规则见 `GRADUATION_EXCLUSION_RULES`，仅在命中的所有日期都过早时才排除；表述有歧义交给语义层。缺少 `graduationDate` 时该规则关闭并给出 warning。

## 降级语义：任何单点故障，桌面仍有产物

| 故障 | 行为 | 在哪里看到 |
|---|---|---|
| 某个采集源抛错 | 该源为空，其他源继续 | warning `collector / <源名>` |
| SimplifyJobs 榜单返回 200 但解析出 0 行 | 视为上游格式可能变更，其他源继续 | warning `collector / <源名>`，提示检查解析器 |
| 同一轮里两个追踪链接指向同一岗位 | 保留首个并合并来源标签，丢弃项写入运行摘要 `debug.droppedDuplicateFinalUrls` | stderr 每条一行 |
| 岗位地点在美国之外，或毕业窗口不符 | 本地代码确定性排除（与评分引擎无关），Run Summary 分列计数 | warning `eligibility / hard filter` 汇总一条 |
| 岗位页面抓不到（429、5xx、超时、JSON 无法解析） | 保留到后续夜晚重试，最多 3 次后关闭 | warning `enrichment / <源>`，含 attempts 计数 |
| 站点拒绝抓取（HTTP 403）或岗位已下线（404、410） | 首次即关闭，不再重试 | warning `enrichment / <源>`，注明岗位名及 `blocked` / `removed` |
| `.eml` 文件畸形或超过 5 MB | 只跳过该文件，同目录其他文件照常解析 | warning `collector / Email files` |
| Claude CLI 缺失 / 版本过低 / API-key 登录 / batch 重试后仍失败 | 相关岗位保留本地分数并标记 `unreviewed` | warning `llm / <engine>`；XLSX 前缀 `[unreviewed]`，HTML 卡片 `Unreviewed` 徽标 |
| 模型漏答岗位 id | 补审一次，仍缺的标为 `unreviewed` | warning `llm / <engine>` |
| 实际模型与 `semanticMatching.model` 不一致 | 本次结果照用 | `MODEL MISMATCH` warning |
| XLSX 生成失败 | 保留 HTML 与去重 state，同目录写入 `XLSX-FAILED.txt`，当日 payload 在 `state/report-payload-<日期>.json` 中保持未完成，不更新 `lastSuccessfulRun`，进程 exit 1 | warning `report / XLSX` + 标记文件 |
| 启动时发现更早日期的 payload 未完成 | 先用它重建该日期的 HTML 与 XLSX（不采集、不评分），清除标记并记录 `lastSuccessfulRun` | warning `report / report payload` |
| 同一投递日期再次运行 | 合并进当日 payload 并从全量重新渲染；零新岗位时输出与上次一致，Run Details 显示 `Daily update #N` | HTML Run Details、Run Summary `Update today` |
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

## 简历轨道与更新窗口

简历在私有 `config.json` 的 `resumes.tracks` 中按顺序配置，数量不限（1..N）：

```json
"resumes": {
  "autoRefresh": true,
  "pdftotextCommand": "pdftotext",
  "tracks": [
    { "id": "data",  "label": "Data",     "pdf": "~/Desktop/Your Data Resume.pdf",     "enabled": true },
    { "id": "llm",   "label": "LLM",      "pdf": "~/Desktop/Your LLM Resume.pdf",      "enabled": true },
    { "id": "agent", "label": "AI Agent", "pdf": "~/Desktop/Your AI Agent Resume.pdf", "enabled": true }
  ]
}
```

`id` 是内部键：决定提取文本的文件名 `resumes/<id>.md`（可用 `profile` 覆盖）、语义评审结果里的 `scores.<id>` 字段，以及 `state/resume-sources.json` 中的哈希记录。`label` 用于展示：XLSX 的 `<label> Score` 列、HTML 卡片上的分数 chip 和 Recommended Resume 的取值。`enabled: false` 的轨道完全不参与抽取、打分、prompt 和报告，连它的 PDF 和 profile 都不会被读取；全部轨道都停用或列表为空会按简历缺失处理（fatal）。轨道顺序决定列顺序，最高分并列时取靠前的轨道。本地（评审前）打分对 `data`、`ai`、`llm`、`agent` 四个 id 有内置关键词画像，其他 id 使用四者的并集做粗筛，真正的逐轨判断由订阅评审给出。

旧版布局（`resumes: { data, ai }` + `resumeSources`）仍可读取：程序会在内存中迁移为 Data、AI 两条轨道，并在 stderr 打印一行升级提示。

每次任务运行前都会比较每个启用轨道 PDF 的 SHA-256；覆盖同一路径的 PDF 后，下一次运行会自动更新 gitignored 的文本简历。如果文件名或目录改变，只需修改私有配置。PDF、提取文本、配置、邮件、日志、状态和报告都不会被 Git 跟踪。

简历 PDF 放在 iCloud 同步目录（桌面、文稿）时，macOS 的"优化储存空间"可能把本地副本回收为仅云端占位符，读取会报 `Unknown system error -11`/`EAGAIN` 或读到空内容。夜间运行遇到这种情况会自动执行 `brctl download <路径>`，然后每 2 秒重试读取，最长等待 60 秒；取回成功后照常继续，并在 `warnings.txt` 与 HTML 的 Run Details 里留下一条 info 级提示"<轨道> 简历曾被 iCloud 云端化，已自动取回"。60 秒内仍未取回则按现有 fatal 路径失败，错误信息会给出具体路径并提示在 Finder 中右键该文件选择"立即下载"，或把简历移出 iCloud 同步目录。非 macOS 环境或没有 `brctl` 时该机制静默跳过，行为与以前一致。

## 费用保护

默认 `semanticMatching.engine` 是 `claude_subscription`，要求 Claude Code **2.1.250 或更新版本**（更旧版本在发送任何 batch 之前就会被拒绝并降级为本地评分）。先运行 `claude auth login --claudeai`，不要选择 `--console`（后者是 API 计费入口）。程序运行前检查 Claude 订阅登录，并在启动子进程前移除所有可能改变认证或路由的环境变量：`ANTHROPIC_` 与 `AWS_` 前缀全部，以及 `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_API_KEY`、`CLOUD_ML_REGION`、`CLAUDE_API_KEY`、`OPENAI_API_KEY`。认证方式不符时相关岗位降级为 `unreviewed` 并记录 warning，不会自动切换为按量 API。

订阅校验采用白名单：`claude auth status --json` 必须 `loggedIn: true`，`authMethod` 属于 `claude.ai`/`claudeai`/`subscription`，若返回 `apiProvider` 必须是 `firstParty`，若返回 `subscriptionType` 必须属于 pro/max/team/enterprise；`console`（Console 计费）、`apiKey`、Bedrock、Vertex 一律拒绝并降级为本地评分，warning 中写明实际 `authMethod`。`local_only` 之外只有 `claude_subscription` 一个引擎。订阅 CLI 的运行会消耗对应计划额度，但不会产生 Anthropic API 按量账单。

## 模型固定与审计

`semanticMatching.model` 会传给 `claude --model`。可填 Claude Code 别名 `fable`、`opus`、`sonnet`（各自解析为该系列最新模型），或完整模型名如 `claude-fable-5`；示例配置固定为 `fable`。每个 batch 的 `claude --print --output-format json` 返回都会解析实际使用的模型（`modelUsage` 中输出 token 最多的条目），记录为每个岗位的 `scoringModel`，并显示在 HTML 底部 Run Details 和 XLSX Run Summary 的 Scoring model 行。无法解析时记为 `unknown` 并给出 warning；若配置的模型与实际模型在别名展开后前缀不一致（例如配置 `fable` 但实际是 `claude-sonnet-5`），当批结果照常使用，但会在 `warnings.txt` 中记录 `MODEL MISMATCH`。没有任何语义评审的运行显示 `local_only` 或 `none`。

## 邮件通道（规划中）

目前不需要做任何邮箱配置。将来启用时：在邮箱里建立 `job-alerts` label/folder，把各平台的提醒规则自动移入该目录，运行 `himalaya account configure`，再把 `config.json` 的 `sources.himalaya.enabled` 改为 `true`。Himalaya collector 只执行 envelope list 和 `message read --preview`，不会标已读、移动、删除或发送邮件。不要把邮箱密码写进 `config.json`；使用 OAuth、App Password 搭配 macOS Keychain，或安全的 password command。

## 本机中枢（hub）

`npm run hub` 在 `http://127.0.0.1:4747/` 启动一个只运行在本机的 Web 中枢（端口来自 `config.json` 的 `hub.port`）。它是加法：夜间管道、桌面输出、xlsx、`warnings.txt` 全部不变；中枢只读管道产物，只写 `config.json` 与仓库内 gitignored 的 `private/` 目录。只绑定 127.0.0.1，不发起任何外部网络请求，不显示 API key，不渲染简历正文（只显示文件元数据）。左侧导航四个页面：

- **Reports**：按日期倒序列出 `state/report-payload-*.json`，选中后用与桌面 HTML 相同的组件、工具栏与深色模式渲染；顶部一行 "Desktop copy: <路径>" 指向桌面文件夹，桌面副本始终是权威副本，中枢不会修改它。
- **Resumes**：每条轨道一张卡：label、启用状态、PDF 文件名与路径、最近上传时间、中枢试抽取结果（字符数或 pdftotext 报错）、夜间 profile 状态。上传替换 PDF 或新增轨道（id/label/PDF）时，文件存到 `private/resumes/<id>/<ISO时间>-<原文件名>.pdf`，并把 `config.json` 里该轨道的 `pdf` 改为新文件，保留最近 5 个版本可回退。仍指向桌面等外部路径的轨道标为 "External file"，原样工作、不强制迁移；上传过的标为 "Managed by hub"。只接受 .pdf，上限 5 MB。
- **Status**：上次运行（时间、trigger、结果、匹配数）、从已安装 LaunchAgent 读取的下次计划时间、锁状态、最近 7 个报告日期的 warnings 计数并可展开当日 `warnings.txt`、`ERROR-*.html` 列表。**Run Now** 弹出确认后以子进程执行 `node src/index.mjs --config config.json`，环境变量 `DAILY_JOB_MATCH_ALERT_TRIGGER=manual`，严格遵守现有锁文件（锁被占用时按钮禁用并显示原因），页面轮询显示进度与日志尾部 50 行；日志在 `private/hub/logs/`。
- **Settings**：只暴露 `minimumMatchScore`、`semanticMatching.acceptedMatchLevels`、`semanticMatching.model`、`reports.xlsx.required`、`hub.port`，校验后写回 `config.json`，其他键与顺序原样保留；写入时使用与管道相同的锁，避免与 20:00 运行并发。

所有写操作都是 POST，且 `Host`/`Origin` 必须是 127.0.0.1 或 localhost，否则 403；日期、轨道 id、错误报告文件名等路径参数都做严格白名单校验。

常驻安装（与夜间任务是两个独立的 LaunchAgent）：

```bash
./scripts/install-hub-launchd.sh            # KeepAlive + RunAtLoad，日志在 state/logs/hub.*.log
./scripts/install-hub-launchd.sh --remove   # 停止并移除
npm run hub:restart                         # 更新代码或修改 hub.port 后重启常驻中枢
```

`git pull` 更新代码后运行 `npm run hub:restart`（未安装 LaunchAgent 时会给出提示，直接重新 `npm run hub` 即可）。中枢内所有时间都按 `config.timeZone` 显示，侧栏底部常驻显示上次运行时间与结果、下次运行时间；夜间运行会把 trigger（scheduled / catchup / manual）与完成时间写进当日 payload，Status 页与报告页眉（`Ran Sep 12, 8:00 PM`）直接读取。

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

- **触发**：LaunchAgent 执行 `scripts/run-launchd.sh` → `src/launchd-dispatch.mjs`。到达计划时间且当天尚未成功时执行完整运行（`scheduled`）；其他启动（开机/登录时的 `RunAtLoad`、手动 load）走 `catchup`，只有 `state.lastSuccessfulRun` 距今超过 26 小时才补跑。`install-launchd.sh` 的小时和分钟可省略，默认 20:00；脚本只能用 zsh 运行，误用 bash 会直接提示"请用 zsh 运行"。
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
