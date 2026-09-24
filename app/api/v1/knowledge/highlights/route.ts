// GET/POST /api/v1/knowledge/highlights —— 提炼「本周重点 / 高频考点 / 未掌握点」。
// 素材：已解析的资料块（按勾选的资料，带原文位置）、用户粘贴的文本、卡点记录、做错过的题。
// 全部按规则生成，不调用模型；每条重点都能指回原句，返回里的 sources 就是这些来源位置。
// 不写库：提炼结果是候选，用户确认后才会变成知识点（走已有的 /api/state 保存）。
import { today, weekOf } from "@/lib/balance";
import { highlightsInputSchema, idList, type HighlightsInput } from "@/lib/coach-api";
import { buildCoachContext, coachContextLimits } from "@/lib/coach-context";
import { extractHighlights, highlightKindHints, highlightKindNames, highlightLimits, type HighlightKind } from "@/lib/highlights";
import { taskStore } from "../../materials/task-routes";
import { boolParam, coachUnavailable, guard, intParam, invalid, invalidFrom, json, readJsonBody, readState, realDate, textParam } from "../../coach-routes";
export const dynamic="force-dynamic";
/** 三类重点的名字、解释和上限，让客户端不用自己维护一份文案。route 文件只能导出 HTTP 方法，所以这里不 export。 */
const highlightKinds=(Object.keys(highlightKindNames) as HighlightKind[]).map(kind=>({kind,name:highlightKindNames[kind],hint:highlightKindHints[kind],limit:highlightLimits[kind]}));
export async function GET(request:Request){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const query=new URL(request.url).searchParams,date=query.get("date")??today();
 if(!realDate(date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 const limit=intParam(query.get("maxBlocksPerMaterial"),{min:1,max:coachContextLimits.maxBlocksPerMaterial});
 return respond(checked.user.userId,{
  courseId:textParam(query.get("courseId"),80),
  date,
  materialIds:idList(query.get("materialIds")),
  text:textParam(query.get("text"),20000),
  includeGaps:query.has("includeGaps")?boolParam(query.get("includeGaps")):undefined,
  includeAttempts:query.has("includeAttempts")?boolParam(query.get("includeAttempts")):undefined,
  maxBlocksPerMaterial:limit,
 });
}
export async function POST(request:Request){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const body=await readJsonBody(request);
 if(!body.ok)return body.response;
 let input:HighlightsInput;
 try{input=highlightsInputSchema.parse(JSON.parse(body.raw||"{}"))}catch(error){return invalidFrom(error)}
 if(input.date&&!realDate(input.date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 return respond(checked.user.userId,input);
}
async function respond(userId:string,input:HighlightsInput){
 try{
  const loaded=await readState(userId);
  if(!loaded.ok)return loaded.response;
  const {courseId,text,materialIds,includeGaps,includeAttempts,maxBlocksPerMaterial}=input;
  const built=await buildCoachContext({store:taskStore()},userId,loaded.state,{courseId,text,materialIds,includeGaps,includeAttempts,maxBlocksPerMaterial});
  const result=extractHighlights({courseId:input.courseId,blocks:built.blocks,gaps:built.gaps,attempts:built.attempts});
  const date=input.date??today();
  return json({
   apiVersion:"v1",engine:"rules",date,week:weekOf(date),courseId:input.courseId??"",
   highlights:result.highlights,counts:result.counts,kinds:highlightKinds,notes:[...built.notes,...result.notes],scanned:result.scanned,
   materials:built.materials,skipped:built.skipped,sources:built.sources,limits:{maxMaterials:coachContextLimits.maxMaterials,maxBlocksPerMaterial:coachContextLimits.maxBlocksPerMaterial},
  });
 }catch(error){return coachUnavailable(error,"extract highlights failed")}
}
