import test from "node:test";
import assert from "node:assert/strict";
import { demoState } from "../lib/balance.ts";
import { rhythmBase, rhythmBlocksForCourse, rhythmBounds, rhythmFactors, rhythmKindNames, rhythmMinimums, rhythmMinutes, rhythmContextFor } from "../lib/study-rhythm.ts";

// 学习节奏的时长是「基准值 × 一个个能说清来由的系数」，再被上下限和当天余量夹取。
// 这里断言的是这套乘法本身：用户看到的每一个数字都必须能由 reason 里的那几句解释出来。

const date = "2026-09-23";
const plain = { mode: "normal", mastery: -1, daysToExam: null };
const minutes = (kind, ctx) => rhythmMinutes(kind, { ...plain, ...ctx }).minutes;
const labels = (kind, ctx) => rhythmMinutes(kind, { ...plain, ...ctx }).factors.map(factor => factor.label);

test("没有额外信息时给的就是基准时长：课前 10、课后 30、周末 120", () => {
  assert.deepEqual(rhythmBase, { preview: 10, review: 30, deep: 120 });
  assert.equal(minutes("preview"), 10);
  assert.equal(minutes("review"), 30);
  assert.equal(minutes("deep"), 120);
  // 掌握度未知（-1）不参与调整：宁可给基准值，也不要假装知道。
  assert.deepEqual(rhythmFactors("review", plain), []);
});

test("时长永远是 5 的整数倍，并且落在每种节奏自己的上下限里", () => {
  const modes = ["normal", "busy", "exam"];
  for (const kind of ["preview", "review", "deep"]) {
    const [min, max] = rhythmBounds[kind];
    for (const mode of modes) {
      for (const mastery of [-1, 0, 1, 2, 3]) {
        for (const daysToExam of [null, 3, 14, 60]) {
          for (const openGaps of [0, 4]) {
            const result = rhythmMinutes(kind, { mode, mastery, daysToExam, openGaps });
            assert.equal(result.minutes % 5, 0, `${kind} 的时长应该是 5 的倍数`);
            assert.ok(result.minutes >= min && result.minutes <= max, `${kind} 超出 ${min}–${max}`);
          }
        }
      }
    }
  }
});

test("掌握度越低时间越长，已经能应用时只做保持", () => {
  assert.equal(minutes("preview", { mastery: 0 }), 15); // 10 × 1.3 = 13 → 15
  assert.equal(minutes("preview", { mastery: 1 }), 10); // 10 × 1.15 = 11.5 → 10
  assert.equal(minutes("preview", { mastery: 3 }), 10); // 10 × 0.85 = 8.5 → 下限 5 后取整
  assert.equal(minutes("review", { mastery: 0 }), 40); // 30 × 1.3 = 39 → 40
  assert.equal(minutes("review", { mastery: 3 }), 25); // 30 × 0.85 = 25.5 → 25
  assert.match(labels("review", { mastery: 0 })[0], /还没有建立起印象/);
  assert.match(labels("review", { mastery: 3 })[0], /已经能应用/);
});

test("忙周压到最小闭环，考试周加大投入", () => {
  assert.equal(minutes("preview", { mode: "busy" }), 5);
  assert.equal(minutes("review", { mode: "busy" }), 20);
  assert.equal(minutes("deep", { mode: "busy" }), 60);
  assert.equal(minutes("review", { mode: "exam" }), 35);
  assert.equal(minutes("deep", { mode: "exam" }), 145);
  assert.match(labels("deep", { mode: "busy" }).join(" "), /最小闭环/);
});

test("距考试越近投入越大，还很久就只保持", () => {
  assert.equal(minutes("review", { daysToExam: 3 }), 40); // 30 × 1.3 = 39 → 40
  assert.equal(minutes("review", { daysToExam: 20 }), 35); // 30 × 1.1 = 33 → 35
  assert.equal(minutes("review", { daysToExam: 60 }), 25); // 30 × 0.9 = 27 → 25
  assert.equal(minutes("review", { daysToExam: 7 }), 40);
  assert.equal(minutes("review", { daysToExam: 8 }), 35);
  // 考试已经过去的日子不按「考前」算。
  assert.equal(minutes("review", { daysToExam: -3 }), 30);
});

