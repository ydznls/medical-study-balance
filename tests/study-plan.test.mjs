import test from "node:test";
import assert from "node:assert/strict";
import { addDays, dayState, demoState, weekOf, weekdayOf } from "../lib/balance.ts";
import { dayPlan, rhythmForDay, weekPlan, withPlanOverride } from "../lib/study-plan.ts";

// 计划生成要在三件事上说得住话：
// 1) 今天只给 1–3 个最关键行动，且总时长不超过今天的余量；
// 2) 前置没做完的作业不排，余量放不下前置时说清楚而不是硬排；
// 3) 课前 / 课后 / 周末深度这三种节奏块跟着课表走，时长能被解释。
// 临时覆盖（改余量、改模式）只能影响这次生成，不能改到保存的记录。

const date = "2026-09-23";
const sunday = addDays(date, 4);

test("今天最多 3 个行动，优先级连续编号，每个都带理由和时长", () => {
  const state = demoState(date);
  const plan = dayPlan(state, date);
  assert.ok(plan.actions.length >= 1 && plan.actions.length <= 3);
  plan.actions.forEach((action, index) => {
    assert.equal(action.priority, index + 1);
    assert.ok(action.minutes > 0);
    assert.ok(action.title.length > 0);
    assert.ok(action.reason.length > 0);
    assert.ok(action.minimum.length > 0);
    assert.ok(Array.isArray(action.waitingFor));
    assert.equal(typeof action.degrade, "string");
  });
  assert.equal(plan.date, date);
  assert.ok(plan.modeReason.length > 0);
  assert.ok(["normal", "busy", "exam"].includes(plan.mode));
  assert.equal(plan.availability.date, date);
});

test("任何余量下，今天的行动总时长都不超过今天剩下的时间", () => {
  for (const free of [0, 3, 5, 10, 25, 60, 180, 600]) {
    const state = demoState(date);
    state.days[date] = { ...dayState(state, date), free };
    const plan = dayPlan(state, date);
    const used = plan.actions.reduce((total, action) => total + action.minutes, 0);
    assert.ok(used <= free, `余量 ${free} 分钟时排出了 ${used} 分钟`);
  }
});

test("临近截止的作业排在复习前面，并说明为什么是它", () => {
  const state = demoState(date);
  state.assignments[0].due = date;
  const plan = dayPlan(state, date);
  assert.equal(plan.actions[0].kind, "assignment");
  assert.match(plan.actions[0].reason, /今天截止/);
});

test("前置没做完的作业今天不排，并留下一条能看懂的说明", () => {
  const state = demoState(date);
  state.assignments = [
    { id: "prereq", courseId: "biochemistry", title: "先读实验讲义", grade: "B", due: addDays(date, 10), estimate: 30, cap: 30, minimum: "读一遍", spent: 0, status: "open", blockedBy: [] },
    { id: "report", courseId: "biochemistry", title: "生化实验报告", grade: "A", due: date, estimate: 60, cap: 30, minimum: "补齐讨论", spent: 0, status: "open", blockedBy: ["prereq"] },
  ];
  const plan = dayPlan(state, date);
  const ids = plan.actions.map(action => action.sourceId);
  assert.ok(!ids.includes("report"), "前置没完成时不该排这份报告");
  assert.ok(plan.warnings.some(warning => /要等/.test(warning) && /先读实验讲义/.test(warning)));
});

test("全都排不出来时把最紧的前置本身提上来，且不超过今天的余量", () => {
  const state = demoState(date);
  // 只留一条被前置挡住的作业：报告今天截止（硬），前置还很远（不硬）——推荐只会给出报告。
  state.sessions = [];
  state.assignments = [
    { id: "prereq", courseId: "biochemistry", title: "先读实验讲义", grade: "B", due: addDays(date, 10), estimate: 30, cap: 30, minimum: "读一遍", spent: 0, status: "open", blockedBy: [] },
    { id: "report", courseId: "biochemistry", title: "生化实验报告", grade: "A", due: date, estimate: 60, cap: 30, minimum: "补齐讨论", spent: 0, status: "open", blockedBy: ["prereq"] },
  ];
  state.days[date] = { ...dayState(state, date), free: 10 };
  const plan = dayPlan(state, date);
  assert.equal(plan.actions.length, 1);
  const promoted = plan.actions[0];
  assert.equal(promoted.sourceId, "prereq");
  assert.equal(promoted.hard, true);
  assert.ok(promoted.minutes <= 10, `提上来的前置也只有 10 分钟可用，实际 ${promoted.minutes}`);
  assert.match(promoted.reason, /前置/);
  assert.match(promoted.reason, /2026-10-03 截止/);

  // 余量连最小的一段都放不下时，不给行动，只给一句能做点什么的话。
  state.days[date] = { ...dayState(state, date), free: 0 };
  const empty = dayPlan(state, date);
  assert.equal(empty.actions.length, 0);
  assert.ok(empty.warnings.some(warning => /余量/.test(warning)));
});

