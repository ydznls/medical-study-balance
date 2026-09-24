// POST /api/v1/materials/:id/tasks —— 为当前用户的资料创建或复用一个解析任务。
// 幂等：同一资料已存在 pending / running / ready / needs_ocr 任务时原样返回，不新建。
// 失败任务的重新解析走 .../:taskId/retry；这里会新建一个任务（旧任务保留可查）。
import { createParseTask } from "@/lib/material-task";
import { failResponse,guard,json,taskStore,unavailable } from "../../task-routes";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const {id}=await params;
 try{
  const result=await createParseTask({store:taskStore()},checked.user.userId,id);
  return result.ok?json({task:result.task,created:result.created},result.created?201:200):failResponse(result);
 }catch(error){return unavailable(error,"create parse task failed")}
}
