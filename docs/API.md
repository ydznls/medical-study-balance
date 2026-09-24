# API v1

第一版有可运行的规则规划接口。尚未连接任何付费模型，未生成或存储模型密钥。

## 身份与访问

所有学习数据接口要求当前站点的 ChatGPT 登录会话。线上身份由 Sites 平台校验，客户端不能通过自行设置身份请求头取得权限。站点当前按私人用途部署。

目前没有独立的 Bearer API key 认证，因此这些接口可直接供同源页面使用；外部 Claude 服务后续需要补充服务端认证适配，不能把会话 cookie 或模型密钥写进公开源码。

## POST /api/v1/plan

读取当前用户的保存记录，返回最多三个行动及原因。可临时覆盖日期、剩余时间和精力；此操作不修改保存记录。

请求示例：

```json
{"date":"2026-09-23","availableMinutes":30,"energy":"low"}
```

所有字段可省略。availableMinutes 为尚未使用的时间，范围 0–1440；energy 可为 low、medium、high。

响应包含 apiVersion、engine（当前为 rules）、date、actions、warnings、mode、reason、free、low、revision 和 persisted:false。每个 action 包含 id、kind、sourceId、title、minutes、minimum、reason、score、hard。

同源页面调用：

```js
const response = await fetch("/api/v1/plan", {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ availableMinutes: 30, energy: "low" })
});
const result = await response.json();
```

错误：400 输入无效；401 未登录；403 来源不符；409 尚未建立个人记录；413 请求过大；503 暂时不可用。

后续模型接入点为 lib/planner.ts 中的 generatePlan。模型建议必须继续遵守时间容量、最多三项、睡眠底线和用户确认写入的边界。

## GET /api/state 与 PUT /api/state

GET 返回当前用户的 state 和 revision。PUT 接收 {state, revision}，完整数据通过 lib/balance.ts 的校验后保存。revision 用于防止多个窗口互相覆盖；冲突返回 409。首次保存使用 revision:0。

## GET /api/health

返回应用名称、API 版本和基本运行状态；不读取用户数据，不代表数据库健康检查。站点入口仍受平台访问策略约束。

## 资料接口

- `GET /api/v1/materials`：当前用户的资料元数据列表。每条记录额外带 `hasFile`（是否有上传的文件，不外泄 storage_key）和 `parse`（最近一条解析任务的摘要，没有任务时为 `null`），资料卡片刷新后仍能显示「已解析 / 需要 OCR」。
- `POST /api/v1/materials`：multipart/form-data，字段为 courseId、name、kind（ppt/textbook/bank/other）、location、url，以及可选 file。file 和 HTTPS url 二选一；课程必须属于当前用户。文件最大 20 MB，支持 pdf/ppt/pptx/doc/docx/txt/epub。
- `GET /api/v1/materials/:id`：验证归属后读取原文件或跳转已保存的链接。PDF 内联打开，其余下载；不存在或不属于当前用户返回 404。

文件内容保存在私有 R2，元数据保存在 D1。PDF 文字层由系统读取；扫描版 PDF 通过服务端配置的 Anthropic Messages provider 尝试 OCR。没有可用 provider 时保留 `needs_ocr`，不会伪造正文。没有 PPT 转 PDF 或题目生成。上传超时后应先刷新列表确认结果，避免重复上传。

## 资料解析任务

解析是把上传的文件变成文本块，不涉及任何模型调用。任务状态保存在 `material_tasks`，文本块保存在 `material_blocks`（迁移 0002），每个块都带原文位置。

支持的文件：TXT（按行定位）、PPTX（按幻灯片定位）、DOCX（按段落定位，含 Heading）、文字型 PDF（按页定位）。扫描版 PDF 会调用服务端 OCR provider；未配置或调用失败时明确落 `needs_ocr`，不会伪造正文。旧版 .ppt / .doc 请先另存为 .pptx / .docx。

### 状态

`parseStatus` 有五个值，上传成功、解析成功、出题成功是三件独立的事：

| 状态 | 含义 |
| --- | --- |
| `pending` | 任务已建，尚未开始 |
| `running` | 解析中；`writtenBlocks` 是已写入的块数 |
| `ready` | 解析完成，块已落库 |
| `needs_ocr` | 扫描版 PDF 暂未得到 OCR 文字；配置服务端 AI provider 后重跑即可，这是明确终态，不是解析崩溃 |
| `failed` | 解析失败，`parseError` 是稳定错误码，可重试 |

`generateStatus` 与 `parseStatus` 分开保存，目前恒为 `pending`。

### 接口

