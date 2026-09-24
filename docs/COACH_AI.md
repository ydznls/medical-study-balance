# 学习教练：AI 接入说明（给后续开发）

这一版把系统从「记录工具」推到「会判断现在该学什么的学习教练」：按时间可用性、紧急度、重要度、前置关系、预计耗时和恢复资源排出今天最多 3 个关键行动和本周的课前/课后/周末节奏，能把资料、卡点和错题提炼成重点，并按四段式回答「重点讲解」。除了「重点讲解」这一处，所有判断都是规则算出来的，没有模型参与。

**当前状态：不需要任何模型也能完整跑通。** 「重点讲解」默认走本地模板（`engine:"template"`），页面永远有内容；配置好服务端环境变量后，同一个接口直接换成模型生成，四段结构不变。

## 唯一接入点：lib/ai-provider.ts

模型调用只允许出现在 `lib/ai-provider.ts` 的 `httpProvider` 里，它是全仓库唯一的 `fetch` 外部地址的地方。其余文件只依赖 `AiProvider` 接口：

```ts
interface AiProvider {
  readonly name: string; readonly model: string; readonly kind: "template" | "http";
  status(): AiStatus;                                                    // 只说配没配好，不含密钥
  generate(request: AiRequest, options?: { timeoutMs?: number }): Promise<AiResponse>;
}
```

- `deterministicProvider`（默认）：不发任何请求，直接返回调用方传进来的 `fallback`（也就是本地四段模板）。没有 `fallback` 时返回 `template_missing`，这是调用方的错。
- `httpProvider(config)`：Anthropic Messages API 形状。`POST {baseUrl}/v1/messages`，请求头 `x-api-key` + `anthropic-version: 2023-06-01` + `content-type: application/json`，请求体 `{model, max_tokens, system, messages:[{role,content}]}`，取响应 `content[]` 里 `type === "text"` 的段拼接。
- `providerFromEnv(env)` / `providerFromConfig(config)`：配好了走 HTTP，没配好走本地模板。**任何调用方都从这里拿 provider，不要自己 new。**

换成官方 SDK 时只改 `httpProvider` 的函数体，调用方（`lib/explain.ts` 和路由）不需要动。

### 环境变量（只放服务端）

| 变量 | 说明 |
| --- | --- |
| `AI_BASE_URL` | 服务地址，必须是 **https 公网**。`http://`、`localhost`、`127.`、`10.`、`192.168.`、`172.16–31.`、`169.254.`、`0.`、`*.local` 一律当作没配置（防 SSRF） |
| `AI_API_KEY` | 密钥。只从服务端环境读，不进前端包、不进仓库、不回显给客户端 |
| `AI_MODEL` | 模型名，默认 `claude-opus-5` |
| `AI_ENABLED` | 填 `false` 可临时关掉模型，回到本地模板 |
| `AI_TIMEOUT_MS` | 一次调用的等待上限，默认 25000，夹在 5000–120000 |

四个变量由路由通过 `aiEnv()`（`app/api/v1/coach-routes.ts`，读 `cloudflare:workers` 注入的 env）传给 `providerFromEnv`。**地址来自服务端环境，不是请求体**，所以请求方无法把地址指到内网。

`aiStatus()` 的返回值只包含 `{configured, kind, provider, model, hint}`：没有密钥，也没有服务地址，可以直接给前端。

### 本地模板的边界（改动前请先读这一段）

`lib/explain.ts` 的 `localSections` 只产出两类内容：**思考脚手架**（「因果链：起因 → 中间环节 → 结果」「框架压缩：把这一节压到 5 个词以内」）和**用户资料里的原句**（前缀「资料原句：」，一字不改地引用）。它不写剂量、数值、首选处理或指南推荐——医学结论必须来自用户自己的资料或模型。没有资料时只给脚手架，并在 `notice` 里说明这是规则生成的脚手架，医学细节要用户自己补。

`explainTopic` 保证四段永远齐全：模型少给段落就用本地模板补齐并在 `notice` 里说明补了几段；模型返回的内容切不出四段（`parseSections` 少于 2 段）就整体退回本地模板并给出 `bad_response`，不会把半截原文给用户。

## 用户需要提供的数据

教练的判断质量取决于下面这些记录，缺哪一项就会在对应位置看到明确提示（而不是一个看起来合理的错误答案）：

