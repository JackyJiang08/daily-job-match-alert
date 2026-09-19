# Daily Job Match Alert 使用与来源说明

一句话：这是一个跑在你 Mac 上的夜间求职匹配 agent。它每晚采集公开的实习与应届岗位，用你已有的 Claude 或 ChatGPT 订阅按简历轨道逐一评分，并在本地中枢里生成一页纸的 cover letter。没有 API key，不会自动投递。

## 它每晚做什么

默认每天 **20:00 America/Chicago** 由 launchd 触发一次，无人值守：

1. **采集。** 来源包括公开 GitHub 榜单（SimplifyJobs、Jobright、vanshb03、Zapply、zshah101）、当月的 Hacker News "Who is hiring" 帖、RemoteOK feed、由此前岗位链接自动发现的 Greenhouse / Lever / Ashby / Workday 公开 job board 接口，以及放进 `intake/eml` 的 `.eml` 提醒邮件。每个 board 每晚只轮询一次，带固定 user agent，并使用 ETag / If-Modified-Since 条件请求。
2. **去重。** URL 规范化（去追踪参数、解析跳转）后与 `state/state.json` 比对，同一岗位即使三个来源都列出也只出现一次。
3. **抓 JD。** board 接口直接给出完整正文；其他链接只抓取一次，Workday 页面改走租户公开的 JSON 接口。抓不到的岗位后续夜晚重试，被拒绝或已下线的直接关闭。
4. **硬过滤。** 两条规则由代码强制执行，与模型无关：地点必须在美国（无法判断的会标记 `Location unverified`），岗位要求的毕业窗口必须与 `preferences.graduationDate` 相符。
5. **订阅引擎评分。** 剩余岗位由 Claude Code CLI 或 Codex CLI（以 claude.ai 或 ChatGPT 订阅登录）逐轨评分，每条简历轨道得到 0–100 分、理由与 gaps，并推荐最合适的轨道。
6. **写两个文件到桌面。** `~/Desktop/Daily Job Match Alert/<投递日期>/` 下生成一份自包含的 HTML 清单（可排序、搜索、深色模式、每张卡片折叠完整 JD）和一份 XLSX（每条轨道一列分数）。只有当本次运行有降级时才会多出 `warnings.txt`。

晚间运行写的是第二天的文件夹；漏跑后的早晨补跑填的是当天。同一投递日期再次运行会合并进当日报告而不是覆盖。

## 本地中枢（hub）

`npm run hub` 在 `http://127.0.0.1:4747/` 提供只绑定本机、自身不发外部请求的中枢：

- **Reports**：用与桌面 HTML 相同的组件渲染每一天的报告，按月分组并带 Today 快捷键，可打开桌面副本与工作簿。
- **Resumes**：每条简历轨道一张卡，可上传替换 PDF（当晚生效），旧版本保留可回退。
- **Letters**：已生成 cover letter 的列表，每行有 Open 与 Download PDF；岗位卡上先是 Generate Cover Letter，生成后变成 Open Letter 与 Download PDF。
- **Status**：上次/下次运行、锁状态、Sources 表（每个榜单与 board 的启用状态、上次成功、本轮新增数，dormant 的 board 可点 Resume Polling 恢复）、最近 7 天 warnings，以及 Run Now。
- **Settings**：匹配阈值、接受的匹配等级、引擎与模型、XLSX 是否必需、中枢端口、CLI 连接状态，以及私有的 cover letter 素材。

Cover letter 由同一个订阅引擎根据你的 playbook、最多三封样稿、所选简历与岗位生成，再由引擎以编辑身份复核一次，然后渲染成一页 PDF（本机 Chrome，退化为 pdfkit），存在 `private/cover-letters/`。姓名、联系方式、playbook 与样稿只存在 `private/cover-letter/`；仓库、文档与测试里只有 Jane Doe 之类的占位数据。

## 引擎与计费

唯一的模型访问途径是两个本机订阅 CLI，由 `semanticMatching.engine` 选择：

