import test from "node:test";
import assert from "node:assert/strict";
import { aiConfigFrom, aiErrorInfo, aiStatus, aiTimeouts, defaultAiModel, deterministicProvider, httpProvider, providerFromConfig, providerFromEnv } from "../lib/ai-provider.ts";
import { explainLimits, explainPrompt, explainSectionNames, explainSectionOrder, explainTopic, localSections, parseSections, renderSections } from "../lib/explain.ts";

// 重点讲解有两层保障要在这里断言：
// 1) 没有配置模型时页面也不能空白——本地模板永远给得出四段，而且只给脚手架和资料原句，不编造医学结论；
// 2) 配置好模型后四段结构不变，模型少给的段落由本地模板补齐并如实说明。
// 外部调用全部用假的 fetch 断言（不发真实请求）：请求形状、错误码映射和「密钥不进返回值」都在这里盯住。

const topic = "每搏输出量的影响因素";
const modelText = [
  "1、先讲框架",
  "- 每搏输出量是一次心搏由一侧心室射出的血量",
  "- 它由前负荷、后负荷和收缩能力共同决定",
  "2、机制与因果",
  "- 前负荷增加，心肌初长度增加，收缩力增强",
  "3、举例",
  "- 失血病人前负荷下降，每搏输出量随之下降",
  "4、问题检查",
  "- 说出前负荷和后负荷的区别",
].join("\n");
const fakeProvider = (response, kind = "http") => ({
  name: "fake",
  model: "fake-model",
  kind,
  status: () => ({ configured: true, kind: "http", provider: "fake", model: "fake-model", hint: "hint" }),
  generate: async () => response,
});
const okResponse = (text) => ({ ok: true, engine: "http", provider: "fake", model: "fake-model", text, ms: 12 });

/** 假的 fetch：只记录请求，按 handler 返回，不联网；顺手接住服务端的日志，好断言它没把密钥写出去。 */
async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const calls = [];
  const errors = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    return { result: await run(), calls, errors };
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

test("本地模板永远给得出四段：框架、机制与因果、举例、问题检查", () => {
  assert.deepEqual(explainSectionOrder, ["framework", "mechanism", "example", "check"]);
  const sections = localSections({ topic });
  assert.equal(sections.length, 4);
  assert.deepEqual(sections.map(section => section.key), explainSectionOrder);
  sections.forEach((section, index) => {
    assert.equal(section.title, index + 1 + "、" + explainSectionNames[section.key]);
    assert.ok(section.bullets.length > 0 && section.bullets.length <= 6);
    assert.ok(section.bullets.every(bullet => bullet.length > 0));
  });
  assert.ok(sections[3].bullets.some(bullet => bullet.includes(topic)));
});

test("本地模板不编造医学结论：没有资料就只有脚手架，有资料才引用原句", () => {
  const bare = renderSections(localSections({ topic }));
  assert.doesNotMatch(bare, /资料原句/);
  // 没有资料时不应该出现任何剂量、数值或「首选处理」这类结论。
  assert.doesNotMatch(bare, /\d+\s*(mg|ml|g|mmHg|mmol)/);
  assert.doesNotMatch(bare, /首选(处理|治疗)/);

  const context = ["前负荷是指心室舒张末期容积。", "心率加快通过交感神经激活增强心肌收缩力。", "急性心肌梗死的首选处理是尽快再灌注治疗。"].join("\n");
  const quoted = localSections({ topic, context });
  for (const key of ["framework", "mechanism", "example"]) {
    const section = quoted.find(item => item.key === key);
    assert.ok(section.bullets.some(bullet => bullet.startsWith("资料原句：") || bullet.includes("差别：")), key + " 应该引用资料原句");
  }
  assert.ok(quoted.find(item => item.key === "example").bullets.some(bullet => bullet.includes("首选处理")));
  // 「问题检查」只给检查方法，不引用资料——它考的是用户，不是资料。
  assert.ok(!quoted.find(item => item.key === "check").bullets.some(bullet => bullet.startsWith("资料原句")));
  // 引用的是用户自己的原句，不加评论、不改写。
  assert.ok(quoted.find(item => item.key === "framework").bullets.some(bullet => bullet.includes("前负荷是指心室舒张末期容积")));
});

