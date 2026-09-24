import test from "node:test";
import assert from "node:assert/strict";
import { extractHighlights, highlightKindNames, highlightLimits } from "../lib/highlights.ts";

// 重点提炼是规则做的，所以每条重点都必须交代清楚三件事：
// 它属于哪一类、为什么被挑中（signals）、以及它出现在原文的哪个位置（source）。
// 这里用一段真实形状的生理学讲义来断言：标题进「本周重点」、定义句和数值句进「高频考点」、
// 用户自己的疑问和错题进「未掌握点」。

const definition = "每搏输出量是指一次心搏由一侧心室射出的血量";
const quantity = "正常成人安静时每搏输出量约为 70 ml";
const block = {
  materialId: "m1",
  courseId: "physiology",
  locator: "幻灯片 12",
  locatorKind: "slide",
  locatorValue: 12,
  heading: "心脏泵血功能",
  text: [definition + "。", "影响每搏输出量的因素包括前负荷、后负荷和心肌收缩能力。", quantity + "。"].join("\n"),
};
const base = { courseId: "physiology", blocks: [block] };
const of = (result, kind) => result.highlights.filter(item => item.kind === kind);

test("标题进「本周重点」，定义句和数值句进「高频考点」，每条都带原文位置", () => {
  const result = extractHighlights(base);
  assert.deepEqual(Object.keys(highlightKindNames), ["key", "frequent", "unmastered"]);

  const heading = of(result, "key").find(item => item.label === "心脏泵血功能");
  assert.ok(heading, "小节标题应该被挑出来");
  assert.match(heading.detail, /小节标题/);
  assert.equal(heading.source.materialId, "m1");
  assert.equal(heading.source.locator, "幻灯片 12");
  assert.equal(heading.source.locatorKind, "slide");
  assert.equal(heading.source.locatorValue, 12);
  assert.equal(heading.source.heading, "心脏泵血功能");
  assert.equal(heading.evidence, "心脏泵血功能");

  const frequent = of(result, "frequent");
  assert.deepEqual(frequent.map(item => item.label).sort(), [definition, quantity].sort());
  const defineItem = frequent.find(item => item.label === definition);
  assert.ok(defineItem.signals.some(signal => /定义句/.test(signal)));
  assert.equal(defineItem.evidence, definition);
  assert.equal(defineItem.source.locator, "幻灯片 12");
  assert.equal(defineItem.source.locatorKind, "slide");
  assert.equal(defineItem.courseId, "physiology");
  assert.equal(defineItem.detail, detailFor(defineItem));

  const quantityItem = frequent.find(item => item.label === quantity);
  assert.ok(quantityItem.signals.some(signal => /数值或单位/.test(signal)));
  assert.ok(defineItem.score > quantityItem.score, "定义句比数值句更该被放在前面");

  // 没有考点句式的段落不硬凑：中间那句并列句没有考点信号，就不出现在任何一类里。
  assert.ok(!result.highlights.some(item => /前负荷、后负荷/.test(item.label)));
  assert.equal(result.scanned.blocks, 1);
});
/** detail 的固定形状：出自 + 位置 + （小节标题）+ 命中的信号。 */
function detailFor(item) {
  return "出自 " + item.source.locator + "《心脏泵血功能》 · " + item.signals.join(" / ");
}

test("资料没有可用正文时把原因说清楚，而不是给一个空列表", () => {
  const empty = extractHighlights({});
  assert.equal(empty.highlights.length, 0);
  assert.ok(empty.notes.some(note => /没有选中已解析的资料/.test(note)));
  assert.ok(empty.notes.some(note => /还没有未掌握的记录/.test(note)));

  const tooShort = extractHighlights({ ...base, blocks: [{ ...block, heading: "", text: "太短" }] });
  assert.equal(tooShort.highlights.length, 0);
  assert.equal(tooShort.scanned.lines, 0);
  assert.ok(tooShort.notes.some(note => /没有可用正文/.test(note)));

  // 只有标题也能给出本周重点，不会因为正文为空就整份丢掉。
  const onlyHeading = extractHighlights({ ...base, blocks: [{ ...block, text: "太短" }] });
  assert.deepEqual(onlyHeading.highlights.map(item => item.label), ["心脏泵血功能"]);
});

test("用户粘贴的疑问句进「未掌握点」，同时作为本周重点和考点", () => {
  const label = "为什么心率加快时每搏输出量不一定增加？";
  const result = extractHighlights({ text: label + "\n这条我完全不懂，课上没跟上。" });
  const kinds = result.highlights.filter(item => item.label === label).map(item => item.kind).sort();
  assert.deepEqual(kinds, ["frequent", "key", "unmastered"]);
  const maybe = of(result, "unmastered").find(item => item.label === label);
  assert.ok(maybe, "带问号的原句应该被保留下来，问号不能被切掉");
  assert.ok(maybe.signals.some(signal => /还没解决/.test(signal)));
  assert.equal(maybe.source.kind, "text");
  assert.equal(maybe.source.locator, "粘贴的文本");
  assert.equal(maybe.source.materialId, "");
  assert.ok(of(result, "unmastered").some(item => item.label === "这条我完全不懂，课上没跟上"));
});

