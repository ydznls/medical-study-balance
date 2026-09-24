import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { extractDocument, detectKind, extractLimits, ExtractError, probePdf } from "../lib/extract/index.ts";

// ---- 最小 ZIP 写入器：只用来造夹具，不参与生产路径 ----
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8"), raw = Buffer.from(file.data), method = file.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw, crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, eocd]));
}
const slide = (title, ...lines) => `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="x"><p:cSld><p:spTree><p:sp><p:txBody>`
  + [`<a:p><a:r><a:t>${title}</a:t></a:r></a:p>`, ...lines.map(l => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`)].join("")
  + `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const pptx = (slides) => buildZip([
  { name: "[Content_Types].xml", data: `<Types/>`, method: 0 },
  { name: "ppt/slides/_rels/slide1.xml.rels", data: `<Relationships/>` },
  ...slides,
]);
const docx = (body) => buildZip([
  { name: "[Content_Types].xml", data: `<Types/>`, method: 0 },
  { name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>` },
]);
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const txt = (s) => new Uint8Array(Buffer.from(s, "utf8"));
const run = (bytes, filename, contentType, limits) => extractDocument({ filename, contentType, bytes, limits });

// ---- TXT ----
test("txt keeps line numbers, merges adjacent lines and breaks at gaps", async () => {
  const merged = await run(txt("第一行\n第二行\n第三行"), "note.txt");
  assert.equal(merged.engine, "txt");
  assert.equal(merged.blocks.length, 1);
  assert.equal(merged.blocks[0].locator, "第 1–3 行");
  assert.equal(merged.blocks[0].locatorKind, "line");
  assert.equal(merged.blocks[0].locatorValue, 1);
  assert.equal(merged.blocks[0].ordinal, 1);
  assert.equal(merged.blocks[0].charCount, merged.blocks[0].text.length);
  const gapped = await run(txt("第一行\n\n第二行"), "note.txt");
  assert.deepEqual(gapped.blocks.map(b => b.locator), ["第 1 行", "第 3 行"]);
  assert.deepEqual(gapped.blocks.map(b => b.text), ["第一行", "第二行"]);
  assert.equal(gapped.needsOcr, false);
  assert.equal(gapped.truncated, false);
  assert.equal(gapped.pageCount, 0);
});
test("txt strips the BOM and warns on undecodable bytes", async () => {
  const bom = await run(txt(String.fromCharCode(0xfeff) + "标题"), "note.txt");
  assert.equal(bom.blocks[0].text, "标题");
  const bad = await run(new Uint8Array([0xff, 0xfe, 0x41]), "note.txt");
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /不是有效的 UTF-8/);
});
test("txt splits a single oversized line instead of dropping it", async () => {
  const out = await run(txt("abcdefghijklmnopqrstuvwxyz"), "note.txt", undefined, { maxBlockChars: 10 });
  assert.deepEqual(out.blocks.map(b => b.text), ["abcdefghij", "klmnopqrst", "uvwxyz"]);
  assert.deepEqual(out.blocks.map(b => b.locator), ["第 1 行", "第 1 行", "第 1 行"]);
  assert.deepEqual(out.blocks.map(b => b.ordinal), [1, 2, 3]);
  assert.deepEqual(out.blocks.map(b => b.charCount), [10, 10, 6]);
});

// ---- PPTX ----
test("pptx keeps slide numbers, sorted numerically, with a heading per slide", async () => {
  const out = await run(pptx([
    { name: "ppt/slides/slide1.xml", data: slide("循环系统", "心脏的泵血功能", "  ", "每搏输出量") },
    { name: "ppt/slides/slide2.xml", data: slide("血管", "动脉与静脉") },
    { name: "ppt/slides/slide10.xml", data: slide("呼吸系统", "肺通气") },
    { name: "ppt/slides/slide3.xml", data: slide("   ", "   ") },
  ]), "血液循环.pptx");
  assert.equal(out.engine, "pptx");
  assert.equal(out.pageCount, 4);
  assert.deepEqual(out.blocks.map(b => b.locator), ["第 1 张幻灯片", "第 2 张幻灯片", "第 10 张幻灯片"]);
  assert.deepEqual(out.blocks.map(b => b.locatorValue), [1, 2, 10]);
  assert.deepEqual(out.blocks.map(b => b.heading), ["循环系统", "血管", "呼吸系统"]);
  assert.equal(out.blocks[0].locatorKind, "slide");
  assert.equal(out.blocks[0].text, "循环系统\n心脏的泵血功能\n每搏输出量");
  assert.equal(out.blocks[0].text.includes("  "), false);
});

// ---- DOCX ----
test("docx keeps paragraph numbers including empty ones, and tracks Heading style", async () => {
  const out = await run(docx([
    para("循环系统", "Heading1"),
    para("心脏的泵血功能"),
    `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>`,
    para("每搏输出量与心率"),
  ].join("")), "生理学.docx");
  assert.equal(out.engine, "docx");
  assert.deepEqual(out.blocks.map(b => b.locator), ["第 1 段", "第 2 段", "第 4 段"]);
  assert.deepEqual(out.blocks.map(b => b.locatorValue), [1, 2, 4]);
  assert.deepEqual(out.blocks.map(b => b.heading), ["循环系统", "循环系统", "循环系统"]);
  assert.equal(out.blocks[1].text, "心脏的泵血功能");
  assert.equal(out.blocks[1].locatorKind, "paragraph");
  assert.equal(out.pageCount, 0);
});
test("docx accepts Chinese heading styles and decodes entities, runs, breaks and tabs", async () => {
  const body = para("第一章 绪论", "标题 1") + para("正文内容", "标题 2")
    + `<w:p><w:r><w:t>心脏的</w:t></w:r><w:r><w:t>泵血功能</w:t></w:r>`
    + `<w:r><w:t xml:space="preserve"> &amp; 心率 &#x2265; 60</w:t></w:r><w:br/>`
    + `<w:r><w:t>第二行</w:t></w:r><w:tab/><w:r><w:t>缩进</w:t></w:r></w:p>`;
  const out = await run(docx(body), "书.docx");
  assert.deepEqual(out.blocks.map(b => b.heading), ["第一章 绪论", "正文内容", "正文内容"]);
  assert.equal(out.blocks[2].text, "心脏的泵血功能 & 心率 ≥ 60\n第二行\t缩进");
  assert.equal(out.blocks[2].locator, "第 3 段");
});

// ---- 损坏的 ZIP / OOXML ----
test("broken archives report stable codes instead of leaking raw errors", async () => {
  await assert.rejects(() => run(new Uint8Array(64).fill(7), "broken.docx"), (e) => e instanceof ExtractError && e.code === "corrupt_archive");
  await assert.rejects(() => run(new Uint8Array(10), "tiny.docx"), (e) => e.code === "corrupt_archive");
  const full = buildZip([{ name: "word/document.xml", data: "<w:document/>" }]);
  await assert.rejects(() => run(full.slice(0, full.length - 10), "cut.docx"), (e) => e.code === "corrupt_archive");
  await assert.rejects(() => run(docx(""), "blank.docx"), (e) => e.code === "empty_document");
  await assert.rejects(() => run(pptx([]), "noslides.pptx"), (e) => e.code === "corrupt_document");
  await assert.rejects(() => run(buildZip([{ name: "word/document.xml", data: "<w:document/>", method: 99 }]), "weird.docx"), (e) => e.code === "unsupported_compression");
  await assert.rejects(() => run(pptx([{ name: "ppt/slides/slide1.xml", data: slide("只有标题"), method: 99 }]), "weird.pptx"), (e) => e.code === "unsupported_compression");
});
test("empty uploads and unsupported formats are rejected with a reason", async () => {
  await assert.rejects(() => run(new Uint8Array(0), "note.txt"), (e) => e.code === "empty_file");
  await assert.rejects(() => run(txt("x"), "note.pages", "application/octet-stream"), (e) => e.code === "unsupported_type");
  await assert.rejects(() => run(txt("x"), "讲义.ppt"), (e) => e.code === "legacy_format" && e.message.includes("pptx"));
  await assert.rejects(() => run(txt("x"), "讲义.doc"), (e) => e.code === "legacy_format");
  await assert.rejects(() => run(txt("x"), undefined, "application/vnd.ms-powerpoint"), (e) => e.code === "legacy_format");
});
test("detectKind prefers the extension and falls back to the MIME type", () => {
  assert.equal(detectKind("A.PPTX"), "pptx");
  assert.equal(detectKind("a.pdf"), "pdf");
  assert.equal(detectKind(undefined, "text/plain; charset=utf-8"), "txt");
  assert.equal(detectKind(undefined, "application/pdf"), "pdf");
  assert.equal(detectKind("a.bin"), "unsupported");
});
test("unknown names are sniffed by ZIP content instead of being refused", async () => {
  const bytes = pptx([{ name: "ppt/slides/slide1.xml", data: slide("心输出量") }]);
  const out = await run(bytes, "upload.bin", "application/octet-stream");
  assert.equal(out.engine, "pptx");
  assert.equal(out.blocks[0].text, "心输出量");
});

// ---- PDF ----
test("text pdfs are read into page blocks and scanned pdfs remain eligible for OCR", async () => {
  const texty = new Uint8Array(Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    + "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
    + "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"
    + "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
    + "5 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\nendstream endobj\n"
    + "trailer << /Root 1 0 R >>\n%%EOF\n", "latin1"));
  const scanned = new Uint8Array(Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    + "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
    + "3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF\n", "latin1"));
  const detected = await run(texty, "课件.pdf");
  assert.equal(detected.engine, "pdf-text");
  assert.equal(detected.needsOcr, false);
  assert.equal(detected.blocks.length, 1);
  assert.equal(detected.blocks[0].text, "Hello PDF");
  assert.equal(detected.blocks[0].locator, "page:1");
  assert.equal(detected.blockCount, 1);
  assert.equal(detected.pageCount, 1);
  assert.equal(detected.textLayer, "detected");
  const noLayer = await run(scanned, "扫描件.pdf");
  assert.equal(noLayer.needsOcr, true);
  assert.deepEqual(noLayer.blocks, []);
  assert.equal(noLayer.pageCount, 1);
  assert.equal(noLayer.textLayer, "not-detected");
  assert.match(noLayer.warnings.join(""), /可能是扫描件/);
  const garbage = await run(txt("这不是 PDF"), "伪装的.pdf");
  assert.equal(garbage.needsOcr, true);
  assert.equal(garbage.textLayer, "unknown");
  assert.equal(garbage.pageCount, 0);
  assert.match(garbage.warnings.join(""), /没有 PDF 文件头/);
});
test("pdf page text can inherit font resources from its parent page tree", async () => {
  const inherited = new Uint8Array(Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    + "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> endobj\n"
    + "3 0 obj << /Type /Page /Parent 2 0 R /Contents 5 0 R >> endobj\n"
    + "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n"
    + "5 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 72 720 Td (Inherited) Tj ET\nendstream endobj\n"
    + "trailer << /Root 1 0 R >>\n%%EOF\n", "latin1"));
  const out = await run(inherited, "父级资源.pdf");
  assert.equal(out.needsOcr, false);
  assert.equal(out.blocks[0].text, "Inherited");
});
test("probePdf counts page objects but never mistakes /Pages for a page", () => {
  const probe = probePdf(new Uint8Array(Buffer.from("/Type /Pages\n/Type /Page \n/Type /Page>>", "latin1")));
  assert.equal(probe.pageCount, 2);
});