test("模型输出能切回四段：标题、要点和正文各归各位", () => {
  const parsed = parseSections(modelText);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map(section => section.key), explainSectionOrder);
  assert.equal(parsed[0].title, "先讲框架");
  assert.deepEqual(parsed[0].bullets, ["每搏输出量是一次心搏由一侧心室射出的血量", "它由前负荷、后负荷和收缩能力共同决定"]);
  assert.equal(parsed[3].bullets[0], "说出前负荷和后负荷的区别");
  // 没有分段信息的回答整段放弃，交给调用方回退到本地模板。
  assert.deepEqual(parseSections("这是一段没有分段的回答。\n继续写下去。"), []);
  assert.deepEqual(parseSections(""), []);
});

test("没有配置模型时返回本地模板，并明确告诉用户在哪儿配", async () => {
  const result = await explainTopic(deterministicProvider, { topic, question: "为什么心率快时每搏输出量不一定增加？" });
  assert.equal(result.engine, "template");
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_configured");
  assert.equal(result.sections.length, 4);
  assert.match(result.notice, /本地模板/);
  assert.match(result.hint, /AI_BASE_URL/);
  assert.ok(result.followUps.length > 0);
  assert.equal(Number.isFinite(result.ms), true);
  assert.equal(result.question, "为什么心率快时每搏输出量不一定增加？");
});

test("配置好模型时四段由模型填，段落编号仍由本地保证", async () => {
  const result = await explainTopic(fakeProvider(okResponse(modelText)), { topic });
  assert.equal(result.engine, "http");
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.provider, "fake");
  assert.equal(result.model, "fake-model");
  assert.equal(result.notice, null);
  assert.deepEqual(result.sections.map(section => section.title), ["1、先讲框架", "2、机制与因果", "3、举例", "4、问题检查"]);
  assert.ok(result.sections[0].bullets.some(bullet => bullet.includes("每搏输出量是一次心搏")));
});

test("模型少给段落时用本地模板补齐，并如实说明补了几段", async () => {
  const partial = ["1、先讲框架", "- 只讲了框架", "2、机制与因果", "- 只讲了机制"].join("\n");
  const result = await explainTopic(fakeProvider(okResponse(partial)), { topic });
  assert.equal(result.engine, "http");
  assert.equal(result.ok, true);
  assert.match(result.notice, /有 2 段模型没有返回/);
  assert.equal(result.sections.length, 4);
  assert.equal(result.sections[0].body, "");
  assert.equal(result.sections[2].body, "（这一段模型没有返回，下面是本地模板）");
  assert.ok(result.sections[2].bullets.length > 0);
});

test("模型返回的内容切不出四段时回退到本地模板，而不是把原文丢给用户", async () => {
  const result = await explainTopic(fakeProvider(okResponse("这是一段没有分段的回答。")), { topic });
  assert.equal(result.engine, "template");
  assert.equal(result.ok, false);
  assert.equal(result.error, "bad_response");
  assert.match(result.notice, /没有按四段式/);
  assert.equal(result.sections.length, 4);
});

test("模型调用失败时按错误码给出中文说明，仍然返回四段", async () => {
  const failure = { ok: false, error: "timeout", ...aiErrorInfo.timeout, provider: "fake", model: "fake-model", ms: 3 };
  const result = await explainTopic(fakeProvider(failure), { topic });
  assert.equal(result.engine, "template");
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
  assert.equal(result.notice, aiErrorInfo.timeout.message);
  assert.match(result.notice, /超时/);
  assert.equal(result.sections.length, 4);
});

test("提示词把主题、四段标题和资料原文都带上，并按上限截断", async () => {
  const long = "很长的一段资料。".repeat(2000);
  const prompt = explainPrompt({ topic, courseName: "生理学", question: "为什么？", points: [{ label: "前负荷" }], context: long });
  assert.match(prompt, /主题：每搏输出量的影响因素/);
  assert.match(prompt, /课程：生理学/);
  assert.match(prompt, /我想问的问题：为什么？/);
  assert.match(prompt, /- 前负荷/);
  for (const key of explainSectionOrder) assert.ok(prompt.includes("「" + explainSectionNames[key] + "」"));
  assert.ok(prompt.length < long.length);
  assert.ok(prompt.includes(long.slice(0, explainLimits.maxContext)));
  assert.ok(!prompt.includes(long.slice(0, explainLimits.maxContext + 100)));

  // 超长主题按上限截断，不整段丢掉：仍要给出可用的四段。
  const result = await explainTopic(deterministicProvider, { topic: "超长主题".repeat(100), question: "问".repeat(1000) });
  assert.equal(result.topic, "超长主题".repeat(50));
  assert.equal(result.topic.length, explainLimits.maxTopic);
  assert.equal(result.question.length, explainLimits.maxQuestion);
  assert.equal(result.sections.length, 4);
});

