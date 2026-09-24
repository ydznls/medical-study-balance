// OOXML（PPTX / DOCX）文本抽取。两者都是 ZIP + XML：PPTX 取 ppt/slides/slideN.xml，
// DOCX 取 word/document.xml。这里只做段落级文本收集与定位，不解析样式、表格结构和图片。
// 已知边界：命名空间前缀固定按 a: / w: 匹配，非常规生成器改写前缀时可能取不到文字；
// 段落按 <w:p>…</w:p> 配对计数，自闭合的 <w:p/> 不计入段号（正常 Word 输出不会这样写）。
import { readZipEntries } from "./zip.ts";
export class OoxmlError extends Error{code:string;constructor(code:string,message:string){super(message);this.name="OoxmlError";this.code=code}}
export type OoxmlBlock={text:string;locator:string;locatorKind:"slide"|"paragraph";locatorValue:number;heading:string};
export type OoxmlResult={engine:string;blocks:OoxmlBlock[];warnings:string[];pageCount:number};
const NAMED:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
function codePoint(value:number){if(!Number.isFinite(value)||value<0||value>0x10ffff||(value>=0xd800&&value<=0xdfff))return "";try{return String.fromCodePoint(value)}catch{return ""}}
export function decodeXmlText(value:string):string{
 return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,(whole,decimal:string|undefined,hex:string|undefined,name:string|undefined)=>{
  if(decimal!==undefined)return codePoint(Number(decimal));
  if(hex!==undefined)return codePoint(parseInt(hex,16));
  const named=name?NAMED[name]:undefined;
  return named===undefined?whole:named;
 });
}
function paragraphs(xml:string,prefix:string):{inner:string;text:string}[]{
 const out:{inner:string;text:string}[]=[],block=new RegExp("<"+prefix+":p(?:\\s[^>]*)?>([\\s\\S]*?)</"+prefix+":p>","g"),run=new RegExp("<"+prefix+":t(?:\\s[^>]*)?>([\\s\\S]*?)</"+prefix+":t>","g"),
  breaks=new RegExp("<"+prefix+":br\\s*/?>","g"),tabs=new RegExp("<"+prefix+":tab\\s*/?>","g");
 let match:RegExpExecArray|null;
 while((match=block.exec(xml))){
  // 换行和制表符是独立的空标签，不落在 <w:t> 里；改写成等价的文本 run，才能按原顺序被采集。
  const inner=match[1].replace(breaks,"<"+prefix+":t>\n</"+prefix+":t>").replace(tabs,"<"+prefix+":t>\t</"+prefix+":t>");
  let text="",piece:RegExpExecArray|null;run.lastIndex=0;
  while((piece=run.exec(inner)))text+=decodeXmlText(piece[1]);
  out.push({inner:match[1],text});
 }
 return out;
}
function isHeadingStyle(style:string){return /^(heading[1-9]|title)$/i.test(style.trim())||style.includes("标题")}
/** 每张幻灯片一个块，定位为幻灯片编号；标题取该页第一段非空文字。 */
export async function extractPptx(bytes:Uint8Array):Promise<OoxmlResult>{
 const entries=await readZipEntries(bytes,name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));
 if(entries.size===0)throw new OoxmlError("corrupt_document","这份 PPTX 里没有找到幻灯片，可能不是有效的演示文稿。");
 const slides=[...entries.keys()].map(name=>({name,index:Number(/slide(\d+)\.xml$/.exec(name)?.[1]??"0")})).sort((a,b)=>a.index-b.index);
 const blocks:OoxmlBlock[]=[];
 for(const slide of slides){
  const parts=paragraphs(new TextDecoder().decode(entries.get(slide.name)!),"a").filter(part=>part.text.trim());
  if(!parts.length)continue;
  blocks.push({text:parts.map(part=>part.text).join("\n"),locator:"第 "+slide.index+" 张幻灯片",locatorKind:"slide",locatorValue:slide.index,heading:parts[0].text.trim().slice(0,120)});
 }
 if(!blocks.length)throw new OoxmlError("empty_document","这份 PPTX 的幻灯片里没有可用的文字。");
 return {engine:"pptx",blocks,warnings:[],pageCount:slides.length};
}
/** 每个非空段落一个块，定位为段落序号（含空段，便于回原文核对）；Heading/标题 样式作为所属章节。 */
export async function extractDocx(bytes:Uint8Array):Promise<OoxmlResult>{
 const entries=await readZipEntries(bytes,name=>name==="word/document.xml");
 const document=entries.get("word/document.xml");
 if(!document)throw new OoxmlError("corrupt_document","这份 DOCX 里没有找到正文，可能不是有效的 Word 文档。");
 const list:OoxmlBlock[]=[];let heading="",index=0;
 for(const paragraph of paragraphs(new TextDecoder().decode(document),"w")){
  index++;
  const style=/<w:pStyle[^>]*w:val="([^"]*)"/.exec(paragraph.inner)?.[1]??"";
  const text=paragraph.text.trim();
  if(isHeadingStyle(style)&&text)heading=text.slice(0,120);
  if(!text)continue;
  list.push({text:paragraph.text,locator:"第 "+index+" 段",locatorKind:"paragraph",locatorValue:index,heading});
 }
 if(!list.length)throw new OoxmlError("empty_document","这份 Word 文档里没有可用的文字。");
 return {engine:"docx",blocks:list,warnings:[],pageCount:0};
}
