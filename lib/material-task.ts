// 资料解析任务的服务层：创建、查询、分步执行、重试。
// 路由只负责鉴权 / 同源检查 / 序列化，这里不导入 cloudflare:workers，也不直接读 env，
// R2 取值通过注入的 loadObject 完成，方便测试。
//
// 状态语义（对应 docs/CLAUDE_HANDOFF.md 的第 7、8 条）：
//   pending   已建任务，未开始
//   running   解析进行中（parseCursor > 0 表示已写入部分块）
//   ready     解析完成并且写入了文本块
//   needs_ocr 文件没有读到文字层，等待或提示配置 OCR；配置后可从原任务继续执行
//   failed    解析失败，parseError 是稳定错误码，可 retry
import { ExtractError,detectKind,extractDocument,type ExtractResult } from "./extract/index.ts";
import type { PdfOcr } from "./extract/pdf.ts";
import { maxFileBytes,parseableExtensions } from "./library.ts";
import type { BlockRecord,TaskPatch,TaskRecord,TaskStatus,TaskStore } from "./task-store.ts";
export const taskLimits={
 /** 单次 run 最多写入多少个块。低于 extractLimits.maxBlocks，所以大文件需要多次调用。 */
 maxBlocksPerRun:800,
 /** 单次 run 最多写入多少字符，防止一次请求把 D1 写爆。 */
 maxCharsPerRun:1500000,
 /** 允许的最大重试次数（每次从头开始算一次）。 */
 maxParseAttempts:5,
 /** 执行租约秒数：进程中途死掉后，这段时间内不会被重复抢占。 */
 leaseSeconds:60,
} as const;
/** 稳定错误码 → 中文说明。UI 直接查这张表，不要把 parseError 当文案用。 */
export const taskErrorMessages:Record<string,string>={
 material_not_found:"找不到这份资料。",
 material_has_no_file:"这份资料是一条链接，没有可解析的文件。",
 unsupported_type:"这种文件格式暂不支持解析，目前支持 TXT、PPTX、DOCX 和 PDF。",
 file_too_large:"文件超过 20 MB，暂时无法解析。",
 task_not_found:"找不到这个解析任务。",
 task_failed:"这个解析任务已经失败，请先重试。",
 task_not_failed:"只有失败的解析任务才能重试。",
 task_busy:"这个任务正在解析中，请稍后再试。",
 retry_limit_reached:"这个任务重试次数过多，请重新上传资料。",
 storage_missing:"文件已不在存储中，请重新上传这份资料。",
 source_changed:"文件内容与首次解析时不一致，请重新上传后再解析。",
 content_type_mismatch:"文件内容与记录的类型不一致，请重新上传。",
 empty_file:"这个文件是空的，没有可解析的内容。",
 empty_document:"这份资料里没有可用的文字。",
 needs_ocr:"这份 PDF 没有文字层。系统会在配置 OCR 后自动识别；当前没有可用 OCR 服务，请先配置 AI_BASE_URL / AI_API_KEY，或改用 TXT、PPTX、DOCX。",
 corrupt_archive:"文件已损坏或没有上传完整，无法解析。",
 corrupt_document:"文件结构不完整，无法解析。",
 zip64_unsupported:"这个文件使用了暂不支持的压缩格式。",
 unsupported_compression:"这个文件使用了暂不支持的压缩方式。",
 runtime_unsupported:"当前运行环境暂时无法解压这个文件。",
 legacy_format:"旧版 .ppt / .doc 格式请先另存为 .pptx / .docx。",
 extract_failed:"解析失败，请重试。",
};
export type TaskView={
 id:string;materialId:string;courseId:string;
 parseStatus:TaskStatus;parseEngine:string;parseError:string;parseMessage:string;parseAttempts:number;
 writtenBlocks:number;totalBlocks:number;storedBlocks:number;pageCount:number;truncated:boolean;needsOcr:boolean;
 generateStatus:TaskStatus;byteSize:number;leaseUntil:string;createdAt:string;updatedAt:string;
};
export type TaskFailure={ok:false;error:string;message:string;status:number;detail?:string};
export type CreateTaskResult={ok:true;task:TaskView;created:boolean}|TaskFailure;
export type ReadTaskResult={ok:true;task:TaskView}|TaskFailure;
export type RunTaskResult={ok:true;task:TaskView;written:number;done:boolean}|TaskFailure;
export type RetryTaskResult={ok:true;task:TaskView}|TaskFailure;
export type TaskDeps={store:TaskStore;loadObject:(key:string)=>Promise<Uint8Array|null>;ocr?:PdfOcr;maxBlocksPerRun?:number;now?:()=>Date};
function fail(error:string,status:number,detail?:string):TaskFailure{return {ok:false,error,message:taskErrorMessages[error]??"解析任务失败，请重试。",status,detail}}
export function taskMessage(code:string){return taskErrorMessages[code]??"解析失败，请重试。"}
export async function viewOf(store:TaskStore,task:TaskRecord):Promise<TaskView>{
 return {
  id:task.id,materialId:task.materialId,courseId:task.courseId,
  parseStatus:task.parseStatus,parseEngine:task.parseEngine,parseError:task.parseError,parseMessage:task.parseError?taskMessage(task.parseError):"",parseAttempts:task.parseAttempts,
  writtenBlocks:task.parseCursor,totalBlocks:task.blockCount,storedBlocks:await store.countBlocks(task.id),pageCount:task.pageCount,
  truncated:!!task.truncated,needsOcr:task.parseStatus==="needs_ocr",
  generateStatus:task.generateStatus,byteSize:task.byteSize,leaseUntil:task.leaseUntil,createdAt:task.createdAt,updatedAt:task.updatedAt,
 };
}
async function sha256(bytes:Uint8Array){
 const digest=await crypto.subtle.digest("SHA-256",bytes as unknown as BufferSource);
 return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
function startsWith(bytes:Uint8Array,prefix:number[]){return bytes.length>=prefix.length&&prefix.every((byte,index)=>bytes[index]===byte)}
const ZIP_MAGIC=[0x50,0x4b,0x03,0x04],PDF_MAGIC=[0x25,0x50,0x44,0x46,0x2d];
export async function createParseTask(deps:{store:TaskStore},userId:string,materialId:string):Promise<CreateTaskResult>{
 const {store}=deps;
 const material=await store.findMaterial(userId,materialId);
 if(!material)return fail("material_not_found",404);
 // 并发两次创建可能各建一条（这里没有唯一索引，也不该为此改已生成的 0002）。
 // 两条任务互不影响：块按 task_id 隔离，解析又是确定性的，结果一致。
 const reusable=await store.findReusableTask(userId,materialId);
 if(reusable)return {ok:true,task:await viewOf(store,reusable),created:false};
 if(!material.storageKey)return fail("material_has_no_file",400);
 // 判定以 detectKind 为准（它同时看扩展名和内容类型），但可解析集合来自 lib/library.ts，
 // 和前端按钮用的是同一份清单，避免两边各写一份扩展名然后慢慢走偏。
 const kind=detectKind(material.filename,material.contentType);
 if(!(parseableExtensions as readonly string[]).includes(kind))return fail("unsupported_type",400,"kind="+kind);
 if(material.size>maxFileBytes)return fail("file_too_large",413);
 const now=new Date().toISOString();
 const task:TaskRecord={
  id:crypto.randomUUID(),userId,materialId,courseId:material.courseId,
  parseStatus:"pending",parseEngine:"",parseError:"",parseAttempts:0,parseCursor:0,
  generateStatus:"pending",generateEngine:"",generateError:"",generateAttempts:0,generateCursor:0,
  sourceSha256:"",byteSize:0,pageCount:0,blockCount:0,truncated:0,leaseUntil:"",createdAt:now,updatedAt:now,
 };
 await store.createTask(task);
 return {ok:true,task:await viewOf(store,task),created:true};
}
export async function readParseTask(deps:{store:TaskStore},userId:string,materialId:string,taskId:string):Promise<ReadTaskResult>{
 const task=await deps.store.getTask(userId,taskId);
 if(!task||task.materialId!==materialId)return fail("task_not_found",404);
 return {ok:true,task:await viewOf(deps.store,task)};
}
/** 把任务标记为失败并返回 200：请求本身处理成功，失败的是任务，客户端刷新状态即可看到原因。 */
async function markFailed(store:TaskStore,task:TaskRecord,code:string,detail:string,extra:TaskPatch={}):Promise<RunTaskResult>{
 const patch:TaskPatch={parseStatus:"failed",parseError:code,leaseUntil:"",updatedAt:new Date().toISOString(),...extra};
 await store.updateTask(task.id,patch);
 return {ok:true,task:await viewOf(store,{...task,...patch}),written:0,done:true};
}
export async function runParseTask(deps:TaskDeps,userId:string,materialId:string,taskId:string):Promise<RunTaskResult>{
 const {store,loadObject}=deps;
 const now=deps.now??(()=>new Date());
 const budget=Math.max(1,Math.min(deps.maxBlocksPerRun??taskLimits.maxBlocksPerRun,taskLimits.maxBlocksPerRun));
 const task=await store.getTask(userId,taskId);
 if(!task||task.materialId!==materialId)return fail("task_not_found",404);
 // 幂等：已完成的任务重复调用直接返回现状；needs_ocr 允许在配置 OCR 后继续尝试。
 if(task.parseStatus==="ready")return {ok:true,task:await viewOf(store,task),written:0,done:true};
 if(task.parseStatus==="failed")return fail("task_failed",409);
 const startedAt=now();
 if(task.leaseUntil&&task.leaseUntil>startedAt.toISOString())return fail("task_busy",409);
 const material=await store.findMaterial(userId,materialId);
 if(!material)return fail("material_not_found",404);
 const claimed=await store.claimTask(task.id,startedAt.toISOString(),new Date(startedAt.getTime()+taskLimits.leaseSeconds*1000).toISOString());
 if(!claimed)return fail("task_busy",409);
 // 抢占时 parse_attempts 会被 +1，重新读一次，后面所有 patch 和返回值都以库里的状态为准。
 const live=(await store.getTask(userId,taskId))??task;
 const bytes=await loadObject(material.storageKey);
 if(!bytes)return markFailed(store,live,"storage_missing","R2 object missing: "+material.storageKey);
 if(!bytes.length)return markFailed(store,live,"empty_file","zero byte object");
 if(bytes.length>maxFileBytes)return markFailed(store,live,"file_too_large","bytes="+bytes.length);
 const kind=detectKind(material.filename,material.contentType);
 if((kind==="pptx"||kind==="docx")&&!startsWith(bytes,ZIP_MAGIC))return markFailed(store,live,"content_type_mismatch","expected OOXML zip, got other bytes");
 if(kind==="pdf"&&!startsWith(bytes,PDF_MAGIC))return markFailed(store,live,"content_type_mismatch","expected %PDF- header");
 const digest=await sha256(bytes);
 // 分页续跑要求每次读到的都是同一份文件，否则前后批次的块会来自不同版本。
 if(live.sourceSha256&&live.sourceSha256!==digest)return markFailed(store,live,"source_changed","sha256 "+digest);
 let result:ExtractResult;
 try{result=await extractDocument({filename:material.filename,contentType:material.contentType,bytes,ocr:deps.ocr})}
 catch(error){
  const code=error instanceof ExtractError?error.code:"extract_failed";
  const detail=error instanceof Error?error.message:String(error);
  return markFailed(store,live,code,detail,{sourceSha256:digest,byteSize:bytes.length});
 }
 if(result.needsOcr){
  // 没有文字层且 OCR 暂不可用：明确落 needs_ocr，不产出任何块，也不假装解析成功。
  const patch:TaskPatch={parseStatus:"needs_ocr",parseEngine:result.engine,parseError:"",parseCursor:0,blockCount:0,pageCount:result.pageCount,truncated:result.truncated?1:0,sourceSha256:digest,byteSize:bytes.length,leaseUntil:"",updatedAt:new Date().toISOString()};
  await store.deleteBlocks(live.id);
  await store.updateTask(live.id,patch);
  return {ok:true,task:await viewOf(store,{...live,...patch}),written:0,done:true};
 }
 const blocks=result.blocks;
 if(!blocks.length)return markFailed(store,live,"empty_document","extractor returned 0 blocks",{parseEngine:result.engine,sourceSha256:digest,byteSize:bytes.length});
 const from=Math.min(live.parseCursor,blocks.length);
 let to=from,chars=0;
 while(to<blocks.length&&to-from<budget){
  chars+=blocks[to].charCount;
  to++;
  if(chars>=taskLimits.maxCharsPerRun)break;
 }
 const slice=blocks.slice(from,to);
 // 写入顺序：先删这一段旧行，再插入，最后才推进游标。
 // 三步不是原子的，但顺序保证「游标 ≤ 已落库内容」，任何一步中断后重跑都会先删再写，收敛且不产生重复块。
 await store.deleteBlockRange(live.id,from+1,to+1);
 await store.insertBlocks(slice.map((block)=>({
  id:crypto.randomUUID(),taskId:live.id,userId,materialId,courseId:material.courseId,ordinal:block.ordinal,
  locator:block.locator,locatorKind:block.locatorKind,locatorValue:block.locatorValue,heading:block.heading,text:block.text,charCount:block.charCount,
 })));
 const done=to>=blocks.length;
 const patch:TaskPatch={parseStatus:done?"ready":"running",parseEngine:result.engine,parseError:"",parseCursor:to,blockCount:blocks.length,pageCount:result.pageCount,truncated:result.truncated?1:0,sourceSha256:digest,byteSize:bytes.length,leaseUntil:"",updatedAt:new Date().toISOString()};
 await store.updateTask(live.id,patch);
 return {ok:true,task:await viewOf(store,{...live,...patch}),written:slice.length,done};
}
export async function retryParseTask(deps:{store:TaskStore},userId:string,materialId:string,taskId:string):Promise<RetryTaskResult>{
 const {store}=deps;
 const task=await store.getTask(userId,taskId);
 if(!task||task.materialId!==materialId)return fail("task_not_found",404);
 if(task.parseStatus!=="failed")return fail("task_not_failed",409);
 if(task.parseAttempts>=taskLimits.maxParseAttempts)return fail("retry_limit_reached",409);
 // 旧块必须清掉：块的 ordinal 与内容都来自上一次解析，留着会和新结果混在一起。
 await store.deleteBlocks(task.id);
 // 块被清空后，基于旧块生成的内容也失效了，所以连带把生成状态退回 pending。
 const patch:TaskPatch={parseStatus:"pending",parseEngine:"",parseError:"",parseCursor:0,blockCount:0,pageCount:0,truncated:0,leaseUntil:"",generateStatus:"pending",generateEngine:"",generateError:"",generateCursor:0,updatedAt:new Date().toISOString()};
 await store.updateTask(task.id,patch);
 return {ok:true,task:await viewOf(store,{...task,...patch})};
}
/**
 * 一次取多份资料已解析出来的正文，给「重点提炼」和「重点讲解」当上下文用。
 * 取的是每份资料最新一条可复用任务（找资料页的复用规则）：如果那条还在排队或没解析完，
 * 这份资料会被跳过并给出原因，而不是把旧任务的内容混进来。
 */
export const materialContextLimits={maxMaterials:6,maxBlocksPerMaterial:200,pageSize:50} as const;
export type MaterialContextPage={materialId:string;courseId:string;name:string;taskId:string;blocks:BlockRecord[];truncated:boolean};
export type MaterialSkipReason="material_not_found"|"not_ready"|"no_blocks";
export const materialSkipMessages:Record<MaterialSkipReason,string>={
 material_not_found:"找不到这份资料，或者它不属于你。",
 not_ready:"这份资料还没有解析完成：先在资料页把它解析完，再回来提炼重点。",
 no_blocks:"这份资料没有可用的正文（可能是扫描版 PDF，或内容为空）。",
};
export type MaterialContext={pages:MaterialContextPage[];skipped:{materialId:string;name:string;reason:MaterialSkipReason;message:string}[]};
export async function collectMaterialBlocks(deps:{store:TaskStore},userId:string,materialIds:string[],options:{maxMaterials?:number;maxBlocksPerMaterial?:number}={}):Promise<MaterialContext>{
 const store=deps.store,pages:MaterialContextPage[]=[],skipped:MaterialContext["skipped"]=[];
 const maxMaterials=Math.max(0,Math.min(options.maxMaterials??materialContextLimits.maxMaterials,materialContextLimits.maxMaterials));
 const maxBlocks=Math.max(1,options.maxBlocksPerMaterial??materialContextLimits.maxBlocksPerMaterial);
 const wanted=[...new Set(materialIds.filter(id=>!!id))].slice(0,maxMaterials);
 for(const materialId of wanted){
  const skip=(reason:MaterialSkipReason,name="")=>skipped.push({materialId,name,reason,message:materialSkipMessages[reason]});
  const material=await store.findMaterial(userId,materialId);
  if(!material){skip("material_not_found");continue}
  const task=await store.findReusableTask(userId,materialId);
  if(!task||task.parseStatus!=="ready"){skip("not_ready",material.name);continue}
  const blocks:BlockRecord[]=[];
  while(blocks.length<maxBlocks){
   const page=await store.listBlocks(userId,task.id,blocks.length+1,Math.min(materialContextLimits.pageSize,maxBlocks-blocks.length));
   if(!page.length)break;
   blocks.push(...page);
  }
  if(!blocks.length){skip("no_blocks",material.name);continue}
  pages.push({materialId,courseId:material.courseId,name:material.name,taskId:task.id,blocks,truncated:!!task.truncated||blocks.length>=maxBlocks});
 }
 return {pages,skipped};
}
/** 把取到的块拍平成「带来源的正文行」，给重点提炼和讲解当输入。 */
export function blocksToContext(context:MaterialContext){
 const blocks=context.pages.flatMap(page=>page.blocks.map(block=>({materialId:page.materialId,courseId:page.courseId,locator:block.locator,locatorKind:block.locatorKind,locatorValue:block.locatorValue,heading:block.heading,text:block.text})));
 return {blocks,text:blocks.map(block=>(block.heading?"【"+block.heading+"】":"")+block.text).join("\n").slice(0,12000)};
}
/** 预览时分页取块。ordinal 从 1 开始，和写入时的编号一致。 */
export const blockPageLimits={min:1,max:50,default:20} as const;
export type BlockPage={from:number;limit:number;total:number;hasMore:boolean;blocks:BlockRecord[]};
export type ListBlocksResult={ok:true;task:TaskView;page:BlockPage}|TaskFailure;
export async function listTaskBlocks(deps:{store:TaskStore},userId:string,materialId:string,taskId:string,options:{from?:number;limit?:number}={}):Promise<ListBlocksResult>{
 const {store}=deps;
 const task=await store.getTask(userId,taskId);
 // 和 readParseTask 同样的归属判断：任务不存在、不属于这个用户、或不挂在这份资料下，一律 404。
 if(!task||task.materialId!==materialId)return fail("task_not_found",404);
 const limit=Math.min(Math.max(Math.trunc(options.limit??blockPageLimits.default)||blockPageLimits.default,blockPageLimits.min),blockPageLimits.max);
 const from=Math.max(1,Math.trunc(options.from??1)||1);
 const total=await store.countBlocks(taskId);
 const blocks=await store.listBlocks(userId,taskId,from,limit);
 const last=blocks.length?blocks[blocks.length-1].ordinal:0;
 return {ok:true,task:await viewOf(store,task),page:{from,limit,total,hasMore:blocks.length>0&&last<total,blocks}};
}
