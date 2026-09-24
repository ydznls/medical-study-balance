import test from "node:test";
import assert from "node:assert/strict";
import { demoState } from "../lib/balance.ts";
import { buildCoachContext, coachContextLimits, openGaps, wrongAttempts } from "../lib/coach-context.ts";
import { blocksToContext } from "../lib/material-task.ts";

// 上下文装配是「重点提炼」和「重点讲解」共用的入口，所以它必须对用户诚实两件事：
// 1) 只有解析好的资料才会进上下文，进不去的每一份都要说清楚为什么（找不到 / 还没解析完 / 没有正文）；
// 2) 每一条正文都能指回它的来源（materialId + 位置），并且有明确的份数、块数、字符数上限。
// 存储用假的 TaskStore 注入，不碰 D1。

const date = "2026-09-23";
const userId = "u1";
const task = (over = {}) => ({
  id: "t", userId, materialId: "m", courseId: "physiology",
  parseStatus: "ready", parseEngine: "txt", parseError: "", parseAttempts: 1, parseCursor: 0,
  generateStatus: "pending", generateEngine: "", generateError: "", generateAttempts: 0, generateCursor: 0,
  sourceSha256: "", byteSize: 0, pageCount: 1, blockCount: 0, truncated: 0, leaseUntil: "", createdAt: "", updatedAt: "",
  ...over,
});
const block = (materialId, ordinal, text, over = {}) => ({
  id: materialId + "-" + ordinal, taskId: "t-" + materialId, userId, materialId, courseId: "physiology", ordinal,
  locator: "幻灯片 " + ordinal, locatorKind: "slide", locatorValue: ordinal, heading: "", text, charCount: text.length,
  ...over,
});
/** 假的 TaskStore：只实现 buildCoachContext 用到的三个方法。entry.task === null 表示这本资料没有任务。 */
function fakeStore(entries) {
  const materials = {}, tasks = {}, blocks = {};
  for (const [id, entry] of Object.entries(entries)) {
    const courseId = entry.courseId ?? "physiology";
    materials[id] = { id, userId, courseId, name: entry.name ?? id, filename: "", contentType: "text/plain", size: 0, storageKey: "", url: "" };
    tasks[id] = entry.task === null ? null : task({ id: "t-" + id, materialId: id, courseId, ...entry.task });
    blocks["t-" + id] = entry.blocks ?? [];
  }
  return {
    materials,
    findMaterial: async (user, id) => (materials[id] && materials[id].userId === user ? materials[id] : null),
    findReusableTask: async (user, materialId) => tasks[materialId] ?? null,
    listBlocks: async (user, taskId, from, limit) => (blocks[taskId] ?? []).filter(item => item.ordinal >= from).slice(0, limit),
  };
}
const build = (entries, input = {}, state = demoState(date)) => buildCoachContext({ store: fakeStore(entries) }, userId, state, input);

test("解析好的资料进上下文：正文带来源，份数、块数和截断状态一并交代", async () => {
  const withHeading = block("m1", 1, "每搏输出量是指一次心搏由一侧心室射出的血量。", { heading: "心脏泵血功能", locator: "幻灯片 12", locatorKind: "slide", locatorValue: 12 });
  const plain = block("m1", 2, "影响每搏输出量的因素包括前负荷、后负荷和心肌收缩能力。");
  const result = await build({ m1: { name: "生理学讲义", blocks: [withHeading, plain] } }, { materialIds: ["m1"] });

  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks[0], {
    materialId: "m1", courseId: "physiology", locator: "幻灯片 12", locatorKind: "slide", locatorValue: 12,
    heading: "心脏泵血功能", text: withHeading.text,
  });
  assert.equal(result.blocks[1].heading, "");
  // 有标题的块带上【标题】，让提炼出来的重点能指回小节。
  assert.match(result.text, /【心脏泵血功能】每搏输出量是指/);
  assert.match(result.text, /影响每搏输出量的因素包括前负荷/);
  assert.deepEqual(result.materials, [{ materialId: "m1", courseId: "physiology", name: "生理学讲义", taskId: "t-m1", blocks: 2, truncated: false }]);
  assert.deepEqual(result.skipped, []);
  // 来源按出现顺序去重，同一位置只报一次。
  assert.deepEqual(result.sources, [
    { materialId: "m1", locator: "幻灯片 12", locatorKind: "slide", heading: "心脏泵血功能" },
    { materialId: "m1", locator: "幻灯片 2", locatorKind: "slide", heading: "" },
  ]);
  assert.deepEqual(result.notes, []);
});