test("环境变量读配置：只认 https 公网地址，密钥不进返回值", () => {
  assert.equal(aiConfigFrom(undefined).enabled, false);
  assert.equal(aiConfigFrom({}).enabled, false);
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk-secret" }).enabled, true);
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk-secret" }).model, defaultAiModel);
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com/", AI_API_KEY: "sk", AI_MODEL: "my-model" }).baseUrl, "https://api.example.com");
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk", AI_MODEL: "my-model" }).model, "my-model");
  // 没有密钥、或显式关掉，都当作没配置。
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com" }).enabled, false);
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk", AI_ENABLED: "false" }).enabled, false);

  const status = aiStatus(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk-secret", AI_MODEL: "m" }));
  assert.equal(status.configured, true);
  assert.equal(status.kind, "http");
  assert.equal(JSON.stringify(status).includes("sk-secret"), false, "状态里不能出现密钥");
  assert.equal(JSON.stringify(status).includes("api.example.com"), false, "状态里不回显服务地址");
  assert.equal(aiStatus(aiConfigFrom({})).kind, "template");
  assert.match(aiStatus(aiConfigFrom({})).hint, /AI_API_KEY/);
});

test("非 https 或指向本机 / 内网的地址一律当作没配置", () => {
  const rejected = [
    "http://api.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://192.168.1.10",
    "https://172.16.3.4",
    "https://172.31.255.1",
    "https://169.254.169.254",
    "https://0.0.0.0",
    "https://internal.local",
    "ftp://api.example.com",
  ];
  for (const AI_BASE_URL of rejected) {
    assert.equal(aiConfigFrom({ AI_BASE_URL, AI_API_KEY: "sk" }).enabled, false, AI_BASE_URL + " 不该被当成有效地址");
    assert.equal(aiConfigFrom({ AI_BASE_URL, AI_API_KEY: "sk" }).baseUrl, "");
  }
  // 相邻的公网网段不受影响。
  assert.equal(aiConfigFrom({ AI_BASE_URL: "https://172.32.0.1", AI_API_KEY: "sk" }).enabled, true);
});

test("等待上限可配：AI_TIMEOUT_MS 决定一次调用等多久，单次请求还能覆盖它", async () => {
  const configured = extra => aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk", ...extra });
  assert.equal(configured({}).timeoutMs, aiTimeouts.default);
  assert.equal(configured({ AI_TIMEOUT_MS: "30000" }).timeoutMs, 30000);
  assert.equal(configured({ AI_TIMEOUT_MS: "1000" }).timeoutMs, aiTimeouts.min, "写得太小会被下限兜住");
  assert.equal(configured({ AI_TIMEOUT_MS: "999999" }).timeoutMs, aiTimeouts.max);
  assert.equal(configured({ AI_TIMEOUT_MS: "abc" }).timeoutMs, aiTimeouts.default);
  // 超时提示里承诺的那个环境变量必须真的生效，否则报错信息就是在骗人。
  assert.match(aiErrorInfo.timeout.hint, /AI_TIMEOUT_MS/);

  const original = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = ms => { seen.push(ms); return original.call(AbortSignal, ms); };
  try {
    const config = configured({ AI_TIMEOUT_MS: "30000" });
    const ok = () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "答" }] }) });
    await withFetch(ok, () => httpProvider(config).generate({ task: "explain", system: "", messages: [] }));
    await withFetch(ok, () => httpProvider(config).generate({ task: "explain", system: "", messages: [] }, { timeoutMs: 6000 }));
    await withFetch(ok, () => httpProvider(config).generate({ task: "explain", system: "", messages: [] }, { timeoutMs: 1 }));
  } finally {
    AbortSignal.timeout = original;
  }
  assert.deepEqual(seen, [30000, 6000, aiTimeouts.min]);
});