// ---- 上限与截断 ----
test("limits cap block count, block size and total characters", async () => {
  const many = Array.from({ length: 2100 }, (_, i) => `要点 ${i + 1}`).join("\n\n");
  const capped = await run(txt(many), "长文.txt");
  assert.equal(capped.blockCount, 2000);
  assert.equal(capped.blocks.length, extractLimits.maxBlocks);
  assert.equal(capped.truncated, true);
  assert.match(capped.warnings.join(""), /已截断/);
  assert.equal(capped.blocks[1999].ordinal, 2000);
  const small = await run(txt("aaaa\n\nbbbb\n\ncccc"), "note.txt", undefined, { maxTotalChars: 5, maxBlockChars: 100, maxBlocks: 100 });
  assert.deepEqual(small.blocks.map(b => b.text), ["aaaa", "b"]);
  assert.equal(small.truncated, true);
  const roomy = await run(txt("aaaa\n\nbbbb"), "note.txt", undefined, { maxTotalChars: 8, maxBlockChars: 100, maxBlocks: 100 });
  assert.deepEqual(roomy.blocks.map(b => b.text), ["aaaa", "bbbb"]);
  assert.equal(roomy.truncated, false);
  assert.deepEqual(roomy.warnings, []);
});

// ---- 幂等 ----
test("the same bytes always produce the same result", async () => {
  const bytes = docx(para("循环系统", "Heading1") + para("每搏输出量"));
  assert.deepEqual(await run(bytes, "生理学.docx"), await run(bytes, "生理学.docx"));
  const pdfBytes = new Uint8Array(Buffer.from("%PDF-1.4\n/Type /Page \n/Font\n", "latin1"));
  assert.deepEqual(await run(pdfBytes, "x.pdf"), await run(pdfBytes, "x.pdf"));
  const deck = pptx([{ name: "ppt/slides/slide2.xml", data: slide("B") }, { name: "ppt/slides/slide1.xml", data: slide("A") }, { name: "ppt/slides/slide10.xml", data: slide("C") }]);
  const once = await run(deck, "deck.pptx");
  assert.deepEqual(once.blocks.map(b => b.text), ["A", "B", "C"]);
  assert.deepEqual(await run(deck, "deck.pptx"), once);
});
