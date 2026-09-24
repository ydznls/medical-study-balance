// GET /api/v1/materials/:id/tasks/:taskId —— 解析任务状态。
// 返回状态、引擎、错误码与说明、分页进度（已写入 / 总块数 / 库里实际块数）、页数、是否截断、是否需要 OCR。
import { readParseTask } from "@/lib/material-task";
import { failResponse,guard,json,taskStore,unavailable } from "../../../task-routes";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string;taskId:string}>}){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const {id,taskId}=await params;
 try{
  const result=await readParseTask({store:taskStore()},checked.user.userId,id,taskId);
  return result.ok?json({task:result.task}):failResponse(result);
 }catch(error){return unavailable(error,"read parse task failed")}
}
