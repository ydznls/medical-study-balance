// 学习教练各路由共用的鉴权、状态读写、参数解析和错误序列化。
// 放在 app/api/v1/ 下而不是 lib/：它依赖 next/headers 与 cloudflare:workers 这两个 app 层能力。
// 鉴权和同源检查直接复用资料路由那一套（app/api/v1/materials/task-routes.ts），不另写一份。
import { env } from "cloudflare:workers";
import { getStateDb } from "@/db/state";
import { stateSchema, type State } from "@/lib/balance";
import { z } from "zod";
export { guard, json } from "./materials/task-routes";
export const coachLimits={bodyBytes:200000};
export type StateRow={payload:string;revision:number};
/** 读当前用户的记录。没有记录时返回 409，和 /api/v1/plan 的行为保持一致。 */
export async function readState(userId:string):Promise<{ok:true;revision:number;state:State}|{ok:false;response:Response}>{
 const row=await getStateDb().prepare("SELECT payload, revision FROM balance_state WHERE user_id = ?").bind(userId).first<StateRow>();
 if(!row)return {ok:false,response:Response.json({error:"setup_required",message:"请先在页面建立我的一周。"},{status:409,headers:{"Cache-Control":"no-store"}})};
 const parsed=stateSchema.safeParse(JSON.parse(row.payload));
 if(!parsed.success)return {ok:false,response:Response.json({error:"state_invalid",message:"已保存的记录没有通过校验，请先在页面里检查一遍。"},{status:409,headers:{"Cache-Control":"no-store"}})};
 return {ok:true,revision:row.revision,state:parsed.data};
}
/** 写入沿用 /api/state 的乐观并发：revision 0 表示首次写入，冲突返回 409 由客户端刷新。 */
export async function writeState(userId:string,revision:number,state:State):Promise<{ok:true;revision:number}|{ok:false;conflict:boolean}>{
 const db=getStateDb(),payload=JSON.stringify(state),now=new Date().toISOString();
 const result=revision===0
  ?await db.prepare("INSERT OR IGNORE INTO balance_state (user_id, payload, revision, updated_at) VALUES (?, ?, 1, ?)").bind(userId,payload,now).run()
  :await db.prepare("UPDATE balance_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?").bind(payload,now,userId,revision).run();
 if(!result.meta.changes)return {ok:false,conflict:true};
 return {ok:true,revision:revision+1};
}
export function coachUnavailable(error:unknown,what:string){
 console.error(what,error);
 return Response.json({error:"temporarily_unavailable",message:"暂时无法生成计划，请稍后重试。"},{status:503,headers:{"Cache-Control":"no-store"}});
}
export function tooLarge(){
 return Response.json({error:"request_too_large",message:"请求内容过大，请减少一次提交的资料量。"},{status:413,headers:{"Cache-Control":"no-store"}});
}
export function invalid(message="请求内容有误，请检查日期、时间和课程关联。"){
 return Response.json({error:"invalid_request",message},{status:400,headers:{"Cache-Control":"no-store"}});
}
/** 校验失败的说明用第一条中文信息（schema 里的自定义 message 都是中文），英文默认信息换成通用文案。 */
export function invalidFrom(error:unknown,fallback="请求内容有误，请检查日期、时间和课程关联。"){
 const message=error instanceof z.ZodError?error.issues.find(issue=>/[一-龥]/.test(issue.message))?.message:undefined;
 return invalid(message??fallback);
}
/** 读 JSON 体并限长。返回字符串便于路由自己决定用哪个 schema。 */
export async function readJsonBody(request:Request):Promise<{ok:true;raw:string}|{ok:false;response:Response}>{
 const raw=await request.text();
 if(raw.length>coachLimits.bodyBytes)return {ok:false,response:tooLarge()};
 return {ok:true,raw};
}
/** 日期与模式这些请求契约定义在 lib/coach-api.ts（纯逻辑，可被测试直接断言），这里只做转出。 */
export { dayValue, realDate } from "@/lib/coach-api";
export function intParam(value:string|null,{min,max}:{min:number;max:number}){
 if(value===null||value.trim()==="")return undefined;
 const number=Number(value);
 if(!Number.isFinite(number))return undefined;
 return Math.min(max,Math.max(min,Math.trunc(number)));
}
export function boolParam(value:string|null){return value==="1"||value==="true"}
export function textParam(value:string|null,max:number){return value?value.slice(0,max):undefined}
export function aiEnv(){return env}
