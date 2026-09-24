// GET  /api/v1/explain —— 说明当前用的是哪个 provider、四段式是哪四段、有没有配置真实模型。
// POST /api/v1/explain —— 重点 + 问题 → 四段式讲解（框架 / 机制与因果 / 举例 / 问题检查）。
// 没有配置模型时返回本地模板，页面永远不会空白；配置好后同一个接口直接换成模型生成，四段结构不变。
import { aiStatus, aiConfigFrom, defaultAiModel, providerFromEnv } from "@/lib/ai-provider";
import { explainInputSchema, type ExplainInput } from "@/lib/coach-api";
import { buildCoachContext } from "@/lib/coach-context";
import { explainLimits, explainSectionNames, explainSectionOrder, explainStyle, explainTopic } from "@/lib/explain";
import { taskStore } from "../materials/task-routes";
import { aiEnv, coachUnavailable, guard, invalid, invalidFrom, json, readJsonBody, readState, realDate } from "../coach-routes";
export const dynamic="force-dynamic";
export async function GET(request:Request){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const config=aiConfigFrom(aiEnv());
 return json({
  apiVersion:"v1",style:explainStyle,defaultModel:defaultAiModel,
  sections:explainSectionOrder.map((key,index)=>({key,title:explainSectionNames[key],order:index+1})),
  ai:aiStatus(config),limits:explainLimits,
  note:"没配置模型时返回本地模板（规则生成的脚手架），配置 AI_BASE_URL / AI_API_KEY / AI_MODEL 后同一接口由模型生成，四段结构不变。",
 });
}
export async function POST(request:Request){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const body=await readJsonBody(request);
 if(!body.ok)return body.response;
 let input:ExplainInput;
 try{input=explainInputSchema.parse(JSON.parse(body.raw||"{}"))}catch(error){return invalidFrom(error,"请求内容有误：topic 是必填的，长度不超过 200 字。")}
 if(input.date&&!realDate(input.date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 try{
  const loaded=await readState(checked.user.userId);
  if(!loaded.ok)return loaded.response;
  const course=loaded.state.courses.find(item=>item.id===input.courseId);
  const built=await buildCoachContext({store:taskStore()},checked.user.userId,loaded.state,{courseId:input.courseId,materialIds:input.materialIds,text:input.text,includeGaps:true,includeAttempts:true});
  const config=aiConfigFrom(aiEnv()),provider=providerFromEnv(aiEnv());
  const result=await explainTopic(provider,{
   topic:input.topic,question:input.question,courseId:input.courseId,
   courseName:course?.name,context:built.text,points:input.points,style:explainStyle,
  });
  return json({apiVersion:"v1",...result,ai:aiStatus(config),sources:built.sources,materials:built.materials,skipped:built.skipped,notes:built.notes});
 }catch(error){return coachUnavailable(error,"explain failed")}
}