test("进不去的资料各自说明原因，而不是悄悄少一份", async () => {
  const result = await build(
    {
      m2: { name: "还没解析完的讲义", task: { parseStatus: "running" }, blocks: [] },
      m3: { name: "扫描版扫描不到字", blocks: [] },
      m4: { name: "没有任务但解析过", task: null, blocks: [] },
    },
    { materialIds: ["m-missing", "m2", "m3", "m4"] },
  );
  assert.deepEqual(result.skipped.map(item => [item.materialId, item.reason]), [
    ["m-missing", "material_not_found"],
    ["m2", "not_ready"],
    ["m3", "no_blocks"],
    ["m4", "not_ready"],
  ]);
  for (const item of result.skipped) assert.ok(item.message.length > 0 && item.message.endsWith("。"));
  assert.equal(result.skipped[0].message, "找不到这份资料，或者它不属于你。");
  assert.equal(result.skipped[1].name, "还没解析完的讲义");
  assert.equal(result.materials.length, 0);
  assert.ok(result.notes.some(note => /选中的资料都没有解析好的正文/.test(note)));
  assert.ok(result.notes.some(note => /没有可用的资料正文/.test(note)));
});

test("最多取 6 份资料，重复的 id 只算一次", async () => {
  const entries = {}, ids = [];
  for (let index = 1; index <= 8; index++) {
    const id = "m" + index;
    entries[id] = { name: "讲义 " + index, blocks: [block(id, 1, "第 " + index + " 份资料的正文内容，够长到能被当成一行。")] };
    ids.push(id);
  }
  const result = await build(entries, { materialIds: [ids[0], ids[0], ...ids.slice(1)] });
  assert.equal(coachContextLimits.maxMaterials, 6);
  assert.equal(result.materials.length, 6);
  assert.deepEqual(result.materials.map(item => item.materialId), ids.slice(0, 6));
  assert.deepEqual(result.blocks.map(item => item.materialId), ids.slice(0, 6));
});

test("每份资料取的块数有上限，被截断时如实标记", async () => {
  const blocks = Array.from({ length: 10 }, (_, index) => block("m1", index + 1, "第 " + (index + 1) + " 块正文。"));
  const limited = await build({ m1: { blocks } }, { materialIds: ["m1"], maxBlocksPerMaterial: 3 });
  assert.deepEqual(limited.materials, [{ materialId: "m1", courseId: "physiology", name: "m1", taskId: "t-m1", blocks: 3, truncated: true }]);
  assert.deepEqual(limited.blocks.map(item => item.locatorValue), [1, 2, 3]);

  // 任务自己标记了截断时，即使块数没到上限也要告诉用户内容不全。
  const truncatedTask = await build({ m1: { blocks, task: { truncated: 1 } } }, { materialIds: ["m1"], maxBlocksPerMaterial: 10 });
  assert.equal(truncatedTask.materials[0].truncated, true);
  assert.equal(truncatedTask.blocks.length, 10);
  // 上限被夹在允许范围内，不给调用方一个 0 或超大的值。
  const clamped = await build({ m1: { blocks } }, { materialIds: ["m1"], maxBlocksPerMaterial: 0 });
  assert.equal(clamped.blocks.length, 1);
  assert.equal(clamped.materials[0].truncated, true);
});