- `POST /api/v1/materials/:id/tasks`：为当前用户的资料创建解析任务。同一资料已有 `pending` / `running` / `ready` / `needs_ocr` 任务时**原样返回**（HTTP 200，`created:false`），新建时返回 201 和 `created:true`；失败任务不参与复用，会新建一条。链接型资料返回 400 `material_has_no_file`，格式不支持返回 400 `unsupported_type`，超过 20 MB 返回 413 `file_too_large`。
- `GET /api/v1/materials/:id/tasks/:taskId`：返回任务状态。字段有 `parseStatus`、`parseEngine`、`parseError`、`parseMessage`、`writtenBlocks`、`totalBlocks`、`storedBlocks`、`pageCount`、`truncated`、`needsOcr`、`generateStatus`、`byteSize`。
- `POST /api/v1/materials/:id/tasks/:taskId/run`：分步执行解析。单次预算由服务端决定：800 块 / 150 万字符。可选 JSON 体 `{"maxBlocks":N}` 只能在 200–800 之间往上调——每次 run 都会重新解析整个文件，允许把预算调到 1 等于让客户端把 CPU 消耗放大成块数倍。返回 `{task, written, done}`，`done:false` 时再调一次继续。已完成的任务重复调用返回现状、不重写任何块。
- `POST /api/v1/materials/:id/tasks/:taskId/retry`：只允许 `failed` 任务重跑。会清空旧块、把游标归零，并把 `generateStatus` 一并退回 `pending`（旧块没了，基于旧块的生成结果也失效）。每个任务最多从头重试 5 次，超出返回 409 `retry_limit_reached`。
- `GET /api/v1/materials/:id/tasks/:taskId/blocks?from=1&limit=20`：分页读取已经落库的文本块，给「查看解析内容」用。`from` 是起始 ordinal（从 1 开始，小于 1 会被夹到 1），`limit` 默认 20、上限 50。返回 `{task, blocks, from, limit, total, hasMore}`，每个块只有 `ordinal`、`locator`、`locatorKind`、`locatorValue`、`heading`、`text`、`charCount`。翻到末尾返回空数组而不是错误；越界和非法数字按默认值处理。任务未开始或还没写入时 `total` 为 0。

同源页面调用：

```js
const created = await fetch(`/api/v1/materials/${id}/tasks`, { method: "POST", credentials: "same-origin" });
let { task } = await created.json();
let steps = 0;
while ((task.parseStatus === "pending" || task.parseStatus === "running") && steps < 8) {
  const step = await fetch(`/api/v1/materials/${id}/tasks/${task.id}/run`, { method: "POST", credentials: "same-origin" });
  const body = await step.json();
  if (!step.ok) throw new Error(body.message);
  task = body.task;
  steps += 1;
  if (body.done) break;
}
```

页面就是这么做的，只是把 `steps` 上限写死成 `lib/material-task-view.ts` 里的 `maxRunStepsPerClick`（8）：点一次最多发 8 个 `run` 请求，没跑完就停下等用户再点。**没有后台轮询**——每次 `run` 的响应里就带着最新状态，`running` 状态下那颗按钮本身就是「继续解析 / 刷新状态」。预览同样有界：单次对话最多加载 `maxPreviewPages`（5 页 × 20 块），到顶后按钮变成提示文案。

### 错误格式

解析任务接口统一返回 `{"error": 稳定错误码, "message": 中文说明}`。文案表在 `lib/material-task.ts` 的 `taskErrorMessages`，客户端查表而不是把 `parseError` 当文案用。常见码：`corrupt_archive`（文件损坏）、`content_type_mismatch`（内容与记录的类型不符）、`storage_missing`（R2 里没有这个对象）、`source_changed`（分页续跑期间文件被换掉）、`empty_document`、`task_busy`（有并发执行持有租约）、`task_failed`（已失败，需先 retry）。

**解析失败返回 HTTP 200 + `task.parseStatus:"failed"`**：请求本身处理成功，失败的是任务；客户端刷新状态即可看到原因，然后决定是否 retry。401 / 403 / 404 / 409 / 413 仍然按常规语义返回。

### 一致性与隔离

- 每个接口都先确认资料和任务属于当前登录用户，跨用户访问一律 404，不泄露资源是否存在。
- 执行有 60 秒租约：`leaseUntil` 未过期时再次 run 返回 409 `task_busy`；进程中断后租约到期即可被接管。只有从游标 0 重新开始才算一次新尝试，分页续跑不消耗重试次数。
- 写块的顺序是「先删这一段旧行 → 插入 → 最后推进游标」。三步不是原子的，但保证游标不会超过已落库的内容，任何一步中断后重跑都会先删再写，收敛且不产生重复块。
- 分页期间用 SHA-256 校验文件没有换过；换了就置 `failed` 并给 `source_changed`。
- 解析本身是确定性的：同一份文件、同样的参数，重复执行得到同样的块，所以 run 天然幂等。

