import test from "node:test";
import assert from "node:assert/strict";
import { createParseTask, listTaskBlocks, readParseTask, retryParseTask, runParseTask, taskLimits, taskErrorMessages, blockPageLimits } from "../lib/material-task.ts";
import { describeTask } from "../lib/material-task-view.ts";

// ---- 内存版 TaskStore：行为对齐 lib/task-store.ts 里的 D1 实现 ----
// 刻意保留真实表的一个性质：material_blocks 的 (task_id, ordinal) 没有唯一索引，
// 所以重复插入会产生重复行——去重只能靠 deleteBlockRange，不能靠数据库约束。
function memoryTaskStore() {
  const materials = new Map(), tasks = new Map(), blocks = [];
  return {
    materials, tasks, blocks,
    async findMaterial(userId, materialId) { const m = materials.get(materialId); return m && m.userId === userId ? { ...m } : null; },
    async getTask(userId, taskId) { const t = tasks.get(taskId); return t && t.userId === userId ? { ...t } : null; },
    async findReusableTask(userId, materialId) {
      const list = [...tasks.values()].filter((t) => t.userId === userId && t.materialId === materialId && ["pending", "running", "ready", "needs_ocr"].includes(t.parseStatus));
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return list.length ? { ...list[0] } : null;
    },
    async createTask(row) { if (tasks.has(row.id)) throw new Error("duplicate task id"); tasks.set(row.id, { ...row }); },
    async updateTask(taskId, patch) { const t = tasks.get(taskId); if (!t) throw new Error("missing task " + taskId); Object.assign(t, patch); },
    async claimTask(taskId, now, leaseUntil) {
      const t = tasks.get(taskId);
      if (!t) return false;
      if (t.parseStatus !== "pending" && t.parseStatus !== "running" && t.parseStatus !== "needs_ocr") return false;
      if (t.leaseUntil && t.leaseUntil > now) return false;
      t.parseStatus = "running";
      if (t.parseCursor === 0) t.parseAttempts += 1;
      t.leaseUntil = leaseUntil; t.updatedAt = now;
      return true;
    },
    async deleteBlocks(taskId) { for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].taskId === taskId) blocks.splice(i, 1); },
    async deleteBlockRange(taskId, from, to) { for (let i = blocks.length - 1; i >= 0; i--) { const b = blocks[i]; if (b.taskId === taskId && b.ordinal >= from && b.ordinal < to) blocks.splice(i, 1); } },
    async insertBlocks(rows) { for (const row of rows) blocks.push({ ...row }); },
    async countBlocks(taskId) { return blocks.filter((b) => b.taskId === taskId).length; },
    // 和 D1 实现一样，user_id 也进过滤条件，跨用户取块拿不到任何行。
    async listBlocks(userId, taskId, fromOrdinal, limit) {
      return blocks.filter((b) => b.taskId === taskId && b.userId === userId && b.ordinal >= fromOrdinal).sort((a, b) => a.ordinal - b.ordinal).slice(0, limit).map((b) => ({ ...b }));
    },
  };
}
const baseMaterial = { id: "m1", userId: "u1", courseId: "c1", name: "生理学讲义", filename: "note.txt", contentType: "text/plain", size: 32, storageKey: "k1", url: "" };
const DOCX = { filename: "生理学.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "生理学" };
const GARBAGE = new Uint8Array(64).fill(7);
const ZIPLIKE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)]);
function seed(store, overrides) {
  const material = { ...baseMaterial, ...overrides };
  store.materials.set(material.id, material);
  return material;
}
const txt = (s) => new Uint8Array(Buffer.from(s, "utf8"));
const pdf = (extra = "") => new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R " + extra + ">> endobj\n%%EOF\n", "latin1"));
const SCANNED = pdf(), TEXTY = pdf("/Resources << /Font << /F1 4 0 R >> >> ");
// 五个独立的块：源码里隔行留空，txt 解析器就会在行号不连续处断块。
const FIVE = txt("A\n\nB\n\nC\n\nD\n\nE");
function setup(bytes, overrides) {
  const store = memoryTaskStore();
  const material = seed(store, overrides);
  const objects = new Map([[material.storageKey, bytes]]);
  const deps = (extra = {}) => ({ store, loadObject: async (key) => objects.get(key) ?? null, ...extra });
  return { store, material, objects, deps };
}
async function createAndRun(store, deps, extra = {}) {
  const created = await createParseTask({ store }, "u1", "m1");
  assert.equal(created.ok, true);
  return runParseTask(deps(extra), "u1", "m1", created.task.id);
}