test("卡点按风险排序，已解决的不再出现", () => {
  const high = "如何用自己的话解释每搏输出量的影响因素？";
  const normal = "心电图的各个波段分别代表什么？";
  const result = extractHighlights({
    gaps: [
      { id: "g1", courseId: "physiology", question: high, risk: "high", status: "open" },
      { id: "g2", courseId: "physiology", question: normal, risk: "normal", status: "open" },
      { id: "g3", courseId: "physiology", question: "这个问题已经弄明白了，不要再提醒我。", risk: "high", status: "resolved" },
    ],
  });
  const unmastered = of(result, "unmastered");
  assert.deepEqual(unmastered.map(item => item.label), [high, normal]);
  assert.equal(unmastered[0].detail, "高风险卡点 · 还没关闭");
  assert.equal(unmastered[1].detail, "卡点 · 还没关闭");
  assert.equal(unmastered[0].source.kind, "gap");
  assert.equal(unmastered[0].source.locator, "卡点记录");
  assert.equal(result.scanned.gaps, 2, "已解决的卡点不计入扫描数");
  assert.ok(!unmastered.some(item => /不要再提醒我/.test(item.label)));
});

test("错题按题去重，只保留做得最多的那一次", () => {
  const prompt = "以下哪项不属于影响每搏输出量的因素？";
  const result = extractHighlights({
    attempts: [
      { questionId: "q1", courseId: "physiology", prompt, wrong: 2 },
      { questionId: "q1", courseId: "physiology", prompt, wrong: 3 },
      { questionId: "q2", courseId: "biochemistry", prompt: "糖酵解的关键限速酶是哪一个？", wrong: 1 },
      { questionId: "q3", courseId: "physiology", prompt: "这是答对过的一道题，不该出现在这里。", wrong: 0 },
    ],
  });
  const unmastered = of(result, "unmastered");
  assert.deepEqual(unmastered.map(item => item.label), [prompt, "糖酵解的关键限速酶是哪一个？"]);
  assert.equal(unmastered[0].detail, "做错过 3 次 · 复习时用闭卷回忆重做");
  assert.equal(unmastered[0].courseId, "physiology");
  assert.equal(unmastered[1].courseId, "biochemistry");
  assert.equal(result.scanned.attempts, 2);
  assert.ok(!unmastered.some(item => /答对过的一道题/.test(item.label)));
});

test("三类重点各自有数量上限，总数也不超过上限", () => {
  const lines = Array.from({ length: 40 }, (_, index) => "考点 " + index + " 是指某种临床上常见的表现，需要与相邻概念鉴别。");
  const result = extractHighlights({ text: lines.join("\n") });
  assert.equal(result.counts.key, highlightLimits.key);
  assert.equal(result.counts.frequent, highlightLimits.frequent);
  assert.ok(result.counts.unmastered <= highlightLimits.unmastered);
  assert.ok(result.highlights.length <= highlightLimits.maxTotal);
  assert.equal(result.highlights.length, result.counts.key + result.counts.frequent + result.counts.unmastered);
  // 同一类里按分数从高到低，界面直接按顺序渲染。
  for (const kind of ["key", "frequent", "unmastered"]) {
    const list = of(result, kind);
    for (let index = 1; index < list.length; index++) assert.ok(list[index - 1].score >= list[index].score);
  }
  // 同一类里不会出现重复的重点（同一条可以同时属于「本周重点」和「高频考点」，这是有意的两种视角）。
  for (const kind of ["key", "frequent", "unmastered"]) {
    const labels = of(result, kind).map(item => item.label);
    assert.equal(new Set(labels).size, labels.length);
  }
});

test("同样的输入给出同样的 id，可以安全地用来去重", () => {
  const first = extractHighlights(base).highlights.map(item => item.id);
  const second = extractHighlights(base).highlights.map(item => item.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, "同一次结果里的 id 应该唯一");
  for (const id of first) assert.match(id, /^(key|frequent|unmastered):[a-z0-9]+$/);
});

test("打分与信号是同一份解释：每条重点都能说出为什么被挑中", () => {
  const result = extractHighlights({
    blocks: [{ ...block, heading: "", text: "急性心肌梗死的首选处理是尽快再灌注治疗。\n心肌收缩能力是指心肌不依赖于前后负荷而改变其收缩强度的能力。" }],
  });
  const frequent = of(result, "frequent");
  const clinical = frequent.find(item => /首选处理/.test(item.label));
  assert.ok(clinical.signals.some(signal => /诊断、治疗或首选处理/.test(signal)));
  const mechanism = frequent.find(item => /心肌收缩能力是指/.test(item.label));
  assert.ok(mechanism.signals.some(signal => /定义句/.test(signal)));
  assert.ok(clinical.score >= mechanism.score);
  assert.ok(frequent.every(item => item.signals.length > 0));
  assert.ok(frequent.every(item => item.detail.startsWith("出自 幻灯片 12")));
});
