// 纯文本解析：按行保留定位，把相邻行合并成不超过 maxBlockChars 的块。
// 定位指向块的起始行号；跨行时写成「第 a–b 行」。
export type TxtBlock={text:string;locator:string;locatorKind:"line";locatorValue:number;heading:string};
export type TxtResult={engine:string;blocks:TxtBlock[];warnings:string[];pageCount:number};
// TextDecoder 用 U+FFFD 替换非法字节，BOM 需要单独去掉。两者都按码位构造，避免源码里出现不可见字符。
const REPLACEMENT=String.fromCharCode(0xfffd);
const BOM_PATTERN=new RegExp("^\\uFEFF");
export function decodeUtf8(bytes:Uint8Array){return new TextDecoder("utf-8").decode(bytes).replace(BOM_PATTERN,"")}
export function extractTxt(bytes:Uint8Array,maxBlockChars:number):TxtResult{
 const text=decodeUtf8(bytes),warnings:string[]=[];
 const broken=(text.split(REPLACEMENT).length-1)/Math.max(1,text.length);
 if(broken>0.02)warnings.push("这份 TXT 不是有效的 UTF-8 编码，中文可能显示异常；请另存为 UTF-8 后重新上传。");
 const lines=text.split(/\r\n|\r|\n/),blocks:TxtBlock[]=[];
 let buffer:string[]=[],start=0,end=0,previous=0,size=0;
 const flush=()=>{if(!buffer.length)return;blocks.push({text:buffer.join("\n"),locator:start===end?"第 "+start+" 行":"第 "+start+"–"+end+" 行",locatorKind:"line",locatorValue:start,heading:""});buffer=[];size=0};
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(!line.trim())continue;
  const number=i+1;
  if(buffer.length&&(number!==previous+1||size+line.length+1>maxBlockChars))flush();
  if(!buffer.length)start=number;
  buffer.push(line);size+=line.length+1;end=number;previous=number;
 }
 flush();
 return {engine:"txt",blocks,warnings,pageCount:0};
}