### 界面（app/library-panel.tsx）

资料卡片直接显示解析状态：`未解析 / 等待解析 / 解析中 / 已解析 / 需要 OCR / 解析失败` 的中文标签、一句人话说明、`running` 时的进度条（已写入 / 总块数），以及已落库块数。按钮按状态给：

| 资料状态 | 按钮 |
| --- | --- |
| 没有任务 / `pending` | 开始解析（先 `POST /tasks` 建任务，再连续 `run`） |
| `running` | 继续解析（直接 `run`，同时起到刷新状态的作用） |
| `failed` | 重试（`POST /retry` 后再 `run`） |
| `ready` | 查看解析内容（`GET .../blocks` 分页预览） |
| `needs_ocr` | 显示「尝试 OCR」按钮；没有配置 provider 时保留状态并说明原因 |

空态是明确的：链接型资料（没有上传文件）显示「这是一条链接资料，没有上传文件，暂时无法解析正文。」，不再支持的扩展名显示支持范围，不再给一个点了会失败的按钮。`hasFile`/格式判断用的是 `lib/library.ts` 的 `canParseFile`，和服务端 `detectKind` 共享同一份 `parseableExtensions`。

界面规则（状态文案、按钮决策、进度、请求上限、空态判断）都放在 `lib/material-task-view.ts`，不依赖 React 也不发请求，所以能用 `node:test` 直接测；组件只负责渲染。本仓库没有装组件测试渲染器，也不打算为此新增依赖，因此 DOM 渲染本身没有自动化测试。

### 本阶段没做的

没有知识点抽取和候选题生成，前端也没有做「重新解析已完成资料」的入口（服务端语义是可复用任务；扫描版 PDF 的 `needs_ocr` 可在原任务上尝试 OCR，失败任务仍走失败重试）。PDF 文字层和 OCR 结果都会把页码写入 `locator` / `locatorKind` / `locatorValue` / `heading`，为后续重点、候选知识点和题目标注来源；AI 生成的内容仍必须能指回原文并由用户确认。

## 学习教练：计划、预习复习、重点提炼、重点讲解

四个接口，都只读当前用户的保存记录，**都不写库**：响应里带 `persisted:false`，重复调用得到同样的结果，也不会因为看了一眼计划就改掉记录。

界面上的「调整今天的可用时间 / 切换本周模式」不走这些接口，而是走 `PUT /api/state`（父组件是唯一的写者，见 app/coach-panel.tsx 与 app/balance-app.tsx），避免同一份记录出现两个并发写入点。`POST /api/v1/schedule/availability` 保留给课表编辑入口和外部工具，是这四个接口里唯一会写库的。

四个接口的输入校验都在 `lib/coach-api.ts`（纯逻辑，可被测试直接断言）：请求体一律 `.strict()`，多写的字段返回 400 而不是被悄悄忽略——前端把 `availableMinutes` 拼成 `freeMinutes` 时不会「看起来生效了」。日期先过形状（`YYYY-MM-DD`）再过真实性（`2026-02-30` 会被 400 挡掉）。错误格式与解析任务一致：`{"error": 稳定错误码, "message": 中文说明}`；401 未登录、403 来源不符、409 revision 冲突、413 请求过大、503 暂时不可用。

### GET / POST /api/v1/schedule/plan

生成今天和本周的学习计划。GET 用查询参数、POST 用 JSON，字段完全一致；两种方式都不写库。

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `date` | `YYYY-MM-DD`，默认今天 | 要规划哪一天 |
| `availableMinutes` | 0–1440 | 今天**还没用掉**的分钟数，不是总时长 |
| `energy` | `low` / `medium` / `high` | 临时覆盖精力 |
| `mode` | `auto` / `normal` / `busy` / `exam` | `auto` 表示按记录自动判断 |

响应：

```json
{
  "apiVersion": "v1", "engine": "rules", "date": "2026-09-23", "weekday": 3,
  "plan": { "mode": "normal", "modeReason": "…", "load": 210, "free": 90, "low": false,
    "actions": [{ "id": "…", "kind": "assignment", "sourceId": "…", "title": "…", "minutes": 30,
      "minimum": "…", "reason": "今天截止", "score": 92, "hard": true,
      "priority": 1, "degrade": "", "waitingFor": [] }],
    "warnings": [], "rhythm": [], "availability": { "…": "…" }, "totalMinutes": 30, "notes": [] },
  "weekPlan": { "week": "2026-09-21", "days": ["…7 天…"], "blocks": [], "courses": [], "notes": [], "totalMinutes": 0 },
  "revision": 12, "persisted": false, "overrides": {}
}
```

