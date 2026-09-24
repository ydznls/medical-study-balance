// 重点提炼和重点讲解共用的上下文装配：把「勾了哪几份资料 / 粘了什么文本 / 自己记过什么卡点和错题」
// 变成一组带来源的正文，外加未掌握点。纯逻辑，存储通过注入的 TaskStore 访问，方便直接测。
import type { State } from "./balance.ts";
import type { HighlightAttempt, HighlightBlock, HighlightGap } from "./highlights.ts";
import { blocksToContext, collectMaterialBlocks, type MaterialContext } from "./material-task.ts";
import type { TaskStore } from "./task-store.ts";
export const coachContextLimits={maxMaterials:6,maxBlocksPerMaterial:200,maxGaps:30,maxAttempts:20,maxSources:40} as const;
export type CoachContextInput={
 courseId?:string;
 materialIds?:string[];
 text?:string;
 includeGaps?:boolean;
 includeAttempts?:boolean;
 maxBlocksPerMaterial?:number;
};
export type CoachSource={materialId:string;locator:string;locatorKind:string;heading:string};
export type CoachMaterial={materialId:string;courseId:string;name:string;taskId:string;blocks:number;truncated:boolean};
export type CoachContext={
 blocks:HighlightBlock[];
 text:string;
 gaps:HighlightGap[];
 attempts:HighlightAttempt[];
 materials:CoachMaterial[];
 skipped:MaterialContext["skipped"];
 sources:CoachSource[];
 notes:string[];
};
/** 错题按题去重，只留做错次数最多的那几道：复习时先处理反复错的那几道才有价值。 */
export function wrongAttempts(state:State,courseId?:string,limit=coachContextLimits.maxAttempts):HighlightAttempt[]{
 const wrong=new Map<string,number>();
 for(const attempt of state.attempts)if(!attempt.correct)wrong.set(attempt.questionId,(wrong.get(attempt.questionId)??0)+1);
 return [...wrong].flatMap(([questionId,count])=>{
  const question=state.questions.find(item=>item.id===questionId);
  if(!question||(courseId&&question.courseId!==courseId))return [];
  return [{questionId,courseId:question.courseId,prompt:question.prompt,wrong:count}];
 }).sort((a,b)=>b.wrong-a.wrong).slice(0,limit);
}
export function openGaps(state:State,courseId?:string,limit=coachContextLimits.maxGaps):HighlightGap[]{
 return state.gaps.filter(gap=>gap.status!=="resolved"&&(!courseId||gap.courseId===courseId))
  .map(gap=>({id:gap.id,courseId:gap.courseId,question:gap.question,risk:gap.risk,status:gap.status}))
  .sort((a,b)=>(a.risk===b.risk?0:a.risk==="high"?-1:1)).slice(0,limit);
}
export async function buildCoachContext(deps:{store:TaskStore},userId:string,state:State,input:CoachContextInput):Promise<CoachContext>{
 const materialIds=(input.materialIds??[]).filter(id=>!!id);
 const collected=materialIds.length?await collectMaterialBlocks(deps,userId,materialIds,{maxMaterials:coachContextLimits.maxMaterials,maxBlocksPerMaterial:input.maxBlocksPerMaterial??coachContextLimits.maxBlocksPerMaterial}):{pages:[],skipped:[]};
 const flattened=blocksToContext(collected);
 const pasted=(input.text??"").trim().slice(0,12000);
 const sources:CoachSource[]=[];
 for(const block of flattened.blocks){
  if(sources.length>=coachContextLimits.maxSources)break;
  if(sources.some(source=>source.materialId===block.materialId&&source.locator===block.locator))continue;
  sources.push({materialId:block.materialId,locator:block.locator,locatorKind:block.locatorKind,heading:block.heading});
 }
 const notes:string[]=[];
 if(!flattened.blocks.length&&!pasted)notes.push("这次没有可用的资料正文：讲解和提炼只能依赖你自己记录的卡点和错题。");
 if(materialIds.length&&!flattened.blocks.length)notes.push("选中的资料都没有解析好的正文，先回资料页把它们解析完。");
 return {
  blocks:flattened.blocks,
  // 没有资料正文时不要以换行开头：粘进来的文本本身就是完整的上下文。
  text:pasted?[flattened.text,pasted].filter(Boolean).join("\n"):flattened.text,
  gaps:input.includeGaps===false?[]:openGaps(state,input.courseId),
  attempts:input.includeAttempts===false?[]:wrongAttempts(state,input.courseId),
  materials:collected.pages.map(page=>({materialId:page.materialId,courseId:page.courseId,name:page.name,taskId:page.taskId,blocks:page.blocks.length,truncated:page.truncated})),
  skipped:collected.skipped,
  sources,
  notes,
 };
}