test("临时改余量只影响这次生成，不改动传入的记录", () => {
  const state = demoState(date);
  const before = JSON.stringify(state);
  const plan = dayPlan(state, date, { freeMinutes: 60 });
  assert.equal(plan.free, 60);
  assert.equal(JSON.stringify(state), before, "dayPlan 不该改到调用方的记录");

  const same = withPlanOverride(state, date, {});
  assert.equal(same, state, "没有覆盖时应该原样返回，不做无用的深拷贝");
  const changed = withPlanOverride(state, date, { freeMinutes: 30, energy: "low", mode: "exam" });
  assert.equal(changed.days[date].free, 30);
  assert.equal(changed.days[date].energy, "low");
  assert.equal(changed.weeks[weekOf(date)].mode, "exam");
  assert.equal(state.days[date].free, 90, "原记录里的可用时间不变");
});

test("余量被行动用完之后不再排节奏块，并明确说明为什么", () => {
  const state = demoState(date);
  const plan = dayPlan(state, date, { freeMinutes: 120 });
  const used = plan.actions.reduce((total, action) => total + action.minutes, 0);
  assert.equal(plan.totalMinutes, used + plan.rhythm.reduce((total, block) => total + block.minutes, 0));
  assert.ok(plan.rhythm.every(block => block.minutes > 0));
  // 只留 5 分钟：关键行动吃掉全部余量，节奏块给不出有意义的时长，就不排。
  const drained = dayPlan(state, date, { freeMinutes: 5 });
  assert.equal(drained.rhythm.length, 0);
  assert.equal(drained.totalMinutes, drained.actions.reduce((total, action) => total + action.minutes, 0));
  assert.ok(drained.notes.some(note => /余量已经给关键行动用完/.test(note)));
});

test("有课的日子给课前预习和课后复习，也给出降级提示", () => {
  const state = demoState(date);
  assert.equal(weekdayOf(date), 3, "演示记录把课排在当天（周三）");
  const plan = dayPlan(state, date);
  assert.deepEqual(plan.rhythm.map(block => block.kind), ["preview", "review"]);
  for (const block of plan.rhythm) {
    assert.equal(block.courseId, "biochemistry");
    assert.match(block.reason, /基准/);
    assert.ok(block.minimum.length > 0);
  }
  const busy = dayPlan(state, date, { mode: "busy" });
  assert.equal(busy.mode, "busy");
  assert.equal(busy.modeReason, "你手动选择了本周模式");
  assert.match(busy.actions[0].degrade, /忙周/);
});

test("周末给核心课的深度复习，不排非核心课", () => {
  const state = demoState(date);
  const plan = dayPlan(state, sunday);
  assert.equal(weekdayOf(sunday), 7);
  assert.ok(plan.rhythm.length > 0);
  for (const block of plan.rhythm) {
    assert.equal(block.kind, "deep");
    assert.equal(state.courses.find(course => course.id === block.courseId).core, true);
  }
  assert.deepEqual(plan.rhythm.map(block => block.courseId).sort(), ["biochemistry", "physiology"]);
});

test("一天里的节奏块有上限，不会因为课多就堆成看不见的负担", () => {
  const state = demoState(date);
  state.timetable = state.courses.slice(0, 3).map((course, index) => ({ id: "slot-" + index, courseId: course.id, weekday: weekdayOf(date), start: "0" + (8 + index) + ":00", end: "0" + (9 + index) + ":40", location: "" }));
  const blocks = rhythmForDay(state, date, "normal", 300);
  assert.equal(blocks.length, 6);
});

