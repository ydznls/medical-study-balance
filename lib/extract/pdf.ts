// 轻量 PDF 文字层读取器。
//
// 这里不依赖原生二进制或 npm 运行时：先读取 PDF 的页面对象、内容流和
// ToUnicode CMap，足够处理大多数由 Office、浏览器和排版软件生成的文字型 PDF。
// 扫描版没有文字层时由上层注入 OCR 回调；没有回调就明确返回 needsOcr，绝不把
// 空结果伪装成解析成功。
import type { RawBlock } from "./index.ts";

type PdfObject={id:number;body:string};
type PdfBytes={kind:"bytes";bytes:Uint8Array};
type PdfArray={kind:"array";items:Token[]};
type Token=PdfBytes|PdfArray|{kind:"word";value:string};
export type PdfOcrInput={bytes:Uint8Array;filename?:string;pageCount:number};
export type PdfOcrResult={blocks:RawBlock[];warnings?:string[];pageCount?:number};
export type PdfOcr=(input:PdfOcrInput)=>Promise<PdfOcrResult|null>;
export type PdfExtractResult={
 blocks:RawBlock[];pageCount:number;textLayer:"detected"|"not-detected"|"unknown";warnings:string[];needsOcr:boolean;
};

const latin1=new TextDecoder("latin1");
const utf8=new TextDecoder("utf-8");
const pagePattern=/\/Type\s*\/Page\b/g;
const objectPattern=/(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
function objectsOf(source:string){
 const objects=new Map<number,PdfObject>();
 objectPattern.lastIndex=0;
 let match:RegExpExecArray|null;
 while((match=objectPattern.exec(source))){
  const id=Number(match[1]);
  if(!objects.has(id))objects.set(id,{id,body:match[3]});
 }
 return objects;
}
function bytesOf(text:string){return Uint8Array.from(Array.from(text,c=>c.charCodeAt(0)&255))}
function streamOf(body:string){
 const start=body.indexOf("stream");
 const end=body.lastIndexOf("endstream");
 if(start<0||end<0||end<=start)return null;
 let from=start+6;
 if(body[from]==="\r")from++;
 if(body[from]==="\n")from++;
 return {bytes:bytesOf(body.slice(from,end)),dictionary:body.slice(0,start)};
}
async function inflate(bytes:Uint8Array){
 if(typeof DecompressionStream==="undefined")return bytes;
 for(const format of ["deflate","deflate-raw"] as const){
  try{
   const stream=new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format as "deflate"));
   return new Uint8Array(await new Response(stream).arrayBuffer());
  }catch{}
 }
 return bytes;
}
async function decodedStream(object:PdfObject){
 const stream=streamOf(object.body);
 if(!stream)return null;
 const filtered=/\/Filter\s*(?:\[\s*)?\/FlateDecode\b/.test(stream.dictionary);
 return filtered?inflate(stream.bytes):stream.bytes;
}
function refs(text:string){
 const result:number[]=[];
 const pattern=/(\d+)\s+\d+\s+R/g;
 let match:RegExpExecArray|null;
 while((match=pattern.exec(text)))result.push(Number(match[1]));
 return result;
}
function contentRefs(body:string){
 const match=body.match(/\/Contents\s+([\s\S]{0,1200}?)(?=\/\w+\s|$)/);
 return match?refs(match[1]):[];
}
function fontRefs(body:string){
 const match=body.match(/\/Font\s*<<([\s\S]*?)>>/);
 if(!match)return new Map<string,number>();
 const result=new Map<string,number>();
 const pattern=/\/(\w+)\s+(\d+)\s+\d+\s+R/g;
 let item:RegExpExecArray|null;
 while((item=pattern.exec(match[1])))result.set(item[1],Number(item[2]));
 return result;
}
function hexBytes(value:string){
 const clean=value.replace(/\s/g,"");
 const even=clean.length%2?clean+"0":clean;
 const bytes=new Uint8Array(even.length/2);
 for(let i=0;i<bytes.length;i++)bytes[i]=Number.parseInt(even.slice(i*2,i*2+2),16)||0;
 return bytes;
}
function decodeUtf16(bytes:Uint8Array){
 let start=0,swap=false;
 if(bytes.length>=2&&bytes[0]===0xfe&&bytes[1]===0xff)start=2;
 else if(bytes.length>=2&&bytes[0]===0xff&&bytes[1]===0xfe){start=2;swap=true}
 else return null;
 const values:number[]=[];
 for(let i=start;i+1<bytes.length;i+=2)values.push(swap?(bytes[i]|bytes[i+1]<<8):(bytes[i]<<8|bytes[i+1]));
 return String.fromCodePoint(...values);
}
function unicodeHex(value:string){
 const bytes=hexBytes(value);
 const direct=decodeUtf16(bytes);
 if(direct!==null)return direct;
 const points:number[]=[];
 for(let i=0;i+1<bytes.length;i+=2)points.push(bytes[i]<<8|bytes[i+1]);
 return points.length?String.fromCodePoint(...points):"";
}
type CMap={map:Map<string,string>;widths:number[]};
function parseCMap(source:string):CMap|null{
 const map=new Map<string,string>();
 const widths=new Set<number>();
 const chars=source.match(/beginbfchar[\s\S]*?endbfchar/g)??[];
 for(const section of chars){
  const pair=/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/g;
  let match:RegExpExecArray|null;
  while((match=pair.exec(section))){map.set(match[1].toUpperCase(),unicodeHex(match[2]));widths.add(match[1].length/2)}
 }
 const ranges=source.match(/beginbfrange[\s\S]*?endbfrange/g)??[];
 for(const section of ranges){
  const line=/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+(\[[^\]]+\]|<[0-9a-fA-F]+>)/g;
  let match:RegExpExecArray|null;
  while((match=line.exec(section))){
   const start=Number.parseInt(match[1],16),end=Number.parseInt(match[2],16),width=match[1].length/2;
   widths.add(width);
   if(match[3].startsWith("[")){
    const values=Array.from(match[3].matchAll(/<([0-9a-fA-F]+)>/g));
    for(let code=start;code<=end&&code-start<values.length;code++)map.set(code.toString(16).padStart(width*2,"0").toUpperCase(),unicodeHex(values[code-start][1]));
   }else{
    const first=Number.parseInt(match[3].slice(1,-1),16);
    for(let code=start;code<=end;code++)map.set(code.toString(16).padStart(width*2,"0").toUpperCase(),String.fromCodePoint(first+code-start));
   }
  }
 }
 return map.size?{map,widths:[...widths].sort((a,b)=>b-a)}:null;
}
function decodeBytes(bytes:Uint8Array,cmap?:CMap){
 if(cmap){
  let output="";
  for(let i=0;i<bytes.length;){
   let found=false;
   for(const width of cmap.widths){
    if(i+width>bytes.length)continue;
    const key=Array.from(bytes.slice(i,i+width),byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase();
    const value=cmap.map.get(key);
    if(value!==undefined){output+=value;i+=width;found=true;break}
   }
   if(!found){output+=String.fromCharCode(bytes[i]);i++}
  }
  return output;
 }
 return decodeUtf16(bytes)??(looksUtf8(bytes)?utf8.decode(bytes):latin1.decode(bytes));
}
function looksUtf8(bytes:Uint8Array){
 try{const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);return /[\u0080-\uFFFF]/.test(text)}catch{return false}
}
function readLiteral(source:string,start:number){
 const result:number[]=[];let depth=1,i=start+1;
 const escapes:Record<string,number>={n:10,r:13,t:9,b:8,f:12};
 while(i<source.length&&depth){
  const char=source[i++];
  if(char==="("){depth++;result.push(40);continue}
  if(char===")"){depth--;if(depth)result.push(41);continue}
  if(char!=="\\"){result.push(char.charCodeAt(0)&255);continue}
  if(i>=source.length)break;
  const escaped=source[i++];
  if(escapes[escaped]!==undefined){result.push(escapes[escaped]);continue}
  if(/[0-7]/.test(escaped)){
   let oct=escaped;
   while(oct.length<3&&/[0-7]/.test(source[i]??""))oct+=source[i++];
   result.push(Number.parseInt(oct,8));continue;
  }
  if(escaped!=="\r"&&escaped!=="\n")result.push(escaped.charCodeAt(0)&255);
 }
 return {token:{kind:"bytes",bytes:Uint8Array.from(result)} as PdfBytes,next:i};
}
function tokenize(source:string):Token[]{
 const tokens:Token[]=[];let i=0;
 while(i<source.length){
  const char=source[i];
  if(/\s/.test(char)){i++;continue}
  if(char==="%"){while(i<source.length&&!/[\r\n]/.test(source[i]))i++;continue}
  if(char==="("){const result=readLiteral(source,i);tokens.push(result.token);i=result.next;continue}
  if(char==="<"&&source[i+1]!=="<"){
   const end=source.indexOf(">",i+1);if(end<0)break;
   tokens.push({kind:"bytes",bytes:hexBytes(source.slice(i+1,end))});i=end+1;continue;
  }
  if(char==="["){
   const end=findClosing(source,i,"[","]");
   tokens.push({kind:"array",items:tokenize(source.slice(i+1,end<0?source.length:end))});i=end<0?source.length:end+1;continue;
  }
  if("{}<>/".includes(char)&&char!=="/")
  {tokens.push({kind:"word",value:char});i++;continue}
  let end=i;
  while(end<source.length&&!/[\s()<>\[\]{}%]/.test(source[end]))end++;
  tokens.push({kind:"word",value:source.slice(i,end)});i=end;
 }
 return tokens;
}
function findClosing(source:string,start:number,open:string,close:string){
 let depth=0;
 for(let i=start;i<source.length;i++){
  if(source[i]===open)depth++;
  else if(source[i]===close){depth--;if(depth===0)return i}
 }
 return -1;
}
async function fontCMaps(objects:Map<number,PdfObject>,pageBody:string){
 const result=new Map<string,CMap>();
 for(const [name,fontId] of fontRefs(pageBody)){
  const font=objects.get(fontId);if(!font)continue;
  const cmapRef=font.body.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1];
  if(!cmapRef)continue;
  const cmapObj=objects.get(Number(cmapRef));if(!cmapObj)continue;
  const raw=await decodedStream(cmapObj);if(raw){const parsed=parseCMap(latin1.decode(raw));if(parsed)result.set(name,parsed)}
 }
 return result;
}
function inheritedResources(objects:Map<number,PdfObject>,page:PdfObject){
 const bodies:string[]=[];
 let current:PdfObject|undefined=page;
 const visited=new Set<number>();
 for(let depth=0;current&&depth<12;depth++){
  if(visited.has(current.id))break;
  visited.add(current.id);
  const resources=current.body.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if(resources){const resource=objects.get(Number(resources[1]));if(resource)bodies.push(resource.body)}
  bodies.push(current.body);
  const parent:RegExpMatchArray|null=current.body.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
  current=parent?objects.get(Number(parent[1])):undefined;
 }
 return bodies.join("\n");
}
function textFromContent(source:string,cmaps:Map<string,CMap>){
 const tokens=tokenize(source),output:string[]=[];let font="";
 const decode=(token:Token)=>token.kind==="bytes"?decodeBytes(token.bytes,cmaps.get(font)):token.kind==="array"?token.items.filter(item=>item.kind==="bytes").map(item=>decodeBytes(item.bytes,cmaps.get(font))).join(""):"";
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];if(token.kind!=="word")continue;
  if(token.value==="Tf"){
   const previous=tokens[i-2];if(previous?.kind==="word")font=previous.value.replace(/^\//,"");continue;
  }
  if(token.value==="Tj"||token.value==="TJ"||token.value==="'"||token.value==='"'){
   const previous=tokens[i-1];if(previous?.kind==="bytes"||previous?.kind==="array")output.push(decode(previous));
   if(token.value==="'"||token.value==='"')output.push("\n");
   continue;
  }
  if(token.value==="Td"||token.value==="TD"||token.value==="T*")output.push("\n");
 }
 return output.join("").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
