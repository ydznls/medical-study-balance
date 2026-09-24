import test from "node:test";
import assert from "node:assert/strict";
import { blockLabel, canLoadMorePreview, describeTask, parseGate, previewFrom, shouldRunStep, taskPercent, taskStatusLabels, taskViewLimits } from "../lib/material-task-view.ts";

// 这些是资料卡片和预览对话框真正依赖的判断：状态怎么说、按钮该做什么、请求有没有上限。
// 没有装组件测试渲染器（也不打算为此加依赖），所以规则都放在 lib/material-task-view.ts 里直接断言。

test("没有任务时给的是空态，按钮是「开始解析」", () => {
  for (const task of [null, undefined]) {
    const view = describeTask(task);
    assert.equal(view.status, "none");
    assert.equal(view.label, "未解析");
    assert.equal(view.action, "start");
    assert.equal(view.canPreview, false);
    assert.equal(view.busy, false);
    assert.equal(view.percent, 0);
  }
});

test("五个状态都有中文标签，颜色语气各自独立", () => {
  const tones = ["pending", "running", "ready", "needs_ocr", "failed"].map((status) => describeTask({ parseStatus: status }).tone);
  assert.deepEqual(tones, ["idle", "busy", "ok", "warn", "bad"]);
  assert.deepEqual(Object.values(taskStatusLabels), ["未解析", "等待解析", "解析中", "已解析", "需要 OCR", "解析失败"]);
});

test("pending 显示「开始解析」，running 显示进度并给「继续解析」", () => {
  const pending = describeTask({ parseStatus: "pending" });
  assert.equal(pending.actionLabel, "开始解析");
  const running = describeTask({ parseStatus: "running", writtenBlocks: 3, totalBlocks: 10 });
  assert.equal(running.action, "run");
  assert.equal(running.actionLabel, "继续解析");
  assert.equal(running.busy, true);
  assert.equal(running.percent, 30);
  assert.equal(taskPercent({ parseStatus: "running", writtenBlocks: 3, totalBlocks: 10 }), 30);
  assert.match(running.detail, /3 \/ 10/);
});

test("进度不会越过 100%，总块数未知时也不会算出 NaN", () => {
  assert.equal(taskPercent({ parseStatus: "running", writtenBlocks: 12, totalBlocks: 10 }), 100);
  assert.equal(taskPercent({ parseStatus: "running", writtenBlocks: 5 }), 0);
  const view = describeTask({ parseStatus: "running", writtenBlocks: 5 });
  assert.equal(Number.isFinite(view.percent), true);
  assert.match(view.detail, /5 块/);
});

test("ready 才给预览，并且报出已落库的块数", () => {
  const view = describeTask({ parseStatus: "ready", writtenBlocks: 5, totalBlocks: 5, storedBlocks: 5, pageCount: 3 });
  assert.equal(view.label, "已解析");
  assert.equal(view.action, "none");
  assert.equal(view.canPreview, true);
  assert.equal(view.percent, 100);
  assert.match(view.detail, /5 块/);
  assert.match(view.detail, /3 页/);
});

test("ready 但库里没有块时不提供预览，也不显示成功文案", () => {
  const view = describeTask({ parseStatus: "ready", writtenBlocks: 0, totalBlocks: 0, storedBlocks: 0 });
  assert.equal(view.canPreview, false);
  assert.match(view.detail, /没有可展示的文本块/);
});

test("内容被截断时在说明里讲清楚", () => {
  const view = describeTask({ parseStatus: "ready", storedBlocks: 2000, totalBlocks: 2000, truncated: true, pageCount: 12 });
  assert.match(view.detail, /超过上限/);
});

test("needs_ocr 可以在配置服务后直接继续 OCR", () => {
  const view = describeTask({ parseStatus: "needs_ocr", needsOcr: true });
  assert.equal(view.action, "run");
  assert.equal(view.actionLabel, "尝试 OCR");
  assert.equal(view.tone, "warn");
  assert.match(view.detail, /OCR/);
  assert.equal(view.canPreview, false);
});

test("failed 用服务端的中文说明，按钮是重试", () => {
  const view = describeTask({ parseStatus: "failed", parseError: "corrupt_archive", parseMessage: "文件已损坏或没有上传完整，无法解析。" });
  assert.equal(view.action, "retry");
  assert.equal(view.actionLabel, "重试");
  assert.equal(view.detail, "文件已损坏或没有上传完整，无法解析。");
  // 服务端没给说明时也要有一句能看的话，不能把错误码当文案。
  assert.match(describeTask({ parseStatus: "failed", parseError: "corrupt_archive" }).detail, /可以重试/);
  assert.doesNotMatch(describeTask({ parseStatus: "failed", parseError: "corrupt_archive" }).detail, /corrupt_archive/);
});

test("一次点击的 run 步数有上限，跑不完就停", () => {
  const running = { parseStatus: "running" };
  assert.equal(shouldRunStep(running, 0), true);
  assert.equal(shouldRunStep(running, taskViewLimits.maxRunStepsPerClick - 1), true);
  assert.equal(shouldRunStep(running, taskViewLimits.maxRunStepsPerClick), false);
  assert.equal(shouldRunStep({ parseStatus: "pending" }, taskViewLimits.maxRunStepsPerClick), false);
  // 终态永远不再发请求，包括「没有任务」。
  assert.equal(shouldRunStep({ parseStatus: "needs_ocr" }, 0), true);
  for (const status of ["ready", "failed"]) assert.equal(shouldRunStep({ parseStatus: status }, 0), false);
  assert.equal(shouldRunStep(null, 0), false);
});

test("预览页数也有上限，到顶后不再请求", () => {
  assert.equal(canLoadMorePreview(0, true), true);
  assert.equal(canLoadMorePreview(taskViewLimits.maxPreviewPages - 1, true), true);
  assert.equal(canLoadMorePreview(taskViewLimits.maxPreviewPages, true), false);
  assert.equal(canLoadMorePreview(0, false), false);
});

test("预览分页按 ordinal 连续推进", () => {
  assert.equal(previewFrom(0), 1);
  assert.equal(previewFrom(1), taskViewLimits.previewPageSize + 1);
  assert.equal(previewFrom(4), 4 * taskViewLimits.previewPageSize + 1);
});

test("没有上传文件的链接资料给出空态原因，而不是坏掉的按钮", () => {
  assert.equal(parseGate({ hasFile: false, filename: "" }).ok, false);
  assert.match(parseGate({ hasFile: false }).reason, /链接资料/);
  assert.equal(parseGate({ hasFile: true, filename: "note.epub" }).ok, false);
  assert.match(parseGate({ hasFile: true, filename: "note.epub" }).reason, /暂不支持解析/);
  assert.equal(parseGate({ hasFile: true, filename: "note.PPTX" }).ok, true);
  assert.equal(parseGate({ hasFile: true, filename: "note.txt" }).ok, true);
  assert.equal(parseGate({ hasFile: true, filename: "书.pdf" }).reason, "");
});

test("预览条目的定位文字：有标题就带上，缺定位就退回序号", () => {
  assert.equal(blockLabel({ ordinal: 3, locator: "第 3 行", heading: "第一章" }), "第 3 行 · 第一章");
  assert.equal(blockLabel({ ordinal: 3, locator: "第 3 行", heading: "" }), "第 3 行");
  // 标题和定位重复时只显示一次。
  assert.equal(blockLabel({ ordinal: 3, locator: "幻灯片 3", heading: "幻灯片 3" }), "幻灯片 3");
  assert.equal(blockLabel({ ordinal: 7 }), "第 7 块");
});