test("没有课表时说明预习复习是推算出来的", () => {
  const state = demoState(date);
  state.timetable = [];
  const plan = dayPlan(state, date);
  assert.deepEqual(plan.rhythm, []);
  assert.ok(plan.notes.some(note => /还没有填写课表/.test(note)));
});

test("本周计划覆盖周一到周日，每天给出可用时间和实际记录", () => {
  const state = demoState(date);
  const plan = weekPlan(state, date);
  assert.equal(plan.week, weekOf(date));
  assert.equal(plan.days.length, 7);
  plan.days.forEach((day, index) => {
    assert.equal(day.weekday, index + 1);
    assert.equal(day.date, addDays(plan.week, index));
    assert.ok(day.free >= 0 && day.suggested >= 0 && day.classMinutes >= 0);
    assert.equal(day.recorded, day.date === date ? 90 : null);
  });
  assert.equal(plan.totalMinutes, plan.blocks.reduce((total, block) => total + block.minutes, 0));
  for (const block of plan.blocks) {
    assert.ok(block.date >= plan.week && block.date <= addDays(plan.week, 6));
    assert.ok([1, 2, 3, 4, 5, 6, 7].includes(block.weekday));
    assert.ok(["class", "weekend"].includes(block.placedBy));
    assert.ok(block.minutes > 0);
  }
});

test("本周节奏：上过的课排课后复习，还没上的排课前预习", () => {
  const state = demoState(date);
  const plan = weekPlan(state, date);
  const classBlocks = plan.blocks.filter(block => block.placedBy === "class");
  assert.ok(classBlocks.length >= 2);
  for (const block of classBlocks) {
    assert.equal(block.kind, block.date < date ? "review" : "preview");
    assert.ok(block.classTime && block.classTime.start < block.classTime.end);
  }
  const weekend = plan.blocks.filter(block => block.placedBy === "weekend");
  assert.ok(weekend.length > 0);
  assert.ok(weekend.every(block => block.kind === "deep" && block.classTime === null));
});

test("本周额度已经做满的课，周末不再排满两小时", () => {
  const state = demoState(date);
  const week = weekOf(date);
  // 两门核心课的周额度都做满了。
  state.reviews = state.courses.filter(course => course.core).map((course, index) => ({ id: "r" + index, courseId: course.id, week, date, minutes: course.weeklyMinutes, framework: "", problems: "", recall: "", memory: "" }));
  const plan = weekPlan(state, date);
  assert.equal(plan.blocks.filter(block => block.placedBy === "weekend").length, 0);
  assert.ok(plan.courses.every(course => course.reviewed >= course.target));

  // 考试周例外：额度满了也保留深度复习（本周有周六、周日两天，两门核心课各一块）。
  state.weeks[week] = { mode: "exam", risk: "", reflection: "", adjustment: "", reviewed: false };
  const exam = weekPlan(state, date);
  assert.equal(exam.mode, "exam");
  assert.equal(exam.blocks.filter(block => block.placedBy === "weekend").length, 4);
  assert.ok(exam.notes.some(note => /考试周/.test(note)));
});

test("本周节奏超出容量时给出提示，被压缩的块也说明原因", () => {
  const state = demoState(date);
  state.settings.weeklyCapacity = 60;
  const plan = weekPlan(state, date);
  assert.ok(plan.totalMinutes > plan.capacity);
  assert.ok(plan.notes.some(note => /超过设定的 60 分钟容量/.test(note)));
  const capped = plan.blocks.filter(block => block.capped);
  if (capped.length) assert.ok(plan.notes.some(note => /余量不足被压缩/.test(note)));
});

test("每门课的本周统计和节奏块对得上", () => {
  const state = demoState(date);
  const plan = weekPlan(state, date);
  for (const course of plan.courses) {
    const blocks = plan.blocks.filter(block => block.courseId === course.courseId);
    assert.equal(course.blocks, blocks.length);
    assert.equal(course.minutes, blocks.reduce((total, block) => total + block.minutes, 0));
    assert.equal(course.mastery, state.courses.find(item => item.id === course.courseId).mastery);
    assert.equal(course.gaps, state.gaps.filter(gap => gap.courseId === course.courseId && gap.status !== "resolved").length);
  }
  assert.ok(plan.courses.some(course => course.daysToExam === 42));
});
