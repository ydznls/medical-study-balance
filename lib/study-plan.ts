// 计划生成：今天给 1–3 个最关键行动，本周给每门核心课的学习节奏。
// 优先级 / 紧急度 / 重要度 / 恢复资源的判断沿用 lib/balance.ts 的 recommend（「今日」页面用的就是它），
// 这里只补它没做的三件事：前置关系、动态时长的节奏块、以及给界面看的「为什么这么排」。
import { addDays, availabilityOf, classSlotsOn, courseTarget, dayState, daysUntil, getMode, recommend, reviewDone, weekOf, weekState, weekdayOf, type Action, type DayAvailability, type Mode, type State } from "./balance.ts";
import { rhythmBlocksForCourse, type RhythmBlock, type RhythmKind } from "./study-rhythm.ts";
export type PlanAction=Action&{priority:number;degrade:string;waitingFor:string[]};
export type PlanOverride={freeMinutes?:number;energy?:"low"|"medium"|"high";mode?:Mode};
export type DayPlan={
 date:string;mode:Mode;modeReason:string;load:number;free:number;low:boolean;
 actions:PlanAction[];warnings:string[];rhythm:RhythmBlock[];availability:DayAvailability;totalMinutes:number;notes:string[];
};
/** 降级提示：告诉用户今天这一项为什么比平时短，而不是让他自己猜。 */
function degradedNote(mode:Mode,low:boolean){
 if(low)return "今天按低负荷安排：只做最小版本，不追求完整。";
 if(mode==="busy")return "忙周：时长按最小闭环压缩，做到最低合格标准即可。";
 if(mode==="exam")return "考试周：这一项优先，尽量不被打断。";
 return "";
}
/**
 * 前置关系：前置没做完的作业今天不排；如果因此一个行动都不剩，就把最紧的前置本身提上来。
 * 提上来的那一项同样受今天余量约束——余量放不下就如实说，不要给出做不完的计划。
 */
function applyBlockedBy(s:State,actions:Action[],free:number){
 const open=s.assignments.filter(a=>a.status==="open");
 const waitingOf=(a:Action)=>a.kind!=="assignment"?[]:open.filter(x=>x.id===a.sourceId).flatMap(x=>x.blockedBy).filter(id=>open.some(y=>y.id===id));
 const blocked=actions.filter(a=>waitingOf(a).length>0),kept=actions.filter(a=>waitingOf(a).length===0);
 const warnings=blocked.map(a=>"「"+a.title+"」要等「"+waitingOf(a).map(id=>open.find(x=>x.id===id)?.title??"前置任务").join("、")+"」先完成，今天先不排它。");
 if(kept.length||!blocked.length)return {actions:kept,warnings};
 const first=blocked[0],names=waitingOf(first);
 const promote=open.filter(x=>names.includes(x.id)).sort((a,b)=>a.due.localeCompare(b.due))[0];
 if(!promote)return {actions:[] as Action[],warnings};
 const minutes=Math.min(Math.min(Math.max(5,promote.estimate-promote.spent),promote.cap,45),Math.max(0,free));
 if(minutes<5){warnings.push("今天余量放不下前置作业，先把可用时间调整到至少 5 分钟，或把「"+promote.title+"」的截止时间往后挪。");return {actions:[] as Action[],warnings}}
 return {actions:[{id:"assignment:"+promote.id,kind:"assignment" as const,sourceId:promote.id,title:promote.title,minutes,minimum:promote.minimum||"按最低合格要求推进",reason:"这是「"+first.title+"」的前置，先把它做掉 · "+promote.due+" 截止",score:first.score,hard:true}],warnings};
}
/**
 * 把临时覆盖（剩余可用时间 / 精力 / 本周模式）写进一份状态副本。
 * recommend 读的是 state.days[d] 和 state.weeks[weekOf(d)]，所以必须落到副本上，不能改调用方的记录。
 */
