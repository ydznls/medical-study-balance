import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getStateDb } from "@/db/state";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await getChatGPTUser();if(!user)return Response.json({error:"请先登录。"},{status:401});
 try{const {id}=await params;const row=await getStateDb().prepare("SELECT filename,content_type,storage_key,url FROM materials WHERE id = ? AND user_id = ?").bind(id,user.userId).first<{filename:string;content_type:string;storage_key:string;url:string}>();
 if(!row)return Response.json({error:"找不到这份资料。"},{status:404});
 if(row.url)return Response.redirect(row.url,302);
 const object=await env.BUCKET?.get(row.storage_key);if(!object)return Response.json({error:"文件暂时无法读取。"},{status:503});
 return new Response(object.body,{headers:{"Content-Type":row.content_type,"Content-Length":String(object.size),"Content-Disposition":(row.content_type==="application/pdf"?"inline":"attachment")+"; filename*=UTF-8''"+encodeURIComponent(row.filename),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"sandbox"}});
 }catch{return Response.json({error:"文件暂时无法读取，请重试。"},{status:503})}
}