test("贴进来的文本排在资料正文之后，并按 12000 字截断", async () => {
  const blocks = [block("m1", 1, "资料里的第一句正文。")];
  const pasted = "粘".repeat(20000);
  const result = await build({ m1: { blocks } }, { materialIds: ["m1"], text: "  " + pasted + "\n" });
  const flattened = blocksToContext({ pages: [{ materialId: "m1", courseId: "physiology", name: "m1", taskId: "t-m1", blocks, truncated: false }], skipped: [] });
  assert.equal(result.text, flattened.text + "\n" + "粘".repeat(12000));
  assert.equal(result.text.length - flattened.text.length - 1, 12000);
  assert.ok(result.text.startsWith(flattened.text));
  // 只有粘贴文本（没有资料）时也是可用上下文，不该报「没有可用正文」。
  const onlyText = await build({}, { text: "心电图的各个波段分别代表什么？" });
  assert.equal(onlyText.text, "心电图的各个波段分别代表什么？");
  assert.deepEqual(onlyText.notes, []);
});

test("blocksToContext 只截正文，不丢块：提炼仍能拿到后面块里的重点", () => {
  const many = Array.from({ length: 40 }, (_, index) => block("m1", index + 1, "第 " + (index + 1) + " 段正文。" + "补".repeat(500)));
  const context = blocksToContext({ pages: [{ materialId: "m1", courseId: "physiology", name: "m1", taskId: "t-m1", blocks: many, truncated: false }], skipped: [] });
  assert.equal(context.blocks.length, 40);
  assert.equal(context.text.length, 12000);
  assert.equal(context.blocks[39].locatorValue, 40);
  assert.ok(context.text.length < context.blocks.reduce((total, item) => total + item.text.length, 0));
});

test("来源最多 40 条，同一位置的重复块只报一次", async () => {
  const distinct = Array.from({ length: 60 }, (_, index) => block("m1", index + 1, "第 " + (index + 1) + " 块正文。"));
  const capped = await build({ m1: { blocks: distinct } }, { materialIds: ["m1"], maxBlocksPerMaterial: 200 });
  assert.equal(coachContextLimits.maxSources, 40);
  assert.equal(capped.sources.length, 40);
  assert.equal(new Set(capped.sources.map(item => item.materialId + "@" + item.locator)).size, 40);
  assert.equal(capped.blocks.length, 60, "来源有上限，但不该因此丢掉正文块");

  // 同一份资料里同一个位置出现多次时，来源只报一次（提炼仍然逐块处理）。
  const repeated = Array.from({ length: 3 }, (_, index) => block("m1", index + 1, "重复出现的同一句正文内容。", { locator: "幻灯片 1", locatorValue: 1 }));
  const deduped = await build({ m1: { blocks: repeated } }, { materialIds: ["m1"] });
  assert.deepEqual(deduped.sources, [{ materialId: "m1", locator: "幻灯片 1", locatorKind: "slide", heading: "" }]);
  assert.equal(deduped.blocks.length, 3);
});