| 引擎 | CLI | 接受的登录方式 |
|---|---|---|
| `claude`（默认） | Claude Code 2.1.250+ | `claude auth login --claudeai`；`claude auth status --json` 必须显示 claude.ai 订阅（`pro` / `max` / `team` / `enterprise`） |
| `codex` | OpenAI Codex CLI | `codex login` 选 ChatGPT；`codex login status` 必须显示 "Logged in using ChatGPT" |

两者都以子进程运行，启动前删除全部 `ANTHROPIC_*`、`AWS_*`、`OPENAI_*` 环境变量以及 Bedrock / Vertex / Google 凭据开关，因此不可能走 API key 或网关；项目里没有任何 API 客户端。Console 计费、API key 登录、版本过低或 batch 失败都降级为本地关键词分数（标记 `unreviewed`）并写 warning，绝不回退到 API。订阅用量计入各自计划额度。每个 batch 实际使用的模型会从 CLI 输出中读出并记录为 `scoringModel`，与配置不符时给出 warning。

## 隐私模型

所有个人数据都留在 Mac 上、在 Git 之外：

- `config.json`、`resumes/*.md`、`resumes/*.pdf`、`intake/eml/*.eml`、`state/`、`private/`、日志与生成的报告全部 gitignore；仓库只有 `config.example.json` 与代码。
- 简历 PDF 按哈希变化重新用 `pdftotext` 抽取；被 iCloud 云端化的文件会先用 `brctl download` 取回。
- 中枢只写 `config.json`（在运行锁保护下做最小修改）、你点击恢复 board 时的 `state/ats-boards.json`，以及自己的 `private/` 目录。
- 岗位文本一律视为不可信输入（包括在模型 prompt 内）；引擎只拿到临时只读工作区，不给任何工具。
- 不向任何地方提交：不投递、不答筛选题、不改邮箱。

## 来源清单