// ---- 创建幂等 ----
test("creating a task twice reuses the same task instead of piling up rows", async () => {
  const { store } = setup(FIVE);
  const first = await createParseTask({ store }, "u1", "m1");
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.task.parseStatus, "pending");
  assert.equal(first.task.parseAttempts, 0);
  assert.equal(first.task.storedBlocks, 0);
  const second = await createParseTask({ store }, "u1", "m1");
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
  assert.equal(store.tasks.size, 1);
});
test("a finished task is still reusable, so re-parsing needs no new row", async () => {
  const { store, deps } = setup(FIVE);
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "ready");
  const again = await createParseTask({ store }, "u1", "m1");
  assert.equal(again.created, false);
  assert.equal(again.task.id, run.task.id);
  assert.equal(again.task.parseStatus, "ready");
  assert.equal(again.task.parseEngine, "txt");
});
test("creating a task rejects links, unsupported formats and oversized files", async () => {
  const { store } = setup(FIVE);
  seed(store, { id: "m2", storageKey: "", url: "https://example.com/a.pdf" });
  seed(store, { id: "m3", filename: "book.epub", contentType: "application/epub+zip" });
  seed(store, { id: "m4", size: 21 * 1024 * 1024 });
  const noFile = await createParseTask({ store }, "u1", "m2");
  assert.equal(noFile.status, 400);
  assert.equal(noFile.error, "material_has_no_file");
  const unsupported = await createParseTask({ store }, "u1", "m3");
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.error, "unsupported_type");
  const tooLarge = await createParseTask({ store }, "u1", "m4");
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.error, "file_too_large");
  assert.equal(store.tasks.size, 0);
});

// ---- 跨用户 ----
test("another user cannot see, read, run or retry a task", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  const taskId = created.task.id;
  assert.equal((await createParseTask({ store }, "u2", "m1")).error, "material_not_found");
  assert.equal((await readParseTask({ store }, "u2", "m1", taskId)).error, "task_not_found");
  assert.equal((await runParseTask(deps(), "u2", "m1", taskId)).error, "task_not_found");
  assert.equal((await retryParseTask({ store }, "u2", "m1", taskId)).error, "task_not_found");
  assert.equal((await runParseTask(deps(), "u1", "m2", taskId)).error, "task_not_found");
  assert.equal(store.tasks.get(taskId).parseStatus, "pending");
  assert.equal(store.blocks.length, 0);
  const mine = await readParseTask({ store }, "u1", "m1", taskId);
  assert.equal(mine.ok, true);
  assert.equal(mine.task.id, taskId);
});

// ---- TXT 成功写块 ----
test("running a txt task writes blocks with ordinals, locators and ownership", async () => {
  const bytes = txt("第一行\n第二行\n\n第四行");
  const { store, deps } = setup(bytes);
  const run = await createAndRun(store, deps);
  assert.equal(run.ok, true);
  assert.equal(run.done, true);
  assert.equal(run.written, 2);
  assert.equal(run.task.parseStatus, "ready");
  assert.equal(run.task.parseEngine, "txt");
  assert.equal(run.task.parseError, "");
  assert.equal(run.task.parseMessage, "");
  assert.equal(run.task.needsOcr, false);
  assert.equal(run.task.totalBlocks, 2);
  assert.equal(run.task.storedBlocks, 2);
  assert.equal(run.task.writtenBlocks, 2);
  assert.equal(run.task.byteSize, bytes.length);
  assert.equal(run.task.truncated, false);
  assert.equal(run.task.leaseUntil, "");
  assert.equal(run.task.courseId, "c1");
  // sourceSha256 属于内部一致性信息，不对外暴露，从存储里核对。
  assert.match(store.tasks.get(run.task.id).sourceSha256, /^[0-9a-f]{64}$/);
  const rows = store.blocks.filter((b) => b.taskId === run.task.id).sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(rows.map((b) => b.ordinal), [1, 2]);
  assert.deepEqual(rows.map((b) => b.locator), ["第 1–2 行", "第 4 行"]);
  assert.deepEqual(rows.map((b) => b.text), ["第一行\n第二行", "第四行"]);
  assert.deepEqual(rows.map((b) => b.locatorKind), ["line", "line"]);
  assert.deepEqual(rows.map((b) => b.locatorValue), [1, 4]);
  assert.deepEqual(rows.map((b) => b.charCount), [rows[0].text.length, rows[1].text.length]);
  assert.equal(rows[0].userId, "u1");
  assert.equal(rows[0].materialId, "m1");
  assert.equal(rows[0].courseId, "c1");
  assert.equal(new Set(rows.map((b) => b.id)).size, 2);
});
test("rerunning a finished task changes nothing", async () => {
  const { store, deps } = setup(FIVE);
  const first = await createAndRun(store, deps);
  const second = await runParseTask(deps(), "u1", "m1", first.task.id);
  assert.equal(second.ok, true);
  assert.equal(second.done, true);
  assert.equal(second.written, 0);
  assert.equal(second.task.storedBlocks, 5);
  assert.equal(store.blocks.length, 5);
});

