// GET /api/v1/materials/:id/tasks/:taskId/blocks?from=1&limit=20 —— 分页读取解析出的文本块。
// 给前端的「查看解析内容」用：只返回定位信息、标题和正文，不返回内部字段。
// 归属校验和任务状态接口完全一致：任务不属于当前用户、或不属于这份资料，一律 404。
import { listTaskBlocks } from "@/lib/material-task";
import { failResponse,guard,json,taskStore,unavailable } from "../../../../task-routes";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string;taskId:string}>}){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const {id,taskId}=await params;
 const query=new URL(request.url).searchParams;
 // 非数字或越界的值由服务层夹到合法区间，这里只负责把「没写」和「写错」都变成 undefined。
 const number=(name:string)=>{const raw=query.get(name);if(raw===null||raw.trim()==="")return undefined;const value=Number(raw);return Number.isInteger(value)?value:undefined};
 try{
  const result=await listTaskBlocks({store:taskStore()},checked.user.userId,id,taskId,{from:number("from"),limit:number("limit")});
  if(!result.ok)return failResponse(result);
  const {blocks,from,limit,total,hasMore}=result.page;
  return json({task:result.task,blocks:blocks.map(block=>({ordinal:block.ordinal,locator:block.locator,locatorKind:block.locatorKind,locatorValue:block.locatorValue,heading:block.heading,text:block.text,charCount:block.charCount})),from,limit,total,hasMore});
 }catch(error){return unavailable(error,"list task blocks failed")}
}
