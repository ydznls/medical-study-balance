// 学习节奏：课前预习 10 分钟、课后复习 30 分钟、周末深度复习 2 小时是基准值，
// 实际时长按本周负荷、掌握度、距考试天数和当天可用时间动态调整。
// 这里只有纯函数：不读状态、不发请求，输入相同则输出相同，方便直接断言与解释「为什么是这个时长」。
import { daysUntil, type Course, type Mode, type State } from "./balance.ts";
export type RhythmKind="preview"|"review"|"deep";
export const rhythmKindNames:Record<RhythmKind,string>={preview:"课前预习",review:"课后复习",deep:"周末深度复习"};
/** 基准时长（分钟）。调整只在这个基准上做乘法和夹取，不做凭空的数值。 */
export const rhythmBase:Record<RhythmKind,number>={preview:10,review:30,deep:120};
export const rhythmBounds:Record<RhythmKind,[number,number]>={preview:[5,30],review:[10,90],deep:[30,240]};
export const rhythmMinimums:Record<RhythmKind,string>={
 preview:"带着 2 个问题进课堂：这节课要解决什么、和上一节的关系。",
 review:"写下一句「今天讲了什么」，再补一个卡点就够。",
 deep:"框架压缩 → 问题池 → 闭卷回忆 → 长期记忆点，四步都留下记录。",
};
export type RhythmFactor={key:string;label:string;factor:number};
export type RhythmContext={mode:Mode;mastery:number;daysToExam:number|null;openGaps?:number;freeMinutes?:number};
export type RhythmResult={minutes:number;base:number;factors:RhythmFactor[];capped:boolean;reason:string};
export type RhythmBlock=RhythmResult&{kind:RhythmKind;courseId:string;label:string;minimum:string};
const step=5;
function round5(n:number){return Math.max(0,Math.round(n/step)*step)}
/**
 * 每个系数都带一句人话，界面直接显示这些句子，用户就能看懂时长是怎么来的。
 * 掌握度未知（-1）时不参与调整：宁可给基准值，也不要假装知道。
 */
export function rhythmFactors(kind:RhythmKind,ctx:RhythmContext):RhythmFactor[]{
 const factors:RhythmFactor[]=[];
 if(ctx.mastery>=0){
  if(ctx.mastery===0)factors.push({key:"mastery",label:"还没有建立起印象",factor:1.3});
  else if(ctx.mastery===1)factors.push({key:"mastery",label:"只停在有印象",factor:1.15});
  else if(ctx.mastery>=3)factors.push({key:"mastery",label:"已经能应用，做保持即可",factor:.85});
 }
 if(ctx.mode==="busy")factors.push({key:"mode",label:"忙周：只保留最小闭环",factor:kind==="deep"?.5:.6});
 else if(ctx.mode==="exam")factors.push({key:"mode",label:"考试周：加大投入",factor:kind==="preview"?.8:1.2});
 const days=ctx.daysToExam;
 if(days!==null&&days>=0){
  if(days<=7)factors.push({key:"exam",label:"距考试 "+days+" 天",factor:1.3});
  else if(days<=21)factors.push({key:"exam",label:"距考试 "+days+" 天",factor:1.1});
  else if(days>42)factors.push({key:"exam",label:"距考试还有 "+days+" 天，先保持",factor:.9});
 }
 // 预习不掺入问题池：带着没解决的问题进课堂，只会让预习变成第二次补课。
 if((ctx.openGaps??0)>0&&kind!=="preview")factors.push({key:"gaps",label:"有 "+ctx.openGaps+" 个未关闭卡点",factor:1.15});
 return factors;
}
export function rhythmMinutes(kind:RhythmKind,ctx:RhythmContext):RhythmResult{
 const base=rhythmBase[kind],factors=rhythmFactors(kind,ctx);
 const [min,max]=rhythmBounds[kind];
 const scaled=factors.reduce((n,f)=>n*f.factor,base);
 let capped=false,minutes=Math.min(max,Math.max(min,round5(scaled)));
 // 当天可用时间不够时，先压到还能做得完的长度；压到下限以下就如实说「今天放不下」。
 if(ctx.freeMinutes!==undefined&&ctx.freeMinutes<minutes){
  capped=true;
  minutes=round5(Math.min(minutes,Math.max(0,ctx.freeMinutes)));
 }
 const parts=[rhythmKindNames[kind]+"基准 "+base+" 分钟",...factors.map(f=>f.label+" ×"+f.factor)];
 if(capped)parts.push("今天只剩 "+Math.max(0,Math.round(ctx.freeMinutes??0))+" 分钟可用");
 parts.push("→ "+minutes+" 分钟");
 return {minutes,base,factors,capped,reason:parts.join(" · ")};
}
export function rhythmBlock(kind:RhythmKind,course:Course,ctx:RhythmContext):RhythmBlock{
 return {...rhythmMinutes(kind,ctx),kind,courseId:course.id,label:course.name+" · "+rhythmKindNames[kind],minimum:rhythmMinimums[kind]};
}
/** 从整份记录里取出这门课做这类节奏需要的上下文。 */
export function rhythmContextFor(s:State,c:Course,d:string,mode:Mode,freeMinutes?:number):RhythmContext{
 return {mode,mastery:c.mastery,daysToExam:c.examDate?daysUntil(c.examDate,d):null,openGaps:s.gaps.filter(g=>g.courseId===c.id&&g.status!=="resolved").length,freeMinutes};
}
export function rhythmBlocksForCourse(s:State,c:Course,d:string,mode:Mode,freeMinutes?:number):RhythmBlock[]{
 const ctx=rhythmContextFor(s,c,d,mode,freeMinutes);
 return (["preview","review","deep"] as RhythmKind[]).map(kind=>rhythmBlock(kind,c,ctx));
}
