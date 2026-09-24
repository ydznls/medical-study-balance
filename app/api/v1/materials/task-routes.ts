// 解析任务各路由共用的鉴权、依赖装配和错误序列化。
// 放在 materials/ 下而不是 lib/：它依赖 next/headers 与 cloudflare:workers 这两个 app 层能力。
import { env } from "cloudflare:workers";
import { getChatGPTUser,type ChatGPTUser } from "@/app/chatgpt-auth";
import { getStateDb } from "@/db/state";
import { d1TaskStore } from "@/lib/task-store";
import type { TaskDeps,TaskFailure } from "@/lib/material-task";
import { providerFromEnv } from "@/lib/ai-provider";
import { ocrPdf } from "@/lib/pdf-ocr";
export const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
export function taskStore(){return d1TaskStore(getStateDb())}
export function taskDeps(maxBlocksPerRun?:number):TaskDeps{
 const bucket=env.BUCKET;
 const provider=providerFromEnv(env);
 return {
  store:taskStore(),
  maxBlocksPerRun,
  ocr:(input)=>ocrPdf(provider,input),
  loadObject:async(key:string)=>{
   if(!bucket)throw new Error("R2 binding unavailable");
   const object=await bucket.get(key);
   return object?new Uint8Array(await object.arrayBuffer()):null;
  },
 };
}
/** 登录 + 同源检查。返回 Response 表示应当直接结束请求。 */
export async function guard(request:Request,{origin=true}={}):Promise<{ok:true;user:ChatGPTUser}|{ok:false;response:Response}>{
 const user=await getChatGPTUser();
 if(!user)return {ok:false,response:json({error:"authentication_required",message:"请先登录。"},401)};
 if(origin){
  const value=request.headers.get("origin");
  if(value&&value!==new URL(request.url).origin)return {ok:false,response:json({error:"origin_not_allowed",message:"请求来源不符。"},403)};
 }
 return {ok:true,user};
}
/** 任务失败统一按 {error: 稳定错误码, message: 中文说明} 返回，detail 只写日志不外泄。 */
export function failResponse(failure:TaskFailure){
 if(failure.detail)console.error("material task error",failure.error,failure.detail);
 return json({error:failure.error,message:failure.message},failure.status);
}
export function unavailable(error:unknown,what:string){
 console.error(what,error);
 return json({error:"temporarily_unavailable",message:"暂时无法处理解析任务，请稍后重试。"},503);
}
