import test from "node:test";
import assert from "node:assert/strict";
import { blankState, stateSchema } from "../lib/balance.ts";
import { availabilityInputSchema, dayValue, energyValues, explainInputSchema, highlightsInputSchema, idList, planInputSchema, planModes, realDate } from "../lib/coach-api.ts";
import { coachContextLimits } from "../lib/coach-context.ts";
import { explainLimits } from "../lib/explain.ts";

// 四个接口的输入契约就是这个系统的对外边界，所以越界该被挡在哪一条要写死在测试里：
// 多给的字段直接拒绝（防止前端把拼错的字段名当成生效）、分钟数和日期有明确范围、
// 资料份数 / 块数 / 重点条数的上限必须和逻辑里用的常量是同一个来源，不能各写一份。

const rejects = (schema, value, why) => assert.equal(schema.safeParse(value).success, false, why ?? "应该被拒绝：" + JSON.stringify(value));
const accepts = (schema, value) => assert.equal(schema.safeParse(value).success, true, "应该被接受：" + JSON.stringify(value));
const messagesOf = (schema, value) => {
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false, "应该被拒绝：" + JSON.stringify(value));
  return parsed.error.issues.map(issue => issue.message);
};

test("计划接口：字段可选但越界会被挡，多写字段也拒绝", () => {
  accepts(planInputSchema, {});
  accepts(planInputSchema, { date: "2026-09-23", availableMinutes: 0, energy: "low", mode: "auto" });
  accepts(planInputSchema, { availableMinutes: 1440 });
  assert.deepEqual(planModes, ["auto", "normal", "busy", "exam"]);
  assert.deepEqual(energyValues, ["low", "medium", "high"]);
  for (const mode of planModes) accepts(planInputSchema, { mode });

  rejects(planInputSchema, { availableMinutes: -1 });
  rejects(planInputSchema, { availableMinutes: 1441 });
  rejects(planInputSchema, { availableMinutes: 12.5 });
  rejects(planInputSchema, { availableMinutes: "30" });
  rejects(planInputSchema, { energy: "mid" });
  rejects(planInputSchema, { mode: "sprint" });
  rejects(planInputSchema, { date: "2026/09/23" });
  rejects(planInputSchema, { freeMinutes: 30 }, "availableMinutes 拼错成 freeMinutes 时不能当没写");
  rejects(planInputSchema, { date: "2026-09-23", free: 30 });

  // 没写的字段不能凭空出现，路由靠 `!==undefined` 判断「这次要不要覆盖」。
  const parsed = planInputSchema.parse({ availableMinutes: 25 });
  assert.deepEqual(parsed, { availableMinutes: 25 });
  assert.equal("date" in parsed, false);
  assert.equal("mode" in parsed, false);
});

test("日期既要形状对，也要真实存在", () => {
  accepts(dayValue, "2026-09-23");
  rejects(dayValue, "2026-9-23");
  rejects(dayValue, "26-09-23");
  rejects(dayValue, "2026-09-23T00:00:00Z");

  assert.equal(realDate("2026-09-23"), true);
  assert.equal(realDate("2024-02-29"), true, "2024 是闰年");
  assert.equal(realDate("2026-02-29"), false, "2026 不是闰年");
  assert.equal(realDate("2026-02-30"), false);
  assert.equal(realDate("2026-13-01"), false);
  assert.equal(realDate("2026-00-10"), false);
  assert.equal(realDate("2026-09-31"), false, "9 月只有 30 天");
  assert.equal(realDate("2026-9-3"), false);
  assert.equal(realDate("20260903"), false);
  assert.equal(realDate(""), false);
  assert.equal(realDate("abc"), false);
  // 形状对但日期不存在时，两个校验的结论要一致：先过形状，再被 realDate 挡掉。
  assert.equal(dayValue.safeParse("2026-02-30").success, true);
  assert.equal(realDate("2026-02-30"), false);
});

