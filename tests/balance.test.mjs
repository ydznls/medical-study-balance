import test from "node:test";
import assert from "node:assert/strict";
import { blankState, demoState, dayState, recommend, weekOf, getMode, stateSchema } from "../lib/balance.ts";
const date = "2026-09-23";

test("recommendations never exceed three or the remaining daily budget", () => {
  for (const free of [0, 1, 2, 5, 15, 30, 90, 180]) {
    const state = demoState(date);
    state.days[date] = { ...dayState(state, date), free };
    const result = recommend(state, date);
    assert.ok(result.actions.length <= 3);
    assert.ok(result.actions.reduce((n, a) => n + a.minutes, 0) <= free);
  }
});
test("unrecorded sleep is not treated as observed sleep shortage", () => {
  const state = blankState();
  state.settings.sleepFloor = 9;
  assert.equal(recommend(state, date).low, false);
  state.days[date] = { ...dayState(state, date), sleep: 6, sleepRecorded: true };
  assert.equal(recommend(state, date).low, true);
});
test("urgent assignments outrank optional study", () => {
  const state = demoState(date);
  state.assignments[0].due = date;
  assert.equal(recommend(state, date).actions[0].kind, "assignment");
});
test("end of day stops recommendations without deleting work", () => {
  const state = demoState(date);
  state.days[date].doneForDay = true;
  assert.equal(recommend(state, date).actions.length, 0);
  assert.equal(state.assignments.length, 1);
});
test("completed and skipped actions are not immediately regenerated", () => {
  const state = demoState(date);
  state.days[date].completed.push("review:physiology");
  state.days[date].skips.push({ id: "closure:sample-class", reason: "没时间" });
  const ids = recommend(state, date).actions.map(a => a.id);
  assert.ok(!ids.includes("review:physiology"));
  assert.ok(!ids.includes("closure:sample-class"));
});
test("week rollover resets review budget and respects a manual exam mode", () => {
  const state = demoState(date);
  state.weeks[weekOf(date)] = { mode: "exam", risk: "", reflection: "", adjustment: "", reviewed: false };
  assert.equal(getMode(state, date).mode, "exam");
  assert.equal(weekOf("2026-09-27"), "2026-09-21");
  assert.equal(weekOf("2026-09-28"), "2026-09-28");
  assert.equal(getMode(state, "2026-09-28").mode, "normal");
});
test("duplicate active development roles and missing course references fail validation", () => {
  const state = demoState(date);
  assert.equal(stateSchema.safeParse(state).success, true);
  state.tracks[0].role = "main";
  assert.equal(stateSchema.safeParse(state).success, false);
  const broken = demoState(date);
  broken.sessions[0].courseId = "missing";
  assert.equal(stateSchema.safeParse(broken).success, false);
});
