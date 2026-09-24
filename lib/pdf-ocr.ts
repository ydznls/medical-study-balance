// 扫描版 PDF 的 OCR 适配层。
// 使用已经存在的 Anthropic Messages provider 传 PDF document，不在浏览器上传密钥。
// 没有配置真实 provider 时返回 null，由解析任务保持 needs_ocr 状态并给出明确说明。
import type { AiProvider } from "./ai-provider.ts";
import type { PdfOcr, PdfOcrInput, PdfOcrResult } from "./extract/pdf.ts";

function base64(bytes:Uint8Array){
 let result="";
 const size=0x8000;
 for(let offset=0;offset<bytes.length;offset+=size){
  const end=Math.min(bytes.length,offset+size);
  result+=String.fromCharCode(...bytes.slice(offset,end));
 }
 return btoa(result);
}
function jsonText(text:string){
 const fenced=text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]??text;
 const start=fenced.indexOf("{");
 const end=fenced.lastIndexOf("}");
 if(start<0||end<=start)return null;
 try{return JSON.parse(fenced.slice(start,end+1)) as unknown}catch{return null}
}
function clean(value:unknown,max:number){return typeof value==="string"?value.replace(/\r/g,"").trim().slice(0,max):""}
function blocksFrom(value:unknown,pageCount:number):PdfOcrResult|null{
 const pages=(value as {pages?:unknown})?.pages;
 if(!Array.isArray(pages))return null;
 const blocks=pages.flatMap((item,index)=>{
  const row=item as {page?:unknown;text?:unknown;heading?:unknown};
  const page=typeof row.page==="number"&&Number.isInteger(row.page)&&row.page>0?row.page:index+1;
  const text=clean(row.text,200000);
  if(!text)return [];
  return [{text,locator:`page:${page}`,locatorKind:"page" as const,locatorValue:page,heading:clean(row.heading,120)||text.split(/\r?\n/)[0].slice(0,120)}];
 });
 return blocks.length?{blocks,warnings:[`OCR 已读取 ${blocks.length} 页；页码保留在每条正文的来源位置中。`],pageCount:Math.max(pageCount,...blocks.map(block=>block.locatorValue))}:null;
}
export async function ocrPdf(provider:AiProvider,input:PdfOcrInput):Promise<PdfOcrResult|null>{
 if(provider.kind!=="http"||!provider.status().configured)return null;
 const response=await provider.generate({
  task:"ocr",
  system:"你是 PDF 文字识别器。请逐页转录用户提供的 PDF，保留原文中的中文、英文、数字、标题和公式可读形式。不要总结，不要补写医学知识，不要猜测看不清的字。只返回严格 JSON：{\"pages\":[{\"page\":1,\"heading\":\"本页标题\",\"text\":\"本页完整文字\"}]}。没有文字的页面返回空 text。",
  messages:[{role:"user",content:"请识别这份 PDF 的全部页面文字，并按页返回 JSON。"}],
  maxTokens:20000,
  documents:[{mediaType:"application/pdf",data:base64(input.bytes),filename:input.filename}],
 });
 if(!response.ok)return null;
 return blocksFrom(jsonText(response.text),input.pageCount);
}