test("可用时间接口：必须带版本号，课表和按天记录都有上限", () => {
  accepts(availabilityInputSchema, { revision: 0 });
  accepts(availabilityInputSchema, { revision: 7, days: [{ date: "2026-09-23", free: 90, energy: "high" }] });
  accepts(availabilityInputSchema, { revision: 1, availability: { dayStart: "07:30", dayEnd: "23:00", bufferMinutes: 60 } });
  accepts(availabilityInputSchema, { revision: 1, timetable: [{ id: "s1", courseId: "physiology", weekday: 3, start: "08:00", end: "09:40", location: "三教" }] });

  rejects(availabilityInputSchema, {});
  rejects(availabilityInputSchema, { revision: -1 });
  rejects(availabilityInputSchema, { revision: 1.5 });
  rejects(availabilityInputSchema, { revision: 0, days: [{ date: "2026-09-23", free: 1441 }] });
  rejects(availabilityInputSchema, { revision: 0, days: [{ date: "2026-9-23" }] });
  rejects(availabilityInputSchema, { revision: 0, days: [{ date: "2026-09-23", energy: "low2" }] });
  rejects(availabilityInputSchema, { revision: 0, days: [{ date: "2026-09-23", free: 1.5 }] });
  rejects(availabilityInputSchema, { revision: 0, days: Array.from({ length: 32 }, (_, index) => ({ date: "2026-09-" + String(index + 1).padStart(2, "0") })) });
  accepts(availabilityInputSchema, { revision: 0, days: Array.from({ length: 31 }, (_, index) => ({ date: "2026-09-" + String(index + 1).padStart(2, "0") })) });
  rejects(availabilityInputSchema, { revision: 0, timetable: [{ id: "s1", courseId: "physiology", weekday: 8, start: "08:00", end: "09:40" }] });
  rejects(availabilityInputSchema, { revision: 0, timetable: [{ id: "s1", courseId: "physiology", weekday: 3, start: "7:30", end: "09:40" }] });
  rejects(availabilityInputSchema, { revision: 0, timetable: [{ id: "s1", courseId: "physiology", weekday: 3, start: "08:00", end: "24:00" }] });
  rejects(availabilityInputSchema, { revision: 0, timetable: [{ id: "s1", courseId: "physiology", weekday: 3, start: "08:00", end: "09:40", location: "x".repeat(61) }] });
  rejects(availabilityInputSchema, { revision: 0, availability: { dayStart: "07:30", dayEnd: "23:00", bufferMinutes: 241 } });
  rejects(availabilityInputSchema, { revision: 0, replace: true });

  const parsed = availabilityInputSchema.parse({ revision: 3 });
  assert.deepEqual(parsed, { revision: 3 }, "没带课表时不能顺手清空课表");
});

test("重点提炼接口：资料份数、粘贴长度和每份块数都跟着逻辑里的上限走", () => {
  accepts(highlightsInputSchema, {});
  accepts(highlightsInputSchema, { courseId: "physiology", date: "2026-09-23", materialIds: ["m1"], text: "一周要点", includeGaps: false, includeAttempts: true, maxBlocksPerMaterial: 50 });

  assert.equal(coachContextLimits.maxMaterials, 6);
  assertsMax(highlightsInputSchema, "materialIds", coachContextLimits.maxMaterials, id => "m" + id);
  assert.equal(coachContextLimits.maxBlocksPerMaterial, 200);
  rejects(highlightsInputSchema, { maxBlocksPerMaterial: 0 });
  rejects(highlightsInputSchema, { maxBlocksPerMaterial: 201 });
  accepts(highlightsInputSchema, { maxBlocksPerMaterial: 1 });
  accepts(highlightsInputSchema, { maxBlocksPerMaterial: coachContextLimits.maxBlocksPerMaterial });
  accepts(highlightsInputSchema, { text: "字".repeat(20000) });
  rejects(highlightsInputSchema, { text: "字".repeat(20001) });
  rejects(highlightsInputSchema, { courseId: "c".repeat(81) });
  rejects(highlightsInputSchema, { includeGaps: "false" });
  rejects(highlightsInputSchema, { materialId: "m1" }, "materialIds 拼错成 materialId 时不能当没写");
  rejects(highlightsInputSchema, { include_attempts: true });
});
/** 一个「刚好等于上限就接受、多一个就拒绝」的断言，避免把 6 这种数字抄两遍。 */
function assertsMax(schema, field, limit, make, required = {}) {
  accepts(schema, { ...required, [field]: Array.from({ length: limit }, (_, index) => make(index + 1)) });
  rejects(schema, { ...required, [field]: Array.from({ length: limit + 1 }, (_, index) => make(index + 1)) });
}

test("讲解接口：主题必填有上限，重点条数和正文长度都有边界", () => {
  accepts(explainInputSchema, { topic: "每搏输出量的影响因素" });
  accepts(explainInputSchema, { topic: "T", question: "为什么？", courseId: "physiology", date: "2026-09-23", materialIds: ["m1"], text: "讲义原文", points: [{ label: "前负荷", detail: "心室舒张末期容积" }] });

  rejects(explainInputSchema, {});
  rejects(explainInputSchema, { topic: "" });
  rejects(explainInputSchema, { topic: "题".repeat(explainLimits.maxTopic + 1) });
  accepts(explainInputSchema, { topic: "题".repeat(explainLimits.maxTopic) });
  rejects(explainInputSchema, { topic: "T", question: "问".repeat(explainLimits.maxQuestion + 1) });
  assert.equal(explainLimits.maxPoints, 12);
  assertsMax(explainInputSchema, "points", explainLimits.maxPoints, id => ({ label: "重点 " + id }), { topic: "T" });
  rejects(explainInputSchema, { topic: "T", points: [{ label: "" }] });
  rejects(explainInputSchema, { topic: "T", points: [{ label: "重点", detail: "细".repeat(601) }] });
  rejects(explainInputSchema, { topic: "T", text: "字".repeat(20001) });
  rejects(explainInputSchema, { topic: "T", style: "exam" }, "讲解风格由服务端固定，不接受请求方指定");

  // 只传主题时不能凭空多出字段，路由据此判断要不要去装配上下文。
  assert.deepEqual(explainInputSchema.parse({ topic: "T" }), { topic: "T" });
});