- `plan.actions` 最多 3 条，`priority` 从 1 连续编号，每条都带 `reason`（为什么是它）、`minutes`（预计时长）、`minimum`（最低合格版本）和 `degrade`（为什么今天比平时短：低负荷 / 忙周 / 考试周，没有降级时是空字符串）。`waitingFor` 目前恒为空数组，前置关系改由 `warnings` 表达。
- 前置没做完的作业不进 `actions`，并在 `warnings` 里说明要等谁；如果一个行动都不剩，会把最紧的前置本身提上来，且不超过今天剩余的时间。
- `plan.rhythm` 是今天的节奏块：有课的日子是课前预习 + 课后复习，周末是核心课的深度复习。每块带 `kind`（`preview` / `review` / `deep`）、`base`（基准 10 / 30 / 120 分钟）、`minutes`、`factors`（每个系数配一句人话，如「忙周：只保留最小闭环 ×0.5」）、`capped`、`reason`、`minimum`。**当天余量被关键行动用完后不再排节奏块**，`notes` 里会说明。
- `weekPlan.blocks` 每块额外带 `date`、`weekday`、`placedBy`（`class` = 跟着课表排的课前/课后，`weekend` = 周末深度复习）和 `classTime`（`{start, end, location}`，周末块为 `null`）。
- `overrides` 回显这次实际生效的覆盖值，方便界面说明「这是试算结果」。反复调这个接口不会改记录；想固定下来就调 `PUT /api/state`。

### GET / POST /api/v1/schedule/availability

可用时间的口径只有一处：`lib/balance.ts` 的 `availabilityOf`。记录过的天数以记录为准（`recorded`），没记录过的按课表和可支配窗口推算（`suggestedFree`），`effective` 是两者取小并夹到一天 1440 分钟。

- `GET ?date=2026-09-23`：返回这一周的可用时间视图 —— `availability`（可支配窗口）、`timetable`（每项额外带 `courseName`）、`days[7]`（每天的 `weekday`、`weekdayName`、`classes`、`classMinutes`、`windowMinutes`、`suggestedFree`、`recorded`、`effective`、`mode`），以及 `revision` 和 `persisted:false`。
- `POST`：`{"revision": 12, "timetable": [...], "availability": {...}, "days": [{"date":"2026-09-23","free":90,"energy":"medium"}]}`。`revision` 必填（首次写入用 0）；三个可写字段都可选，**不传的字段保持原样**（不会顺手清空课表）。合并后的整份记录要先过 `stateSchema`：课表引用了不存在的课程、下课时间不晚于上课时间、可用窗口结束早于开始、作业的前置指向自己或指向不存在的作业，都会返回 400 并把那条中文说明原样给出来（如「下课时间必须晚于上课时间」）。保存成功返回 `persisted:true` 和周视图；`revision` 过期返回 409 `conflict`，界面应先刷新再重试。

```js
const saved = await fetch("/api/v1/schedule/availability", {
  method: "POST", credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ revision, days: [{ date: "2026-09-23", free: 45 }] })
});
```

`days` 最多 31 天，`timetable` 最多 60 条。

### POST /api/v1/knowledge/highlights

提炼「本周重点 / 高频考点 / 未掌握点」。素材是：勾选的资料里已解析出来的正文（带原文位置）、用户粘贴的文本、卡点记录、做错过的题。**全部按规则生成，不调用任何模型**，所以每条重点都能指回原句。

请求（GET 同名字段用查询参数；`materialIds` 在 GET 里是逗号分隔的 id 串）：

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `courseId` | ≤80 字 | 只取这门课的资料、卡点和错题 |
| `date` | `YYYY-MM-DD`，默认今天 | 只用于回显周次 |
| `materialIds` | 最多 6 个 | 勾选的资料；重复的 id 由服务端去重 |
| `text` | ≤20000 字 | 直接粘贴的讲义要点 |
| `includeGaps` / `includeAttempts` | 布尔 | 默认为 `true`；关掉就不带卡点 / 错题 |
| `maxBlocksPerMaterial` | 1–200，默认 200 | 每份资料最多取多少块正文 |