export function withPlanOverride(s:State,d:string,override:PlanOverride={}):State{
 if(override.freeMinutes===undefined&&override.energy===undefined&&!override.mode)return s;
 const copy=structuredClone(s);
 if(override.freeMinutes!==undefined||override.energy!==undefined){
  const day={...dayState(copy,d)};
  if(override.freeMinutes!==undefined)day.free=Math.min(1440,day.spent+override.freeMinutes);
  if(override.energy)day.energy=override.energy;
  copy.days[d]=day;
 }
 if(override.mode)copy.weeks[weekOf(d)]={...weekState(copy,d),mode:override.mode};
 return copy;
}
export function dayPlan(s:State,d:string,override:PlanOverride={}):DayPlan{
 const work=withPlanOverride(s,d,override);
 const base=recommend(work,d),modeInfo=getMode(work,d),gated=applyBlockedBy(work,base.actions,base.free);
 const degrade=degradedNote(base.mode,base.low);
 const actions:PlanAction[]=gated.actions.map((a,i)=>({...a,priority:i+1,degrade,waitingFor:[]}));
 const availability=availabilityOf(work,d);
 const used=actions.reduce((n,a)=>n+a.minutes,0),remaining=Math.max(0,base.free-used);
 // 节奏块的可用时间取「关键行动之后剩下的余量」：排完 1–3 个行动还有多少，决定今天的复习能有多深。
 const rhythm=rhythmForDay(work,d,base.mode,remaining);
 const totalMinutes=used+rhythm.reduce((n,b)=>n+b.minutes,0);
 const notes:string[]=[];
 if(remaining<=0)notes.push("今天的余量已经给关键行动用完，今天不再排节奏块；可以在「学习教练」调整可用时间后重新规划。");
 const tight=work.courses.filter(c=>c.core&&c.examDate&&daysUntil(c.examDate,d)>=0&&daysUntil(c.examDate,d)<=work.settings.examWindow);
 if(tight.length)notes.push(tight.map(c=>c.name+"距考试 "+daysUntil(c.examDate,d)+" 天").join("；")+"，节奏块已按考前加大投入。");
 if(!work.timetable.length)notes.push("还没有填写课表，课前预习和课后复习都按已有记录推算；填上课表后会更准。");
 return {date:d,mode:base.mode,modeReason:modeInfo.reason,load:modeInfo.load,free:base.free,low:base.low,actions,warnings:[...base.warnings,...gated.warnings],rhythm,availability,totalMinutes,notes};
}
/**
 * 一天里的节奏块：有课的日子给课前预习 + 课后复习，周末给核心课的深度复习。
 * 只排当天真实存在的事，不为了凑数给每门课都来一遍——那只会变成看不见的负担。
 */
