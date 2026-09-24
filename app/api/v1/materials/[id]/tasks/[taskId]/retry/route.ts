// POST /api/v1/materials/:id/tasks/:taskId/retry —— 只允许失败任务重跑。
// 会清空旧块并把分页游标归零，同时把生成状态一并退回 pending（旧块已不存在，旧候选题失去依据）。
import { retryParseTask } from "@/lib/material-task";
import { failResponse,guard,json,taskStore,unavailable } from "../../../../task-routes";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string;taskId:string}>}){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const {id,taskId}=await params;
 try{
  const result=await retryParseTask({store:taskStore()},checked.user.userId,id,taskId);
  return result.ok?json({task:result.task}):failResponse(result);
 }catch(error){return unavailable(error,"retry parse task failed")}
}