响应（节选）：`highlights[]` 每条有 `kind`（`key` / `frequent` / `unmastered`）、`label`、`detail`、`evidence`、`courseId`、`score`、`signals[]`（为什么挑中它，界面直接显示）、`source`（`materialId`、`locator`、`locatorKind`、`locatorValue`、`heading`）和稳定的 `id`（同输入同 id，可安全去重）。另外还有 `counts`、`kinds`（三类的名字、解释和上限，客户端不用自己维护文案）、`notes`、`scanned{blocks,lines,gaps,attempts}`、`materials[]`（每份取到几块、是否被截断）、`skipped[]`、`sources[]`（最多 40 条去重后的来源位置）和 `limits`。

- 进不去上下文的资料会出现在 `skipped` 里并说明原因：`material_not_found`（找不到或不属于你）、`not_ready`（还没解析完成）、`no_blocks`（没有可用正文）。**`needs_ocr` 的资料也算 `not_ready`**，配置并成功运行 OCR 后会自动转为 `ready`，进入上下文。
- 上限是 6 / 6 / 6 条、总数 15 条，按分数从高到低。同一条可以同时出现在「本周重点」和「高频考点」里（两种视角，有意为之），但同一类里不会重复。
- **结果不落库**：提炼出来的是候选。用户点「加入知识点」后，才会作为 `state.knowledgePoints` 走 `PUT /api/state` 保存。

### GET / POST /api/v1/explain

「重点讲解」：按带教老师的顺序输出四段 —— 先讲框架、再讲机制与因果、再举例、最后用问题检查理解。

- `GET`：说明当前用的是哪个 provider、四段是哪四段、有没有配置真实模型。返回 `style`、`defaultModel`、`sections[4]`、`ai`（`{configured, kind, provider, model, hint}`，**不含密钥也不回显服务地址**）、`limits` 和一句说明。界面用它决定要不要显示「配置模型」的提示。
- `POST`：`{"topic": "每搏输出量的影响因素", "question": "为什么心率快时每搏输出量不一定增加？", "courseId": "physiology", "materialIds": ["m1"], "points": [{"label":"前负荷","detail":""}], "text": "…"}`。`topic` 必填且 ≤200 字，`question` ≤600 字，`points` 最多 12 条，`text` ≤20000 字。

响应（节选）：

```json
{ "apiVersion": "v1", "topic": "…", "question": "…",
  "engine": "template", "provider": "local-template", "model": "", "ok": false,
  "error": "not_configured",
  "sections": [{ "key": "framework", "title": "1、先讲框架", "body": "", "bullets": ["…"] }],
  "followUps": ["…"], "notice": "当前使用本地模板：…", "hint": "要接入真实模型，请在服务端配置 AI_BASE_URL…",
  "ms": 3, "ai": { "configured": false }, "sources": [], "materials": [], "skipped": [], "notes": [] }
```

- **没有配置模型时页面也不会空白**：`engine:"template"`、`ok:false`、`error:"not_configured"`，四段照样给全，`notice` 说明这是规则生成的脚手架，`hint` 告诉运维在哪儿配。本地模板只给「思考脚手架 + 用户资料里的原句」，**不编造剂量、首选处理或指南推荐**；资料里没有的部分它会明说资料里没有。
- 配好模型后同一个接口直接换成模型生成（`engine:"http"`、`ok:true`），四段结构和编号仍由服务端保证。模型少给段落时用本地模板补齐，并在 `notice` 里如实说明补了几段；模型返回的内容切不出四段时整体退回本地模板（`error:"bad_response"`），而不是把半截原文丢给用户。
- `error` 是稳定错误码：`not_configured`、`timeout`、`upstream_unavailable`、`upstream_rejected`、`bad_response`、`empty_response`、`template_missing`。文案表在 `lib/ai-provider.ts` 的 `aiErrorInfo`。

接入方式、环境变量和仍需人工 / 外部服务的部分见 [docs/COACH_AI.md](COACH_AI.md)。

## 题库数据与后续 AI 接口

题目在 `state.questions`，答题记录在 `state.attempts`，仍通过带 revision 的状态接口保存。新字段有空数组默认值，兼容旧记录。每题有 id、courseId、prompt、options（2–6 项）、correctIndex（从 0 开始）、explanation、source。导入最多 200 题；总题量上限 1000。

候选知识点和候选题的表（`material_knowledge_points`、`material_candidates`）已经建好但还没有接口。候选题须通过 `questionInputSchema` 校验并由用户确认后写入。客户端不能持有模型密钥。单选评分直接比较选项索引，不依赖模型。外部服务认证仍需另行实现。