| 来源 | 接入方式 | 合规依据 | 状态 |
|---|---|---|---|
| SimplifyJobs Summer Internships 与 New Grad 榜单 | 每晚读取两个公开仓库的 README 原文一次 | 公开仓库，本就为此维护；岗位链接指向雇主站点 | 默认启用 |
| Jobright 榜单（Data Analysis 与 Software Engineer 的 Internship / New Grad） | 读取 `jobright-ai/2026-*` 仓库的 README 原文（该组织按毕业年份命名当前周期，没有 ML & AI 榜） | 公开仓库、每日更新；每行链接到带结构化 JobPosting 数据的岗位页 | 默认启用（`sources.githubLists.lists.jobright*`） |
| vanshb03 Summer 2027 Internships 与 New Grad 2027 | README 原文，`dev` 分支 | 公开仓库，截至 2026-09-18 在 30 天内有提交；行内链接直达雇主 ATS | 默认启用（`sources.githubLists.lists.vansh*`） |
| Zapply Internships 2027 / New Grad Jobs 2027 / ML Internships 2027 / New Grad Data Science 2027 | README 原文；Apply 链接是 `zapply.jobs` 跳转，抓 JD 时跟随到雇主页 | 公开仓库、每小时更新 | 默认启用（`sources.githubLists.lists.zapply*`） |
| zshah101 Tech Internships 2027（Summer 2027 与 Fall 2026 两张表） | README 原文 | 公开仓库、每日更新；行内链接直达雇主 ATS | 默认启用（`sources.githubLists.lists.zshahTechInternships`） |
| Hacker News "Ask HN: Who is hiring?" | Algolia HN Search 公开 API：取 `whoishiring` 最新一帖及其顶层评论，只保留提到 intern / new grad / entry level / junior 的帖子，卡片链接指向该评论 | Algolia 官方公开 API、无需 key；帖子本就公开且为求被找到而发 | 默认启用（`sources.hackerNewsHiring`） |
| RemoteOK | 每晚带配置的 user agent 请求一次 `remoteok.com/api`；只保留 US 可工作的远程岗且标题或 tag 属于早期职业 | RemoteOK 公开 feed 及其条款（user agent、follow 链接回岗位页、注明 RemoteOK 来源）；`robots.txt` 允许 `/`，crawl-delay 1 秒 | 默认启用（`sources.remoteOk`） |
| Greenhouse boards | `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`（完整正文、`updated_at`，支持 ETag） | Greenhouse 官方公开 Job Board API，无需认证 | 自动发现，或写在 `sources.atsBoards.boards` |
| Lever boards | `GET api.lever.co/v0/postings/{company}?mode=json`（`createdAt`，支持 ETag） | Lever 官方公开 Postings API，无需认证 | 同上 |
| Ashby boards | `GET api.ashbyhq.com/posting-api/job-board/{org}`（`publishedAt`） | Ashby 官方公开 Job Posting API，无需认证 | 同上 |
| Workday 招聘站 | `POST {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`，每页 20 条，只翻到回看窗口之外为止；JD 来自单岗位 CXS 接口 | 公开招聘页自身加载的同一份无认证 JSON；只读、每晚一次短翻页、固定 user agent | 同上 |
| `intake/eml` 的 `.eml` 文件 | 每晚本地解析 | 你自己放进去的文件 | 采集器运行中，但目前没有邮件被投递进去 |
| Himalaya 邮箱文件夹 | `himalaya` 只列 envelope 与 `--preview` 读取 | 你订阅的官方提醒邮件；不标记、不移动、不发送 | 已实现，未启用（`sources.himalaya.enabled: false`） |
| career-ops scan history | [career-ops](https://github.com/santifer/career-ops) 写出的本地 TSV | 你自己的本地文件 | 可选（`sources.careerOps`） |

每个来源在 `sources` 下都有独立的 `enabled` 开关；每个新榜单或 feed 首次接入都先走基线：第一次采集把它列出的岗位全部记为已见、不评分，因此开启一个来源不会让某天的报告被灌满。榜单返回 200 但解析出 0 行会触发格式变更 warning；单个来源失败只记 warning，其余照常；Run Details 与 Status 页的 Sources 表各有一行。多榜单同一岗位只出现一次，来源字段记录全部命中的榜单。

**board 如何被发现。** 每晚管道扫描本轮采集到的所有 URL，识别 Greenhouse / Lever / Ashby / Workday 岗位，并把对应 board 记入 `state/ats-boards.json`（含首次发现日期、揭示它的来源、最近一次成功轮询与岗位数）。也可以手动追加（`{ "url": "https://job-boards.greenhouse.io/examplecorp" }`，或 `greenhouse:` / `lever:` / `ashby:` / `workday:tenant/site` 形式的 key），或用 `"enabled": false` 禁用。

**首次轮询只做基线。** 某 board 第一次被轮询时，它列出的全部岗位只写入 seen、不进评分；数量以 info 级别写进 `warnings.txt` 与 Run Details。从下一晚起只处理 posted / updated 落在回看窗口内的新岗位。每 board 每晚最多一次，并发受 `network.concurrency` 约束，请求头沿用 `network.userAgent`；单个 board 失败只记 warning；连续 7 晚失败的 board 标为 dormant 并停止轮询，直到在 Status 页点 Resume Polling。来自 board 的岗位在报告卡片上显示为 `Greenhouse · Example Corp` 等。

### 明确不接入的平台及原因

| 平台 | 原因 |
|---|---|
| LinkedIn、Indeed、Glassdoor、Handshake | 条款禁止自动化访问与抓取；有登录、限流与机器人检测，且没有公开的无认证 feed |
| Wellfound、Work at a Startup | 岗位在登录墙之后，读取需要账号会话，本项目从不持有 |
| Adzuna、USAJOBS | API 需要注册申请 key，本项目不使用任何 key |

若其中某个平台将来提供公开、无认证、合规的 feed，可按同样的采集器模式接入；在此之前，来自它们的提醒邮件是唯一规划中的途径，且只作为链接来源。

## 可靠性设计

- **降级不中断。** 采集源、board、页面抓取或模型调用失败都变成 `warnings.txt` 里一行 `[stage / source] message`，其余照常；报告生成前的致命错误写 `ERROR-<日期>.html` 并发 macOS 通知。
- **补跑。** 只有 HTML 与 XLSX 都落盘才记录 `state.lastSuccessfulRun`；登录或开机触发的补跑路径仅在上次成功超过 26 小时时执行。
- **锁。** `state/.lock` 保存持有者 PID；第二个实例直接退出，PID 已死的陈旧锁自动清除。
- **同日累积。** `state/report-payload-<日期>.json` 保存该投递日期的全部结果；每次运行合并进去（语义评审过的版本优先、更长的 JD 优先）并以 `Daily update #N` 重新渲染；未完成的日期在下一次运行开始时先重建。
- **chaos 套件。** `npm run chaos` 在临时目录跑六个场景，CI 每次执行：基线、全部采集源断网、订阅 CLI 不可用、畸形 `.eml`、XLSX 失败后恢复、某 ATS 接口返回 500。每个场景都必须仍留下当日文件夹与 HTML。

## 快速开始

需要 macOS（Linux 可运行除 launchd 与 iCloud 取回外的一切）、Node.js 20+、`pdftotext`，以及一个已登录的订阅 CLI。

```bash
git clone https://github.com/JackyJiang08/daily-job-match-alert.git
cd daily-job-match-alert
npm ci
cp config.example.json config.json
```

编辑 `config.json`：把 `resumes.tracks` 的每一项指向你的私有 PDF（示例带 `data`、`llm`、`agent` 三条轨道），设置 `preferences.graduationDate`，选择引擎。然后：

```bash
claude auth login --claudeai      # 或 codex login（选 ChatGPT）
npm run resume:sync               # 抽取简历文本
npm test && npm run demo && npm run chaos
npm run run                       # 真实跑一次，检查桌面文件夹
./scripts/install-launchd.sh 20 0 # 安装每晚定时（zsh）
./scripts/install-hub-launchd.sh  # 常驻中枢；然后打开 http://127.0.0.1:4747/
```

拉取新代码后运行 `npm run hub:restart`。完整验收清单见 [VERIFICATION.md](VERIFICATION.md)。

## 当前限制

- **邮件通道尚未启用。** Himalaya 采集器已实现但关闭，也没有任何规则把提醒邮件投递到 `intake/eml`；在此之前 Handshake、Simplify、Wellfound、ZipRecruiter、Jobright 的提醒不会被采集。
- **不抓登录站点。** Handshake、LinkedIn、Jobright、Wellfound 等平台的条款禁止自动访问，且有登录、MFA 与机器人检测；本项目只读公开、无认证的接口。将来其提醒邮件接入后也只作为链接来源，雇主公开 board 上的岗位才是记录依据。
- **Workday 尽力而为。** CXS 列表接口公开但无官方文档；租户改动后该 board 会失败、警告并最终 dormant，其他一切照常。
- **新 board 延迟一晚。** 新发现的 board 从第二次轮询起才贡献评分岗位，这是有意为之。
- **本地评分只是粗筛。** 订阅 CLI 不可用时，`unreviewed` 岗位按关键词重合度排序，只能当作粗略清单。
- **以 macOS 为先。** 定时、通知、iCloud 取回与中枢的 LaunchAgent 都假定 macOS。

## 参考链接

- career-ops: https://github.com/santifer/career-ops
- SimplifyJobs internships: https://github.com/SimplifyJobs/Summer2027-Internships
- SimplifyJobs New Grad: https://github.com/SimplifyJobs/New-Grad-Positions
- Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
- Lever Postings API: https://github.com/lever/postings-api
- Ashby Job Posting API: https://developers.ashbyhq.com/reference/jobpostingapi