test("未关闭的卡点加长复习，但不掺进课前预习", () => {
  assert.equal(minutes("preview", { openGaps: 2 }), 10);
  assert.equal(minutes("review", { openGaps: 2 }), 35); // 30 × 1.15 = 34.5 → 35
  assert.equal(minutes("deep", { openGaps: 1 }), 140); // 120 × 1.15 = 138 → 140
  assert.deepEqual(rhythmFactors("preview", { ...plain, openGaps: 3 }), []);
  assert.match(labels("review", { openGaps: 3 })[0], /3 个未关闭卡点/);
});

test("系数叠加后会被上下限夹住，不会算出离谱的时长", () => {
  // 120 × 1.3（未建立印象）× 1.2（考试周）× 1.3（距考试 5 天）= 243.36
  assert.equal(minutes("deep", { mode: "exam", mastery: 0, daysToExam: 5 }), 240);
  assert.equal(minutes("preview", { mode: "busy", mastery: 3, daysToExam: 60 }), 5);
  assert.equal(rhythmBounds.deep[1], 240);
  assert.equal(rhythmBounds.preview[0], 5);
});

test("当天余量不够时先压缩，并如实说明为什么", () => {
  const tight = rhythmMinutes("review", { ...plain, freeMinutes: 12 });
  assert.equal(tight.capped, true);
  assert.equal(tight.minutes, 10);
  assert.ok(tight.minutes <= 12);
  assert.match(tight.reason, /今天只剩 12 分钟可用/);
  const tighter = rhythmMinutes("review", { ...plain, freeMinutes: 3 });
  assert.equal(tighter.minutes, 5);
  const none = rhythmMinutes("review", { ...plain, freeMinutes: 0 });
  assert.equal(none.minutes, 0);
  assert.equal(none.capped, true);
  // 余量充足时不标记为压缩。
  const roomy = rhythmMinutes("review", { ...plain, freeMinutes: 120 });
  assert.equal(roomy.capped, false);
  assert.equal(roomy.minutes, 30);
  assert.doesNotMatch(roomy.reason, /今天只剩/);
});

test("reason 把基准值和每个系数都写成人话，界面直接显示这一句", () => {
  const result = rhythmMinutes("deep", { mode: "busy", mastery: 0, daysToExam: 10, openGaps: 2, freeMinutes: 45 });
  assert.match(result.reason, /周末深度复习基准 120 分钟/);
  assert.match(result.reason, /还没有建立起印象 ×1.3/);
  assert.match(result.reason, /忙周：只保留最小闭环 ×0.5/);
  assert.match(result.reason, /距考试 10 天 ×1.1/);
  assert.match(result.reason, /有 2 个未关闭卡点 ×1.15/);
  assert.match(result.reason, /今天只剩 45 分钟可用/);
  assert.match(result.reason, /→ 45 分钟/);
  assert.equal(result.minutes, 45);
  assert.equal(result.base, 120);
});

test("每门课都拿到课前 / 课后 / 深度三种节奏块，带各自的文案", () => {
  const state = demoState(date);
  const course = state.courses.find(item => item.id === "physiology");
  const blocks = rhythmBlocksForCourse(state, course, date, "normal", 200);
  assert.deepEqual(blocks.map(block => block.kind), ["preview", "review", "deep"]);
  assert.deepEqual(Object.keys(rhythmKindNames), ["preview", "review", "deep"]);
  for (const block of blocks) {
    assert.equal(block.courseId, "physiology");
    assert.equal(block.label, course.name + " · " + rhythmKindNames[block.kind]);
    assert.equal(block.minimum, rhythmMinimums[block.kind]);
    assert.ok(block.minimum.length > 0);
  }
  // 演示记录里生理学的掌握度是「有印象」，且距考试 42 天。
  const ctx = rhythmContextFor(state, course, date, "normal", 200);
  assert.equal(ctx.mastery, 1);
  assert.equal(ctx.daysToExam, 42);
  assert.equal(ctx.openGaps, 1);
  assert.equal(ctx.freeMinutes, 200);
  assert.equal(blocks[1].minutes, rhythmMinutes("review", ctx).minutes);
});