// ---- PDF ----
test("a scanned pdf lands on needs_ocr with no blocks and no fake success", async () => {
  const { store, deps } = setup(SCANNED, { filename: "课件.pdf", contentType: "application/pdf" });
  const created = await createParseTask({ store }, "u1", "m1");
  assert.equal(created.ok, true);
  const run = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(run.ok, true);
  assert.equal(run.done, true);
  assert.equal(run.written, 0);
  assert.equal(run.task.parseStatus, "needs_ocr");
  assert.equal(run.task.needsOcr, true);
  assert.equal(run.task.parseError, "");
  assert.equal(run.task.parseEngine, "pdf");
  assert.equal(run.task.totalBlocks, 0);
  assert.equal(run.task.storedBlocks, 0);
  assert.equal(run.task.pageCount, 1);
  assert.equal(store.blocks.length, 0);
  const again = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(again.ok, true);
  assert.equal(again.task.parseStatus, "needs_ocr");
  assert.equal(store.blocks.length, 0);
  assert.equal((await createParseTask({ store }, "u1", "m1")).created, false);
});
test("a text pdf is stored as page-addressable blocks", async () => {
  const textPdf = new Uint8Array(Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    + "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
    + "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"
    + "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
    + "5 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\nendstream endobj\n"
    + "trailer << /Root 1 0 R >>\n%%EOF\n", "latin1"));
  const { store, deps } = setup(textPdf, { filename: "课件.pdf", contentType: "application/pdf" });
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "ready");
  assert.equal(run.task.storedBlocks, 1);
  assert.equal(store.blocks[0].locator, "page:1");
  assert.equal(store.blocks[0].text, "Hello PDF");
});
test("a scanned pdf can be completed by an injected OCR provider", async () => {
  const { store, deps } = setup(SCANNED, { filename: "扫描课本.pdf", contentType: "application/pdf" });
  const created = await createParseTask({ store }, "u1", "m1");
  const run = await runParseTask(deps({ ocr: async (input) => ({
    pageCount: input.pageCount,
    blocks: [{ text: "OCR 读取出的正文", locator: "page:1", locatorKind: "page", locatorValue: 1, heading: "本页" }],
  }) }), "u1", "m1", created.task.id);
  assert.equal(run.task.parseStatus, "ready");
  assert.equal(run.task.parseEngine, "pdf+ocr");
  assert.equal(run.task.storedBlocks, 1);
  assert.equal(store.blocks[0].locator, "page:1");
  assert.equal(store.blocks[0].text, "OCR 读取出的正文");
});