test("GET 查询参数里的资料 id：支持逗号分隔，去掉空项，最多取 6 个", () => {
  assert.equal(idList(null), undefined);
  assert.equal(idList(""), undefined);
  assert.deepEqual(idList("m1"), ["m1"]);
  assert.deepEqual(idList("m1,m2"), ["m1", "m2"]);
  assert.deepEqual(idList(" m1 , , m2 ,"), ["m1", "m2"]);
  assert.equal(idList("m1,m2,m3,m4,m5,m6,m7,m8").length, coachContextLimits.maxMaterials);
  // 不在这里去重：重复的 id 由装配上下文的 collectMaterialBlocks 统一去重。
  assert.deepEqual(idList("m1,m1"), ["m1", "m1"]);
});

test("落库前的整份记录校验：课表、可用时间和前置依赖都要说得通", () => {
  const course = { id: "physiology", name: "生理学", core: true, topics: "", mastery: 1, examDate: "", weight: 3, weeklyMinutes: 120 };
  const base = () => { const state = blankState(); state.courses = [course]; return state; };
  assert.equal(stateSchema.safeParse(base()).success, true, "空记录本身要合法");

  const withTimetable = base();
  withTimetable.timetable = [{ id: "s1", courseId: "biochemistry", weekday: 3, start: "08:00", end: "09:40", location: "" }];
  assert.match(messagesOf(stateSchema, withTimetable).join(" / "), /课表里的课程不存在/);

  const badRange = base();
  badRange.timetable = [{ id: "s1", courseId: "physiology", weekday: 3, start: "09:40", end: "09:40", location: "" }];
  assert.match(messagesOf(stateSchema, badRange).join(" / "), /下课时间必须晚于上课时间/);

  const badWindow = base();
  badWindow.availability = { dayStart: "23:00", dayEnd: "07:30", bufferMinutes: 60 };
  assert.match(messagesOf(stateSchema, badWindow).join(" / "), /可支配时间的结束必须晚于开始/);

  const selfBlocked = base();
  selfBlocked.assignments = [{ id: "a1", courseId: "physiology", title: "报告", grade: "A", due: "2026-09-30", estimate: 60, cap: 30, minimum: "", spent: 0, status: "open", blockedBy: ["a1"] }];
  assert.match(messagesOf(stateSchema, selfBlocked).join(" / "), /作业的前置依赖有误/);

  const dangling = base();
  dangling.assignments = [{ id: "a1", courseId: "physiology", title: "报告", grade: "A", due: "2026-09-30", estimate: 60, cap: 30, minimum: "", spent: 0, status: "open", blockedBy: ["a-missing"] }];
  assert.match(messagesOf(stateSchema, dangling).join(" / "), /作业的前置依赖有误/);

  const duplicated = base();
  duplicated.gaps = [
    { id: "g1", courseId: "physiology", sessionId: "", question: "第一个卡点", risk: "high", status: "open", answer: "", created: "2026-09-23", knowledgePointId: "" },
    { id: "g1", courseId: "physiology", sessionId: "", question: "重复 id 的卡点", risk: "normal", status: "open", answer: "", created: "2026-09-23", knowledgePointId: "" },
  ];
  assert.match(messagesOf(stateSchema, duplicated).join(" / "), /记录 ID 重复/);

  const ok = base();
  ok.timetable = [{ id: "s1", courseId: "physiology", weekday: 3, start: "08:00", end: "09:40", location: "三教 201" }];
  ok.days["2026-09-23"] = { free: 90, energy: "medium", sleep: 7.5, spent: 0, skips: [], completed: [], doneForDay: false };
  assert.equal(stateSchema.safeParse(ok).success, true);

  // 整份记录不像四个接口那样 strict：多写的字段会被丢掉而不是报错。
  // 所以「写回时带的 revision」必须由可用时间接口自己校验，不能指望落库这一步兜底。
  const extra = stateSchema.safeParse({ ...ok, revision: 4 });
  assert.equal(extra.success, true);
  assert.equal("revision" in extra.data, false, "未知字段不能原样落库");
  assert.equal(availabilityInputSchema.safeParse({ revision: 4, state: ok }).success, false, "接口层不接受整份记录塞进来");
});