test("卡点和错题默认带上，可以按课程过滤，也可以显式关掉", async () => {
  const state = demoState(date);
  state.gaps = [
    { id: "g1", courseId: "physiology", sessionId: "", question: "心电图各波段代表什么？", risk: "normal", status: "open", answer: "", created: date, knowledgePointId: "" },
    { id: "g2", courseId: "physiology", sessionId: "", question: "为什么心率快时每搏输出量不一定增加？", risk: "high", status: "open", answer: "", created: date, knowledgePointId: "" },
    { id: "g3", courseId: "biochemistry", sessionId: "", question: "糖酵解的关键限速酶是什么？", risk: "high", status: "open", answer: "", created: date, knowledgePointId: "" },
    { id: "g4", courseId: "physiology", sessionId: "", question: "这个问题已经弄明白了。", risk: "high", status: "resolved", answer: "", created: date, knowledgePointId: "" },
  ];
  const question = (id, courseId, prompt) => ({ id, courseId, prompt, options: ["甲", "乙", "丙"], correctIndex: 0, explanation: "", source: "", knowledgePointId: "", materialId: "" });
  state.questions = [question("q1", "physiology", "以下哪项不属于影响每搏输出量的因素？"), question("q2", "physiology", "心肌收缩能力指的是什么？"), question("q3", "biochemistry", "糖酵解的关键限速酶是哪一个？")];
  state.attempts = [
    { id: "a1", questionId: "q1", date, selected: 1, correct: false },
    { id: "a2", questionId: "q1", date, selected: 2, correct: false },
    { id: "a3", questionId: "q1", date, selected: 0, correct: true },
    { id: "a4", questionId: "q2", date, selected: 1, correct: false },
    { id: "a5", questionId: "q3", date, selected: 1, correct: false },
  ];
  const store = { m1: { blocks: [block("m1", 1, "资料正文。")] } };

  const all = await build(store, { materialIds: ["m1"] }, state);
  // 高风险排在前面，同一风险里保持记录顺序；已解决的不出现。
  assert.deepEqual(all.gaps.map(item => item.id), ["g2", "g3", "g1"]);
  assert.deepEqual(all.gaps.map(item => item.risk), ["high", "high", "normal"]);
  assert.ok(!all.gaps.some(item => item.id === "g4"));
  assert.deepEqual(all.attempts.map(item => [item.questionId, item.wrong]), [["q1", 2], ["q2", 1], ["q3", 1]], "答对的次数不计入，按题去重");
  assert.equal(all.attempts[0].prompt, "以下哪项不属于影响每搏输出量的因素？");
  assert.equal(all.attempts[0].courseId, "physiology");

  const scoped = await build(store, { materialIds: ["m1"], courseId: "biochemistry" }, state);
  assert.deepEqual(scoped.gaps.map(item => item.id), ["g3"]);
  assert.deepEqual(scoped.attempts.map(item => item.questionId), ["q3"]);

  const off = await build(store, { materialIds: ["m1"], includeGaps: false, includeAttempts: false }, state);
  assert.deepEqual(off.gaps, []);
  assert.deepEqual(off.attempts, []);
  // 关掉只是不带上记录，正文照旧。
  assert.equal(off.blocks.length, 1);
});

test("卡点和错题各自有数量上限", () => {
  const state = demoState(date);
  state.gaps = Array.from({ length: 40 }, (_, index) => ({ id: "g" + index, courseId: "physiology", sessionId: "", question: "卡点 " + index, risk: index % 2 ? "high" : "normal", status: "open", answer: "", created: date, knowledgePointId: "" }));
  state.questions = Array.from({ length: 30 }, (_, index) => ({ id: "q" + index, courseId: "physiology", prompt: "题 " + index, options: ["甲", "乙"], correctIndex: 0, explanation: "", source: "", knowledgePointId: "", materialId: "" }));
  state.attempts = Array.from({ length: 30 }, (_, index) => ({ id: "a" + index, questionId: "q" + index, date, selected: 1, correct: false }));
  assert.equal(openGaps(state).length, coachContextLimits.maxGaps);
  assert.equal(wrongAttempts(state).length, coachContextLimits.maxAttempts);
  // 上限之外，给多少要多少。
  assert.equal(openGaps(state, undefined, 3).length, 3);
  assert.equal(wrongAttempts(state, undefined, 4).length, 4);
});

test("没有正文也没有粘贴时，明确说清楚这次只剩自己的记录可用", async () => {
  const result = await build({}, {});
  assert.deepEqual(result.blocks, []);
  assert.equal(result.text, "");
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.skipped, []);
  assert.ok(result.notes.some(note => /没有可用的资料正文/.test(note) && /卡点和错题/.test(note)));
  // 没有任何输入时不该报「选中的资料都没解析好」——那是两份不同的说明。
  assert.ok(!result.notes.some(note => /选中的资料/.test(note)));
});
