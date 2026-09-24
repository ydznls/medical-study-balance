// 资料解析适配层。对外只暴露 extractDocument：
//   字节 + 文件名 → 稳定的 text blocks（带 locator / locatorKind / locatorValue / heading）。
// 职责划分：各 extractor 只负责「按自身语义切出逻辑块」，不关心上限；
// 单块字符数拆分、总块数、总字符数三个上限统一在本文件实施，避免各格式重复实现。
// PDF 先读取文字层；扫描版可由运行时注入 OCR 回调，回调不可用时明确返回 needsOcr。
import { extractTxt } from "./txt.ts";
import { extractPptx, extractDocx } from "./ooxml.ts";
import { listZipEntries } from "./zip.ts";
import { extractPdf,type PdfOcr } from "./pdf.ts";
export type LocatorKind="page"|"slide"|"paragraph"|"line";
export type TextBlock={ordinal:number;text:string;charCount:number;locator:string;locatorKind:LocatorKind;locatorValue:number;heading:string};
export type TextLayer="detected"|"not-detected"|"unknown";
export type ExtractResult={
 engine:string;
 blocks:TextBlock[];
 blockCount:number;
 pageCount:number;
 truncated:boolean;
 needsOcr:boolean;
 warnings:string[];
 textLayer?:TextLayer;
};
export type ExtractLimits={maxBlockChars:number;maxBlocks:number;maxTotalChars:number};
export const extractLimits:ExtractLimits={maxBlockChars:4000,maxBlocks:2000,maxTotalChars:2000000};
export type RawBlock={text:string;locator:string;locatorKind:LocatorKind;locatorValue:number;heading:string};
export type RawResult={engine:string;blocks:RawBlock[];warnings:string[];pageCount:number};
export type Extractor=(bytes:Uint8Array,limits:ExtractLimits)=>Promise<RawResult>;
export type ExtractKind="txt"|"pptx"|"docx"|"pdf"|"legacy"|"unsupported";
export class ExtractError extends Error{code:string;constructor(code:string,message:string){super(message);this.name="ExtractError";this.code=code}}
const LEGACY_MESSAGE="旧版 .ppt / .doc 二进制格式暂不支持，请在 Office 里另存为 .pptx / .docx 后重新上传。";
const UNSUPPORTED_MESSAGE="暂不支持这种资料格式，目前可以上传 TXT、PPTX、DOCX。";
const ZIP_MAGIC=[0x50,0x4b,0x03,0x04];
const CONTENT_TYPES:Record<string,ExtractKind>={
 "text/plain":"txt",
 "application/pdf":"pdf",
 "application/vnd.openxmlformats-officedocument.presentationml.presentation":"pptx",
 "application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx",
 "application/vnd.ms-powerpoint":"legacy",
 "application/msword":"legacy",
};
const EXTENSIONS:Record<string,ExtractKind>={
 txt:"txt",pptx:"pptx",docx:"docx",pdf:"pdf",ppt:"legacy",doc:"legacy",
};
const registry=new Map<ExtractKind,Extractor>();
export function registerExtractor(kind:ExtractKind,extractor:Extractor){registry.set(kind,extractor)}
registerExtractor("txt",(bytes,limits)=>Promise.resolve(extractTxt(bytes,limits.maxBlockChars)));
registerExtractor("pptx",(bytes)=>extractPptx(bytes));
registerExtractor("docx",(bytes)=>extractDocx(bytes));
function startsWithZip(bytes:Uint8Array){return bytes.length>=4&&ZIP_MAGIC.every((byte,index)=>bytes[index]===byte)}
function extensionOf(filename?:string){return (filename??"").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]??""}
/** 先看扩展名，再看 MIME；都认不出时返回 unsupported（OOXML 会在 extractDocument 里按内容再嗅探一次）。 */
export function detectKind(filename?:string,contentType?:string):ExtractKind{
 const extension=EXTENSIONS[extensionOf(filename)];
 if(extension)return extension;
 const mime=CONTENT_TYPES[(contentType??"").split(";")[0].trim().toLowerCase()];
 return mime??"unsupported";
}
/** 无害化任何携带字符串 code 的错误（ZipError / OoxmlError），统一成 ExtractError，避免跨模块循环引用。 */
export function toExtractError(error:unknown):ExtractError{
 if(error instanceof ExtractError)return error;
 const code=typeof (error as {code?:unknown}|null)?.code==="string"?(error as {code:string}).code:"extract_failed";
 const message=error instanceof Error&&error.message?error.message:"资料解析失败。";
 return new ExtractError(code,message);
}
function splitLong(block:RawBlock,maxBlockChars:number):RawBlock[]{
 if(block.text.length<=maxBlockChars)return [block];
 const parts:string[]=[];
 let rest=block.text;
 while(rest.length>maxBlockChars){
  let cut=rest.lastIndexOf("\n",maxBlockChars);
  if(cut<=0)cut=maxBlockChars;
  parts.push(rest.slice(0,cut));
  rest=rest.slice(cut).replace(/^\n/,"");
 }
 if(rest)parts.push(rest);
 return parts.map(part=>({...block,text:part}));
}
function clamp(raw:RawResult,limits:ExtractLimits):{blocks:TextBlock[];truncated:boolean;warnings:string[]}{
 const blocks:TextBlock[]=[],warnings=[...raw.warnings];
 let total=0,truncated=false,stop=false;
 for(const block of raw.blocks){
  if(stop)break;
  for(const piece of splitLong(block,limits.maxBlockChars)){
   const room=limits.maxTotalChars-total;
   if(blocks.length>=limits.maxBlocks||room<=0){truncated=true;stop=true;break}
   const text=piece.text.length>room?piece.text.slice(0,room):piece.text;
   if(text.length<piece.text.length)truncated=true;
   total+=text.length;
   blocks.push({ordinal:blocks.length+1,text,charCount:text.length,locator:piece.locator,locatorKind:piece.locatorKind,locatorValue:piece.locatorValue,heading:piece.heading});
  }
 }
 if(truncated)warnings.push("资料内容超过单次解析上限，已截断；建议按章节拆分后分别上传。");
 return {blocks,truncated,warnings};
}
const LATIN1=new TextDecoder("latin1");
const PAGE_PATTERN=/\/Type\s*\/Page[^s]/g;
const FONT_PATTERN=/\/(?:Font|FontFile\d?)\b/g;
function count(text:string,pattern:RegExp){pattern.lastIndex=0;let total=0;while(pattern.exec(text))total++;return total}
/** 只做线索级探测：压缩对象流里的页对象读不到，所以结果仅用于提示，不能当结论。 */
export function probePdf(bytes:Uint8Array):{pageCount:number;fontCount:number;hasHeader:boolean}{
 const text=LATIN1.decode(bytes);
 return {pageCount:count(text,PAGE_PATTERN),fontCount:count(text,FONT_PATTERN),hasHeader:text.startsWith("%PDF-")};
}
/** PDF 文字层先由轻量读取器处理；没有文字层时交给运行时 OCR 回调。 */
async function handlePdf(bytes:Uint8Array,filename:string|undefined,ocr:PdfOcr|undefined,limits:ExtractLimits):Promise<ExtractResult>{
 const probe=probePdf(bytes),result=await extractPdf(bytes,{filename,ocr});
 const warnings=[...result.warnings];
 if(!probe.hasHeader)warnings.unshift("这个文件没有 PDF 文件头，可能已损坏或不是 PDF。");
 if(result.needsOcr&&!ocr)warnings.push("系统尚未配置 OCR；请在服务端配置 AI_BASE_URL / AI_API_KEY，或先把课本转成 DOCX/TXT。");
 const clamped=clamp({engine:"pdf",blocks:result.blocks,warnings,pageCount:result.pageCount||probe.pageCount},limits);
 return {engine:result.needsOcr?"pdf":ocr&&result.textLayer==="not-detected"?"pdf+ocr":"pdf-text",blocks:clamped.blocks,blockCount:clamped.blocks.length,pageCount:result.pageCount||probe.pageCount,truncated:clamped.truncated,needsOcr:result.needsOcr,warnings:clamped.warnings,textLayer:result.textLayer};
}
async function sniffOoxml(bytes:Uint8Array):Promise<ExtractKind>{
 if(!startsWithZip(bytes))return "unsupported";
 try{
  const names=listZipEntries(bytes).map(entry=>entry.name);
  if(names.some(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)))return "pptx";
  if(names.includes("word/document.xml"))return "docx";
 }catch{return "unsupported"}
 return "unsupported";
}
export async function extractDocument(input:{filename?:string;contentType?:string;bytes:Uint8Array;limits?:Partial<ExtractLimits>;ocr?:PdfOcr}):Promise<ExtractResult>{
 const limits:ExtractLimits={...extractLimits,...input.limits};
 let kind=detectKind(input.filename,input.contentType);
 if(kind==="legacy")throw new ExtractError("legacy_format",LEGACY_MESSAGE);
 if(kind==="unsupported")kind=await sniffOoxml(input.bytes);
 if(kind==="unsupported")throw new ExtractError("unsupported_type",UNSUPPORTED_MESSAGE);
 if(!input.bytes.length)throw new ExtractError("empty_file","这个文件是空的，没有可解析的内容。");
 if(kind==="pdf")return handlePdf(input.bytes,input.filename,input.ocr,limits);
 const extractor=registry.get(kind);
 if(!extractor)throw new ExtractError("unsupported_type",UNSUPPORTED_MESSAGE);
 let raw:RawResult;
 try{raw=await extractor(input.bytes,limits)}catch(error){throw toExtractError(error)}
 const clamped=clamp(raw,limits);
 return {engine:raw.engine,blocks:clamped.blocks,blockCount:clamped.blocks.length,pageCount:raw.pageCount,truncated:clamped.truncated,needsOcr:false,warnings:clamped.warnings};
}
