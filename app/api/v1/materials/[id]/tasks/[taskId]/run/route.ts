// POST /api/v1/materials/:id/tasks/:taskId/run —— 分步执行解析。
// 每次调用有明确预算（默认 800 块 / 150 万字符），返回 written 与 done；未完成时再调一次继续。
// 幂等：已完成的任务重复调用只返回现状；重复执行同一段会先删掉该段旧行再写，不产生重复块。
// 解析失败（文件损坏、需要 OCR 等）以 200 + task.parseStatus 返回，失败的是任务、不是请求。
import { runParseTask,taskLimits } from "@/lib/material-task";
import { failResponse,guard,json,taskDeps,unavailable } from "../../../../task-routes";
import { z } from "zod";
export const dynamic="force-dynamic";
// 客户端只能把单次预算往「大」调到服务端上限之内，不能调小：
// 每次 run 都会重新解析整个文件，允许 maxBlocks=1 就等于把 CPU 放大成块数倍。
const minBlocksPerRun=200;
const bodySchema=z.object({maxBlocks:z.number().int().min(minBlocksPerRun).max(taskLimits.maxBlocksPerRun).optional()}).strict();
export async function POST(request:Request,{params}:{params:Promise<{id:string;taskId:string}>}){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const {id,taskId}=await params;
 let maxBlocks:number|undefined;
 try{
  const raw=await request.text();
  if(raw.length>512)return json({error:"request_too_large",message:"请求过大。"},413);
  if(raw.trim())maxBlocks=bodySchema.parse(JSON.parse(raw)).maxBlocks;
 }catch{return json({error:"invalid_request",message:"请求格式有误。"},400)}
 try{
  const result=await runParseTask(taskDeps(maxBlocks),checked.user.userId,id,taskId);
  return result.ok?json({task:result.task,written:result.written,done:result.done}):failResponse(result);
 }catch(error){return unavailable(error,"run parse task failed")}
}