| 数据 | 在哪里填 | 缺了会怎样 |
| --- | --- | --- |
| 课表：课程、星期几、起止时间、地点 | 「学习教练」→ 本周节奏 / 可用时间 | 课前预习和课后复习排不出来，`notes` 说明「还没有填写课表」 |
| 可支配窗口（几点到几点、固定开销分钟数） | 同上 | 按默认 07:30–23:00 扣 60 分钟推算 |
| 每天记录的可用时间和精力 | 「今日」或教练面板的调整 | 按课表推算 `suggestedFree`；估算不准 |
| 每门课的考试日期、权重、是否核心、周投入额度 | 课程设置 | 不会考前加大投入，周末不排深度复习 |
| 作业：截止日、预计耗时、上限、最低合格版本、前置作业 | 作业列表 | 前置关系只能从 `blockedBy` 得到；不填就没有「先做前置」的提醒 |
| 资料：上传 TXT / PPTX / DOCX 并解析 | 资料页 | 重点提炼和讲解没有正文可引用（PDF 见下） |
| 卡点记录、做题记录 | 「今日」的问题池 / 题库 | 「未掌握点」永远是空的 |
| 复习记录（框架压缩 / 问题池 / 闭卷回忆 / 长期记忆点） | 复习页 | 周额度按 0 算，周末会一直排深度复习 |
| 真实模型：`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 服务端环境变量 | 讲解用本地模板（可用的脚手架，但不是模型生成的内容） |

## 仍然需要外部服务或人工的部分

- **真实模型讲解**：不配环境变量就只有本地模板。**本地模板不包含任何医学结论**，它给的是四段式的思考顺序和用户资料里的原句。
- **PDF / OCR**：文字型 PDF 由解析层按页读取；扫描版 PDF 由服务端注入的 OCR provider 逐页转录。没有配置或调用失败时落 `needs_ocr`，不会伪造正文；配置后可在原任务上直接重跑，成功后就能进入重点提炼和讲解上下文。
- **重点提炼仍然是规则**：`lib/highlights.ts` 用信号表（定义句、数值、鉴别、首选处理、你自己的疑问）打分选句，好处是每条都能指回原文。`AiTask` 里预留了 `"highlights"` 和 `"plan"` 两种任务，目前只有 `"explain"` 接了 provider；要让模型参与提炼或规划，请沿用同一套接缝（provider 输出仍需落到能指回原文的 `source` 上，并保持 `notice` / `error` 的语义）。
- **候选题与知识点抽取**：`material_knowledge_points`、`material_candidates` 两张表已建好但没有接口。候选内容必须能展示来源、并由用户确认后才写入。
- **通知推送、跨时区**：仍未做。日期一律按 Asia/Shanghai 计算。
- **持久化**：这一版没有新增表和迁移（`drizzle/` 仍是 0000/0001/0002，**不要改这三个**）。重点提炼的结果不落库，用户点「加入知识点」后才作为 `state.knowledgePoints` 走 `PUT /api/state`。

## 怎么跑校验

TypeScript 和测试都要跑，两者都是纯逻辑、不联网：

```bash
# 类型检查
node node_modules/typescript/bin/tsc --noEmit

# 测试（本机 Node 20.13 不支持文档里的 --experimental-strip-types，用临时转译）
rm -rf dist/verify
node node_modules/typescript/bin/tsc --outDir dist/verify --rootDir . --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  --skipLibCheck --strict --types node,@cloudflare/workers-types lib/*.ts lib/extract/*.ts
mkdir -p dist/verify/tests
for f in tests/*.mjs; do sed 's|\.\./lib/\([A-Za-z0-9/_-]*\)\.ts|../lib/\1.js|g' "$f" > "dist/verify/tests/$(basename "$f")"; done
node --test dist/verify/tests/
rm -rf dist/verify   # 临时产物，不要提交
```

`--rootDir .` 不能省：没有它输出会拍平到 `dist/verify/*.js`，测试里的 `../lib/x.js` 就找不到。

踩过的两个坑，改代码时注意别踩回去：

- Next.js 的 `route.ts` 只允许导出 HTTP 方法和配置。输入 schema 放在 `lib/coach-api.ts` 才能被测试直接断言；`highlightKinds` 这类表在路由里也不能 `export`。
- 逻辑必须留在 `lib/` 的纯函数里才能被测到。本仓库没有装组件测试渲染器，也不为此新增依赖，所以组件（`app/coach-panel.tsx` 等）只做渲染，判断都在 `lib/`。

## 不要做的事

- 不新增网络依赖，不引入模型 SDK（要用官方 SDK 就替换 `httpProvider` 的函数体）。
- 不把密钥、登录会话、真实学习记录或本机数据库写进仓库或提交到公开仓库。
- 不让模型绕过已有的边界：时间容量、最多 3 个行动、睡眠底线、前置关系、用户确认后才写入记录。
- 不改 `drizzle/0000`、`0001`、`0002`；要加表就新增迁移。