test("默认调用本地模板，只有配置齐了才走 HTTP", () => {
  assert.equal(providerFromConfig(aiConfigFrom({})).kind, "template");
  assert.equal(providerFromConfig(aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk" })).kind, "http");
  assert.equal(providerFromEnv(undefined).kind, "template");
  assert.equal(deterministicProvider.kind, "template");
});

test("本地模板 provider 直接返回调用方给的兜底文本，没有兜底就明确报错", async () => {
  const withFallback = await deterministicProvider.generate({ task: "explain", system: "", messages: [], fallback: "本地四段" });
  assert.equal(withFallback.ok, true);
  assert.equal(withFallback.engine, "template");
  assert.equal(withFallback.text, "本地四段");
  const missing = await deterministicProvider.generate({ task: "explain", system: "", messages: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "template_missing");
  assert.match(missing.message, /没有可用的本地模板/);
});

test("HTTP provider 按 Anthropic Messages API 的形状发请求，只取 text 段", async () => {
  const config = aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk-secret", AI_MODEL: "claude-opus-5" });
  const { result, calls } = await withFetch(
    () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "第一段" }, { type: "thinking", text: "不该取这段" }, { type: "text", text: "第二段" }] }) }),
    () => httpProvider(config).generate({ task: "explain", system: "系统提示", messages: [{ role: "user", content: "问题" }], maxTokens: 999 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "第一段第二段");
  assert.equal(result.model, "claude-opus-5");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-secret");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { model: "claude-opus-5", max_tokens: 999, system: "系统提示", messages: [{ role: "user", content: "问题" }] });
  const documentCall = await withFetch(
    () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "OCR JSON" }] }) }),
    () => httpProvider(config).generate({ task: "ocr", system: "逐页转录", messages: [{ role: "user", content: "识别 PDF" }], documents: [{ mediaType: "application/pdf", data: "JVBERi0x", filename: "讲义.pdf" }] }),
  );
  const documentBody = JSON.parse(documentCall.calls[0].init.body);
  assert.deepEqual(documentBody.messages[0].content, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } },
    { type: "text", text: "识别 PDF" },
  ]);
});

test("HTTP provider 把上游错误映射成稳定错误码，不把响应体或密钥带回给用户", async () => {
  const config = aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk-secret" });
  const provider = httpProvider(config);
  const cases = [
    [401, "upstream_rejected"],
    [403, "upstream_rejected"],
    [500, "upstream_unavailable"],
    [429, "upstream_unavailable"],
  ];
  for (const [status, error] of cases) {
    const { result, errors } = await withFetch(
      () => ({ ok: false, status, json: async () => ({ error: { message: "上游回显里可能有密钥 sk-secret" } }) }),
      () => provider.generate({ task: "explain", system: "", messages: [] }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, error, "HTTP " + status);
    assert.equal(JSON.stringify(result).includes("sk-secret"), false);
    assert.match(result.hint, new RegExp("HTTP " + status));
    // 服务端日志只记状态码，不记响应体。
    assert.ok(errors.length >= 1);
    assert.ok(errors.every(line => !line.includes("sk-secret")), "日志里不能出现密钥：" + errors.join(" | "));
    assert.ok(errors.some(line => line.includes(String(status))));
  }
});

test("HTTP provider 把超时、坏响应和空响应分开报出来", async () => {
  const config = aiConfigFrom({ AI_BASE_URL: "https://api.example.com", AI_API_KEY: "sk" });
  const provider = httpProvider(config);
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const boom = await withFetch(() => { throw timeout; }, () => provider.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(boom.result.error, "timeout");
  const abort = await withFetch(() => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, () => provider.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(abort.result.error, "timeout");
  const network = await withFetch(() => { throw new TypeError("fetch failed"); }, () => provider.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(network.result.error, "upstream_unavailable");
  const bad = await withFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }), () => provider.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(bad.result.error, "bad_response");
  const empty = await withFetch(() => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "   " }] }) }), () => provider.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(empty.result.error, "empty_response");
  // 没配置好的 provider 不会发请求。
  const disabled = httpProvider(aiConfigFrom({}));
  const { result, calls } = await withFetch(() => ({ ok: true, status: 200, json: async () => ({}) }), () => disabled.generate({ task: "explain", system: "", messages: [] }));
  assert.equal(result.error, "not_configured");
  assert.equal(calls.length, 0);
});