// ---- 坏文件 ----
test("garbage bytes fail the task with a stable code and a readable message", async () => {
  const { store, deps } = setup(GARBAGE, DOCX);
  const created = await createParseTask({ store }, "u1", "m1");
  const run = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(run.ok, true);
  assert.equal(run.task.parseStatus, "failed");
  assert.equal(run.task.parseError, "content_type_mismatch");
  assert.equal(run.task.parseMessage, taskErrorMessages.content_type_mismatch);
  assert.ok(run.task.parseMessage.length > 0);
  assert.equal(run.task.needsOcr, false);
  assert.equal(store.blocks.length, 0);
  const repeated = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.error, "task_failed");
  assert.ok(repeated.message.length > 0);
});
test("a zip-like file that cannot be read fails as corrupt_archive, not as a crash", async () => {
  const { store, deps } = setup(ZIPLIKE, DOCX);
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "failed");
  assert.equal(run.task.parseError, "corrupt_archive");
  assert.equal(run.task.parseMessage, taskErrorMessages.corrupt_archive);
});
test("a material whose object is gone from R2 fails as storage_missing", async () => {
  const { store, deps } = setup(undefined);
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "failed");
  assert.equal(run.task.parseError, "storage_missing");
});
test("an empty object fails instead of producing a ready task with zero blocks", async () => {
  const { store, deps } = setup(new Uint8Array(0));
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "failed");
  assert.equal(run.task.parseError, "empty_file");
});
test("a whitespace only txt fails as empty_document rather than ready", async () => {
  const { store, deps } = setup(txt("   \n\n\t\n"));
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "failed");
  assert.equal(run.task.parseError, "empty_document");
  assert.equal(store.blocks.length, 0);
});

// ---- cursor / lease ----
test("a run respects its block budget and continues from the cursor", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  const first = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(first.written, 2);
  assert.equal(first.done, false);
  assert.equal(first.task.parseStatus, "running");
  assert.equal(first.task.writtenBlocks, 2);
  assert.equal(first.task.totalBlocks, 5);
  assert.equal(first.task.storedBlocks, 2);
  assert.equal(first.task.leaseUntil, "");
  const second = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(second.written, 2);
  assert.equal(second.done, false);
  assert.equal(second.task.storedBlocks, 4);
  const third = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(third.written, 1);
  assert.equal(third.done, true);
  assert.equal(third.task.parseStatus, "ready");
  assert.equal(third.task.storedBlocks, 5);
  const rows = store.blocks.filter((b) => b.taskId === created.task.id).sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(rows.map((b) => b.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.map((b) => b.text), ["A", "B", "C", "D", "E"]);
  assert.equal(store.blocks.length, 5);
});
test("rewinding the cursor rewrites the same range without duplicating blocks", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(store.blocks.length, 2);
  await store.updateTask(created.task.id, { parseCursor: 0 });
  const again = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(again.written, 2);
  assert.equal(store.blocks.length, 2);
  assert.equal(again.task.storedBlocks, 2);
});
test("a live lease blocks a concurrent run", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  await store.updateTask(created.task.id, { leaseUntil: new Date(Date.now() + 60_000).toISOString() });
  const busy = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(busy.ok, false);
  assert.equal(busy.status, 409);
  assert.equal(busy.error, "task_busy");
  assert.equal(store.blocks.length, 0);
  assert.equal(store.tasks.get(created.task.id).parseCursor, 0);
  assert.equal(store.tasks.get(created.task.id).parseAttempts, 0);
});
test("an expired lease can be taken over, and only a restart counts as an attempt", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  await store.updateTask(created.task.id, { leaseUntil: "2000-01-01T00:00:00.000Z" });
  const run = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(run.ok, true);
  assert.equal(store.tasks.get(created.task.id).parseAttempts, 1);
  await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(store.tasks.get(created.task.id).parseAttempts, 1);
  assert.ok(taskLimits.leaseSeconds > 0);
});
test("a changed file is refused between paged runs", async () => {
  const { store, deps, objects } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  const first = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(first.task.parseStatus, "running");
  objects.set("k1", txt("X\n\nY\n\nZ\n\nW\n\nV"));
  const second = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(second.task.parseStatus, "failed");
  assert.equal(second.task.parseError, "source_changed");
  assert.equal(store.blocks.length, 2);
});

// ---- retry ----
test("retry clears the old blocks, the cursor and any generated output", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createAndRun(store, deps);
  assert.equal(store.blocks.length, 5);
  await store.updateTask(created.task.id, { parseStatus: "failed", parseError: "extract_failed", generateStatus: "ready", generateEngine: "stub", generateCursor: 5 });
  const retried = await retryParseTask({ store }, "u1", "m1", created.task.id);
  assert.equal(retried.ok, true);
  assert.equal(retried.task.parseStatus, "pending");
  assert.equal(retried.task.parseError, "");
  assert.equal(retried.task.parseMessage, "");
  assert.equal(retried.task.writtenBlocks, 0);
  assert.equal(retried.task.totalBlocks, 0);
  assert.equal(retried.task.storedBlocks, 0);
  assert.equal(retried.task.generateStatus, "pending");
  assert.equal(store.tasks.get(created.task.id).generateCursor, 0);
  assert.equal(store.tasks.get(created.task.id).generateEngine, "");
  assert.equal(store.blocks.length, 0);
  const rerun = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(rerun.task.parseStatus, "ready");
  assert.equal(rerun.task.storedBlocks, 5);
  assert.deepEqual(store.blocks.map((b) => b.ordinal).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});
