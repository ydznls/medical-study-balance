import { getChatGPTUser } from "@/app/chatgpt-auth";
import { stateSchema } from "@/lib/balance";
import { getStateDb } from "@/db/state";
import { z } from "zod";
export const dynamic="force-dynamic";
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
export async function GET(){
 const user=await getChatGPTUser();if(!user)return json({error:"请先登录后使用。"},401);
 try{const row=await getStateDb().prepare("SELECT payload, revision FROM balance_state WHERE user_id = ?").bind(user.userId).first<{payload:string;revision:number}>();return json({state:row?JSON.parse(row.payload):null,revision:row?.revision??0})}
 catch(e){console.error("balance read failed",e);return json({error:"暂时无法读取记录，请稍后重试。"},503)}
}
export async function PUT(request:Request){
 const user=await getChatGPTUser();if(!user)return json({error:"登录已过期，请重新登录。"},401);
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"请求来源不符。"},403);
 let value;
 try{const raw=await request.text();if(raw.length>2000000)return json({error:"记录过大，请先整理较早的历史记录。"},413);value=z.object({revision:z.number().int().min(0),state:stateSchema}).parse(JSON.parse(raw))}
 catch{return json({error:"记录格式有误，请检查输入范围和课程关联。"},400)}
 try{
 const db=getStateDb(),payload=JSON.stringify(value.state);
 const result=value.revision===0?await db.prepare("INSERT OR IGNORE INTO balance_state (user_id, payload, revision, updated_at) VALUES (?, ?, 1, ?)").bind(user.userId,payload,new Date().toISOString()).run():await db.prepare("UPDATE balance_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?").bind(payload,new Date().toISOString(),user.userId,value.revision).run();
 if(!result.meta.changes)return json({error:"另一窗口更新了记录。请先刷新记录，再重新保存。"},409);
 return json({revision:value.revision+1});
 }catch(e){console.error("balance write failed",e);return json({error:"保存未成功，你的输入仍在当前页面。请重试。"},503)}
}

