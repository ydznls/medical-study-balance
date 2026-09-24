// 资料解析在界面上的呈现规则：状态文案、按钮该做什么、进度、预览与请求上限。
// 这里刻意不依赖 React、不发请求、不导入 lib/extract（否则解析器会被打进浏览器包），
// 所以 node:test 能直接断言这些结论；组件只负责把它们渲染出来。
import { canParseFile } from "./library.ts";
export type MaterialTaskStatus="pending"|"running"|"ready"|"needs_ocr"|"failed";
/** 界面上的状态多一个 none：这份资料还没有解析任务。 */
export type ClientTaskStatus=MaterialTaskStatus|"none";
/**
 * 服务端 TaskView / 资料列表里界面要用到的字段子集。
 * 只声明需要的字段，避免前端顺手依赖服务端内部状态。
 */
export type TaskSummary={
 id?:string;
 parseStatus:MaterialTaskStatus;
 parseEngine?:string;parseError?:string;parseMessage?:string;
 writtenBlocks?:number;totalBlocks?:number;storedBlocks?:number;
 pageCount?:number;truncated?:boolean;needsOcr?:boolean;
};
export type TaskTone="idle"|"busy"|"ok"|"warn"|"bad";
export type TaskAction="start"|"run"|"retry"|"none";
export const taskStatusLabels:Record<ClientTaskStatus,string>={none:"未解析",pending:"等待解析",running:"解析中",ready:"已解析",needs_ocr:"需要 OCR",failed:"解析失败"};
export const taskStatusTones:Record<ClientTaskStatus,TaskTone>={none:"idle",pending:"idle",running:"busy",ready:"ok",needs_ocr:"warn",failed:"bad"};
export type TaskDescription={
 status:ClientTaskStatus;label:string;tone:TaskTone;
 action:TaskAction;actionLabel:string;
 detail:string;percent:number;canPreview:boolean;busy:boolean;
};
/**
 * 一次点击最多连续调用几次 run。服务端每次 run 只写入一部分块，大文件要多次调用；
 * 这里封顶是为了「不要无限请求」——点一次最多发 8 个请求，没解析完就停下让用户再点。
 */
export const taskViewLimits={maxRunStepsPerClick:8,maxPreviewPages:5,previewPageSize:20} as const;
function blocks(task:TaskSummary){return Math.max(0,Math.trunc(task.writtenBlocks??0))}
function total(task:TaskSummary){return Math.max(0,Math.trunc(task.totalBlocks??0))}
function stored(task:TaskSummary){return Math.max(0,Math.trunc(task.storedBlocks??0))}
export function taskPercent(task:TaskSummary){
 const all=total(task);
 if(all<=0)return task.parseStatus==="ready"?100:0;
 return Math.min(100,Math.round((blocks(task)/all)*100));
}
export function describeTask(task:TaskSummary|null|undefined):TaskDescription{
 const status:ClientTaskStatus=task?.parseStatus??"none";
 const label=taskStatusLabels[status],tone=taskStatusTones[status],percent=task?taskPercent(task):0;
 if(!task)return {status,label,tone,action:"start",actionLabel:"开始解析",detail:"还没有解析过这份资料。",percent:0,canPreview:false,busy:false};
 if(status==="pending")return {status,label,tone,action:"start",actionLabel:"开始解析",detail:"任务已建立，等待开始。",percent,canPreview:false,busy:false};
 if(status==="running"){
  const all=total(task);
  return {status,label,tone,action:"run",actionLabel:"继续解析",detail:all>0?`已写入 ${blocks(task)} / ${all} 块，点「继续解析」接着处理。`:`已写入 ${blocks(task)} 块，点「继续解析」接着处理。`,percent,canPreview:false,busy:true};
 }
 if(status==="failed")return {status,label,tone,action:"retry",actionLabel:"重试",detail:task.parseMessage||"解析失败，可以重试。",percent:0,canPreview:false,busy:false};
 if(status==="needs_ocr")return {status,label,tone,action:"run",actionLabel:"尝试 OCR",detail:"这份 PDF 里没有读到文字层。配置服务端 OCR 后，点击「尝试 OCR」即可继续识别；暂未配置时会保留这个状态。",percent:0,canPreview:false,busy:false};
 // ready
 const count=stored(task);
 if(count<=0)return {status,label,tone,action:"none",actionLabel:"",detail:"解析完成，但这份文件里没有可展示的文本块。",percent:100,canPreview:false,busy:false};
 const pages=Math.max(0,Math.trunc(task.pageCount??0));
 const pagesText=pages>0?` · ${pages} 页/张`:"";
 return {status,label,tone,action:"none",actionLabel:"",detail:`已解析 ${count} 块${pagesText}${task.truncated?"（内容超过上限，只保留了前面部分）":""}`,percent:100,canPreview:true,busy:false};
}
/** 还能不能再走一步。点一次按钮的循环用它收尾，避免无限请求。 */
export function shouldRunStep(task:TaskSummary|null|undefined,stepsDone:number){
 return stepsDone<taskViewLimits.maxRunStepsPerClick&&(task?.parseStatus==="pending"||task?.parseStatus==="running"||task?.parseStatus==="needs_ocr");
}
/** 预览「加载更多」是否还允许：既有下一页，也没到页数上限。 */
export function canLoadMorePreview(pagesLoaded:number,hasMore:boolean){return !!hasMore&&pagesLoaded<taskViewLimits.maxPreviewPages}
/** 下一页的第一条 ordinal。ordinal 连续且从 1 开始，所以可以直接算。 */
export function previewFrom(pagesLoaded:number){return Math.max(0,Math.trunc(pagesLoaded))*taskViewLimits.previewPageSize+1}
export type ParseGate={ok:boolean;reason:string};
/** 这份资料能不能解析：没有上传文件、或者格式不支持，就给一条能看懂的空态说明。 */
export function parseGate(material:{hasFile?:boolean;filename?:string}):ParseGate{
 if(!material.hasFile)return {ok:false,reason:"这是一条链接资料，没有上传文件，暂时无法解析正文。"};
 if(!canParseFile(material.filename))return {ok:false,reason:"这种格式暂不支持解析，目前支持 TXT、PPTX、DOCX、PDF。"};
 return {ok:true,reason:""};
}
/** 预览条目的定位文字。服务端的 locator 已经是人话，这里只在缺失时兜底。 */
export function blockLabel(block:{ordinal:number;locator?:string;heading?:string}){
 const locator=block.locator&&block.locator.trim()?block.locator.trim():`第 ${block.ordinal} 块`;
 const heading=block.heading&&block.heading.trim()?block.heading.trim():"";
 return heading&&heading!==locator?`${locator} · ${heading}`:locator;
}