test("retry only applies to failed tasks", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  const pending = await retryParseTask({ store }, "u1", "m1", created.task.id);
  assert.equal(pending.status, 409);
  assert.equal(pending.error, "task_not_failed");
  const run = await runParseTask(deps(), "u1", "m1", created.task.id);
  assert.equal(run.task.parseStatus, "ready");
  assert.equal((await retryParseTask({ store }, "u1", "m1", created.task.id)).error, "task_not_failed");
  await store.updateTask(created.task.id, { parseStatus: "needs_ocr" });
  assert.equal((await retryParseTask({ store }, "u1", "m1", created.task.id)).error, "task_not_failed");
});
test("retry stops after the attempt limit", async () => {
  const { store, deps } = setup(GARBAGE, DOCX);
  const created = await createParseTask({ store }, "u1", "m1");
  for (let attempt = 0; attempt < taskLimits.maxParseAttempts; attempt++) {
    const run = await runParseTask(deps(), "u1", "m1", created.task.id);
    assert.equal(run.task.parseStatus, "failed");
    assert.equal(store.tasks.get(created.task.id).parseAttempts, attempt + 1);
    if (attempt < taskLimits.maxParseAttempts - 1) assert.equal((await retryParseTask({ store }, "u1", "m1", created.task.id)).ok, true);
  }
  const blocked = await retryParseTask({ store }, "u1", "m1", created.task.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, "retry_limit_reached");
  assert.equal(store.tasks.get(created.task.id).parseAttempts, taskLimits.maxParseAttempts);
});
test("a failed task can be parked and a fresh task created for the same material", async () => {
  const { store, deps } = setup(GARBAGE, DOCX);
  const failed = await createAndRun(store, deps);
  assert.equal(failed.task.parseStatus, "failed");
  const fresh = await createParseTask({ store }, "u1", "m1");
  assert.equal(fresh.ok, true);
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.task.id, failed.task.id);
  assert.equal(store.tasks.size, 2);
  const read = await readParseTask({ store }, "u1", "m1", failed.task.id);
  assert.equal(read.task.parseStatus, "failed");
  assert.equal(read.task.parseError, "content_type_mismatch");
});

// ---- 错误码 ----
test("every task error code has a readable message and the budgets stay bounded", () => {
  for (const [code, message] of Object.entries(taskErrorMessages)) assert.ok(message.length > 0, code + " 缺少说明");
  assert.ok(taskLimits.maxBlocksPerRun >= 1);
  assert.ok(taskLimits.maxBlocksPerRun <= 2000);
  assert.ok(taskLimits.maxCharsPerRun > taskLimits.maxBlocksPerRun);
  assert.ok(taskLimits.maxParseAttempts >= 1);
});