export function rhythmForDay(s:State,d:string,mode:Mode,freeMinutes?:number):RhythmBlock[]{
 const out:RhythmBlock[]=[];
 for(const slot of classSlotsOn(s,d)){
  const course=s.courses.find(c=>c.id===slot.courseId);if(!course)continue;
  const blocks=rhythmBlocksForCourse(s,course,d,mode,freeMinutes);
  out.push(blocks[0],blocks[1]);
 }
 if(weekdayOf(d)>=6)for(const course of s.courses.filter(c=>c.core))out.push(rhythmBlocksForCourse(s,course,d,mode,freeMinutes)[2]);
 // 余量已经用完时会出现 0 分钟的块：与其显示一条「0 分钟」的安排，不如先不排，让用户先去看余量提示。
 return out.filter(block=>block.minutes>0).slice(0,6);
}
export type WeekBlock=RhythmBlock&{date:string;weekday:number;placedBy:"class"|"weekend";classTime:{start:string;end:string;location:string}|null};
export type WeekCourse={courseId:string;name:string;minutes:number;blocks:number;reviewed:number;target:number;mastery:number;daysToExam:number|null;gaps:number};
export type WeekPlan={
 week:string;mode:Mode;modeReason:string;load:number;capacity:number;
 days:{date:string;weekday:number;classes:number;classMinutes:number;free:number;suggested:number;recorded:number|null;mode:Mode}[];
 blocks:WeekBlock[];courses:WeekCourse[];notes:string[];totalMinutes:number;
};
/** 本周节奏：课上过的排课后复习、还没上的排课前预习，周末排核心课的深度复习。 */
export function weekPlan(s:State,d:string):WeekPlan{
 const wk=weekOf(d),days=Array.from({length:7},(_,i)=>addDays(wk,i)),modeInfo=getMode(s,wk),blocks:WeekBlock[]=[];
 for(const date of days){
  const past=date<d;
  for(const slot of classSlotsOn(s,date)){
   const course=s.courses.find(c=>c.id===slot.courseId);if(!course)continue;
   const kind:RhythmKind=past?"review":"preview";
   const block=rhythmBlocksForCourse(s,course,date,modeInfo.mode).find(b=>b.kind===kind)!;
   blocks.push({...block,date,weekday:slot.weekday,placedBy:"class",classTime:{start:slot.start,end:slot.end,location:slot.location}});
  }
  if(weekdayOf(date)>=6)for(const course of s.courses.filter(c=>c.core)){
   const remain=Math.max(0,courseTarget(s,course,d)-reviewDone(s,course.id,d));
   if(!remain&&modeInfo.mode!=="exam")continue;
   const block=rhythmBlocksForCourse(s,course,date,modeInfo.mode).find(b=>b.kind==="deep")!;
   // 本周额度已经做满的课不必再排满两小时，把深度复习压到还差的那部分。
   blocks.push({...block,minutes:remain?Math.max(30,Math.min(block.minutes,remain)):block.minutes,date,weekday:weekdayOf(date),placedBy:"weekend",classTime:null});
  }
 }
 const order:Record<RhythmKind,number>={preview:0,review:1,deep:2};
 blocks.sort((a,b)=>a.date.localeCompare(b.date)||order[a.kind]-order[b.kind]||a.label.localeCompare(b.label));
 const courses:WeekCourse[]=s.courses.filter(c=>c.core||blocks.some(b=>b.courseId===c.id)).map(c=>({courseId:c.id,name:c.name,minutes:blocks.filter(b=>b.courseId===c.id).reduce((n,b)=>n+b.minutes,0),blocks:blocks.filter(b=>b.courseId===c.id).length,reviewed:reviewDone(s,c.id,d),target:courseTarget(s,c,d),mastery:c.mastery,daysToExam:c.examDate?daysUntil(c.examDate,d):null,gaps:s.gaps.filter(g=>g.courseId===c.id&&g.status!=="resolved").length}));
 const totalMinutes=blocks.reduce((n,b)=>n+b.minutes,0),notes:string[]=[];
 if(modeInfo.mode==="busy")notes.push("忙周：深度复习被压到最小闭环，先保住课前和课后，周末只做框架压缩与闭卷回忆。");
 if(modeInfo.mode==="exam")notes.push("考试周：节奏块向考试科目倾斜，深度复习按考试临近程度排序。");
 if(totalMinutes>s.settings.weeklyCapacity)notes.push("本周节奏合计 "+totalMinutes+" 分钟，超过设定的 "+s.settings.weeklyCapacity+" 分钟容量。请缩小深度复习范围，或把部分块移到下周。");
 const capped=blocks.filter(b=>b.capped).length;
 if(capped)notes.push("有 "+capped+" 个块因为当天余量不足被压缩；可以先在「今日」调整可用时间，再回来看重新规划的结果。");
 return {week:wk,mode:modeInfo.mode,modeReason:modeInfo.reason,load:modeInfo.load,capacity:s.settings.weeklyCapacity,days:days.map((date,i)=>{const a=availabilityOf(s,date);return {date,weekday:i+1,classes:a.classes.length,classMinutes:a.classMinutes,free:a.effective,suggested:a.suggestedFree,recorded:a.recorded,mode:getMode(s,date).mode}}),blocks,courses,notes,totalMinutes};
}