async function pageText(objects:Map<number,PdfObject>,page:PdfObject){
 const cmaps=await fontCMaps(objects,inheritedResources(objects,page)),pieces:string[]=[];
 for(const ref of contentRefs(page.body)){
  const object=objects.get(ref);if(!object)continue;
  const bytes=await decodedStream(object);
  if(bytes)pieces.push(latin1.decode(bytes));
 }
 return textFromContent(pieces.join("\n"),cmaps);
}
export async function extractPdf(bytes:Uint8Array,options:{filename?:string;ocr?:PdfOcr}={}):Promise<PdfExtractResult>{
 const source=latin1.decode(bytes),objects=objectsOf(source);
 const pages=[...objects.values()].filter(object=>{pagePattern.lastIndex=0;return pagePattern.test(object.body)});
 const pageCount=pages.length;
 const blocks:RawBlock[]=[];
 for(let index=0;index<pages.length;index++){
  const text=await pageText(objects,pages[index]);
  if(text)blocks.push({text,locator:`page:${index+1}`,locatorKind:"page",locatorValue:index+1,heading:text.split(/\r?\n/)[0].slice(0,120)});
 }
 if(blocks.length)return {blocks,pageCount,textLayer:"detected",warnings:[],needsOcr:false};
 if(options.ocr){
  const ocr=await options.ocr({bytes,filename:options.filename,pageCount});
  if(ocr?.blocks.length)return {blocks:ocr.blocks,pageCount:ocr.pageCount??pageCount,textLayer:"not-detected",warnings:ocr.warnings??[],needsOcr:false};
 }
 const warnings=pageCount?[
  "没有读到 PDF 文字层，这份文件可能是扫描件。已尝试系统内配置的 OCR，但没有得到可用结果。",
 ]:["没有检测到有效的 PDF 页面。"];
 return {blocks:[],pageCount,textLayer:pageCount?"not-detected":"unknown",warnings,needsOcr:true};
}
