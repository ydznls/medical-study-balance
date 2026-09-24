import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getStateDb } from "@/db/state";
import { fileTypes,maxFileBytes } from "@/lib/library";
import { taskMessage } from "@/lib/material-task";
import type { MaterialTaskStatus,TaskSummary } from "@/lib/material-task-view";
import { z } from "zod";
export const dynamic="force-dynamic";
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
/**
 * 列表里的解析摘要，返回类型就是前端 describeTask 吃的 TaskSummary，字段对不上会在这里编译失败。
 * storedBlocks 只在 ready 时用 block_count 代替：那时游标已经走完，落库块数等于总块数，
 * 省掉一次按 task_id 的聚合查询；其它状态界面不显示这个数。
 */
function summaryOf(task:TaskRow|undefined):TaskSummary|null{
 if(!task)return null;
 return {id:task.id,parseStatus:task.parseStatus,parseEngine:task.parseEngine,parseError:task.parseError,parseMessage:task.parseError?taskMessage(task.parseError):"",writtenBlocks:task.writtenBlocks,totalBlocks:task.totalBlocks,storedBlocks:task.parseStatus==="ready"?task.totalBlocks:0,pageCount:task.pageCount,truncated:!!task.truncated,needsOcr:task.parseStatus==="needs_ocr"};
}
const fields=z.object({courseId:z.string().min(1).max(80),name:z.string().trim().min(1).max(160),kind:z.enum(["ppt","textbook","bank","other"]),location:z.string().max(300),url:z.union([z.literal(""),z.string().url().max(2000).refine(v=>new URL(v).protocol==="https:")])});
type TaskRow={id:string;materialId:string;parseStatus:MaterialTaskStatus;parseEngine:string;parseError:string;writtenBlocks:number;totalBlocks:number;pageCount:number;truncated:number};
export async function GET(){
 const user=await getChatGPTUser();if(!user)return json({error:"请先登录。"},401);
 try{
  const db=getStateDb();
  // hasFile 只暴露「有没有上传文件」这个布尔值，不外泄 storage_key 本身；前端用它决定解析按钮是否可点。
  const list=await db.prepare("SELECT id,course_id AS courseId,name,kind,location,filename,size,url,storage_key <> '' AS hasFile,created_at AS createdAt FROM materials WHERE user_id = ? ORDER BY created_at DESC").bind(user.userId).all<{id:string;hasFile:number}&Record<string,unknown>>();
  // 每份资料带上最近一条解析任务的状态，列表页刷新后仍能看到「已解析 / 需要 OCR」，不用逐个再查一次。
  // 任务另查一条再在内存里归并，而不是 JOIN：created_at 相同时 JOIN 会让同一份资料出现两行。
  const tasks=await db.prepare("SELECT id,material_id AS materialId,parse_status AS parseStatus,parse_engine AS parseEngine,parse_error AS parseError,parse_cursor AS writtenBlocks,block_count AS totalBlocks,page_count AS pageCount,truncated FROM material_tasks WHERE user_id = ? ORDER BY created_at DESC").bind(user.userId).all<TaskRow>();
  const latest=new Map<string,TaskRow>();
  for(const task of tasks.results)if(!latest.has(task.materialId))latest.set(task.materialId,task);
  return json({materials:list.results.map(material=>({...material,hasFile:!!material.hasFile,parse:summaryOf(latest.get(material.id))}))});
 }catch{return json({error:"资料库暂时无法读取，请重试。"},503)}
}
export async function POST(request:Request){
 const user=await getChatGPTUser();if(!user)return json({error:"请先登录。"},401);
 if(request.headers.get("origin")&&request.headers.get("origin")!==new URL(request.url).origin)return json({error:"请求来源不符。"},403);
 if(Number(request.headers.get("content-length"))>maxFileBytes+65536)return json({error:"单个文件最大 20 MB。"},413);
 let form:FormData;
 try{const reader=request.body?.getReader();if(!reader)return json({error:"没有收到资料。"},400);const chunks:Uint8Array[]=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxFileBytes+65536){await reader.cancel();return json({error:"单个文件最大 20 MB。"},413)}chunks.push(part.value)}form=await new Response(new Blob(chunks as BlobPart[]),{headers:{"Content-Type":request.headers.get("content-type")??""}}).formData()}catch{return json({error:"上传格式有误。"},400)}
 const parsed=fields.safeParse(Object.fromEntries(["courseId","name","kind","location","url"].map(k=>[k,String(form.get(k)??"")])));
 if(!parsed.success)return json({error:"请填写名称、课程和有效的 HTTPS 链接。"},400);
 const input=parsed.data,file=form.get("file");const hasFile=file instanceof File&&file.size>0;
 if(hasFile===!!input.url)return json({error:"请选择一个文件，或填写一个链接。"},400);
 let filename="",contentType="",size=0;
 if(hasFile){filename=file.name.replace(/[\r\n]/g,"").slice(0,240);contentType=fileTypes[filename.split(".").pop()?.toLowerCase()??""];size=file.size;if(!contentType)return json({error:"支持 PDF、PPT、PPTX、Word、TXT 和 EPUB。"},400);if(size>maxFileBytes)return json({error:"单个文件最大 20 MB。"},413);if(!env.BUCKET)return json({error:"文件存储暂未准备好，请稍后重试。"},503)}
 const db=getStateDb(),id=crypto.randomUUID(),key=hasFile?"materials/"+id:"";
 try{
 const state=await db.prepare("SELECT payload FROM balance_state WHERE user_id = ?").bind(user.userId).first<{payload:string}>();
 if(!state||!JSON.parse(state.payload).courses.some((c:{id:string})=>c.id===input.courseId))return json({error:"请先建立自己的一周并添加这门课程。"},400);
 if(hasFile)await env.BUCKET!.put(key,await file.arrayBuffer(),{httpMetadata:{contentType}});
 await db.prepare("INSERT INTO materials (id,user_id,course_id,name,kind,location,filename,content_type,size,storage_key,url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,user.userId,input.courseId,input.name,input.kind,input.location,filename,contentType,size,key,input.url,new Date().toISOString()).run();
 return json({id},201);
 }catch{if(key)try{await env.BUCKET?.delete(key)}catch{}return json({error:"资料未能保存，请重试。"},503)}
}