// ---- 分页读块（前端预览用的接口） ----
test("分页读块按 ordinal 升序，并如实报告还有没有下一页", async () => {
  const { store, deps } = setup(FIVE);
  const run = await createAndRun(store, deps);
  assert.equal(run.task.parseStatus, "ready");
  const first = await listTaskBlocks({ store }, "u1", "m1", run.task.id, { from: 1, limit: 2 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.page.blocks.map((b) => b.ordinal), [1, 2]);
  assert.equal(first.page.total, 5);
  assert.equal(first.page.hasMore, true);
  const middle = await listTaskBlocks({ store }, "u1", "m1", run.task.id, { from: 3, limit: 2 });
  assert.deepEqual(middle.page.blocks.map((b) => b.ordinal), [3, 4]);
  assert.equal(middle.page.hasMore, true);
  const last = await listTaskBlocks({ store }, "u1", "m1", run.task.id, { from: 5, limit: 2 });
  assert.deepEqual(last.page.blocks.map((b) => b.ordinal), [5]);
  assert.equal(last.page.hasMore, false);
  // 越界的一页是空数组，不是错误：前端翻到底不该看到报错。
  const beyond = await listTaskBlocks({ store }, "u1", "m1", run.task.id, { from: 99, limit: 2 });
  assert.equal(beyond.ok, true);
  assert.deepEqual(beyond.page.blocks, []);
  assert.equal(beyond.page.hasMore, false);
});

test("分页参数越界会被夹回合法区间", async () => {
  const { store, deps } = setup(FIVE);
  const run = await createAndRun(store, deps);
  const page = await listTaskBlocks({ store }, "u1", "m1", run.task.id, { from: 0, limit: 999 });
  assert.equal(page.page.from, 1);
  assert.equal(page.page.limit, blockPageLimits.max);
  // 不传参数时用默认页大小。
  const fallback = await listTaskBlocks({ store }, "u1", "m1", run.task.id);
  assert.equal(fallback.page.from, 1);
  assert.equal(fallback.page.limit, blockPageLimits.default);
  assert.ok(blockPageLimits.default <= blockPageLimits.max);
});

test("还没写完的任务只能看到已落库的那几块", async () => {
  const { store, deps } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  // 预算 2：只写入前两块，游标停在 2。
  const step = await runParseTask(deps({ maxBlocksPerRun: 2 }), "u1", "m1", created.task.id);
  assert.equal(step.done, false);
  assert.equal(step.task.parseStatus, "running");
  assert.equal(step.task.writtenBlocks, 2);
  assert.equal(step.task.storedBlocks, 2);
  assert.equal(step.task.totalBlocks, 5);
  const page = await listTaskBlocks({ store }, "u1", "m1", created.task.id, { from: 1, limit: 20 });
  assert.deepEqual(page.page.blocks.map((b) => b.ordinal), [1, 2]);
  assert.equal(page.page.total, 2);
  assert.equal(page.page.hasMore, false);
});

test("没开始的任务没有块可读", async () => {
  const { store } = setup(FIVE);
  const created = await createParseTask({ store }, "u1", "m1");
  const page = await listTaskBlocks({ store }, "u1", "m1", created.task.id);
  assert.equal(page.ok, true);
  assert.deepEqual(page.page.blocks, []);
  assert.equal(page.page.total, 0);
  assert.equal(page.page.hasMore, false);
});

test("读块同样挡住跨用户和错配的资料", async () => {
  const { store, deps } = setup(FIVE);
  const run = await createAndRun(store, deps);
  const read = (userId, materialId, taskId) => listTaskBlocks({ store }, userId, materialId, taskId, { from: 1, limit: 20 });
  const other = await read("u2", "m1", run.task.id);
  assert.equal(other.ok, false);
  assert.equal(other.status, 404);
  assert.equal(other.error, "task_not_found");
  // 任务存在，但路径里的资料 id 对不上，同样按 404 处理，不泄露任务归属。
  seed(store, { id: "m9", filename: "other.txt" });
  const mismatched = await read("u1", "m9", run.task.id);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error, "task_not_found");
  const missing = await read("u1", "m1", "no-such-task");
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "task_not_found");
});

test("服务端返回的任务视图能直接喂给界面规则", async () => {
  // 防漂移：describeTask 吃的是 lib/material-task-view.ts 里的 TaskSummary，
  // 这里用真实的服务端返回值跑一遍，字段被改名或删掉会在这里露出来。
  const { store, deps } = setup(FIVE);
  const run = await createAndRun(store, deps);
  const view = describeTask(run.task);
  assert.equal(view.status, "ready");
  assert.equal(view.canPreview, true);
  assert.equal(view.percent, 100);
  assert.match(view.detail, new RegExp(String(run.task.storedBlocks)));
  const failed = setup(GARBAGE, DOCX);
  const bad = await createAndRun(failed.store, failed.deps);
  const badView = describeTask(bad.task);
  assert.equal(badView.action, "retry");
  assert.equal(badView.detail, taskErrorMessages[bad.task.parseError]);
  const scanned = setup(SCANNED, { filename: "scan.pdf", contentType: "application/pdf" });
  const ocr = await createAndRun(scanned.store, scanned.deps);
  assert.equal(describeTask(ocr.task).tone, "warn");
});
