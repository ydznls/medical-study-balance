import { z } from "zod";
import { questionSchema,attemptSchema } from "./library.ts";

const id = z.string().min(1).max(80);
const txt = z.string().max(4000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minutes = z.number().int().min(0).max(1440);
export const courseSchema = z.object({id,name:z.string().min(1).max(80),core:z.boolean(),topics:txt,mastery:z.number().int().min(-1).max(3),examDate:z.union([date,z.literal("")]),weight:z.number().min(1).max(5),weeklyMinutes:z.number().int().min(15).max(1200)});
const timeOfDay=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** 课表：一周里固定要上的课。weekday 1 = 周一，7 = 周日。 */
export const timetableSchema=z.object({id,courseId:id,weekday:z.number().int().min(1).max(7),start:timeOfDay,end:timeOfDay,location:z.string().max(60).default("")});
/** 可用时间口径：一天从几点到几点可支配，其中要扣掉多少分钟固定开销（通勤、吃饭等）。 */
export const availabilitySchema=z.object({dayStart:timeOfDay,dayEnd:timeOfDay,bufferMinutes:z.number().int().min(0).max(240)});
export const defaultAvailability={dayStart:"07:30",dayEnd:"23:00",bufferMinutes:60};
export const sessionSchema=z.object({id,courseId:id,date,topic:z.string().min(1).max(300),mode:z.enum(["A","B","C"]),modeEvents:z.array(z.object({mode:z.enum(["A","B","C"]),at:z.string().max(40)})).max(100),status:z.enum(["open","brief","closed"]),summary:txt,canExplain:txt,stuck:txt});
export const gapSchema=z.object({id,courseId:id,sessionId:z.string().max(80),question:z.string().min(1).max(2000),risk:z.enum(["high","normal"]),status:z.enum(["open","resolved","exam"]),answer:txt,created:date,knowledgePointId:z.string().max(80).default("")});
export const knowledgePointSchema=z.object({id,courseId:id,label:z.string().min(1).max(200),detail:txt,materialId:z.string().max(80).default(""),locator:z.string().max(300).default(""),status:z.enum(["accepted","resolved"]).default("accepted"),createdAt:date});
export const assignmentSchema=z.object({id,courseId:z.string().max(80),title:z.string().min(1).max(160),grade:z.enum(["A","B","C"]),due:date,estimate:z.number().int().min(1).max(1440),cap:z.number().int().min(1).max(1440),minimum:txt,spent:minutes,status:z.enum(["open","done"]),blockedBy:z.array(id).max(20).default([])});
export const reviewSchema=z.object({id,courseId:id,week:date,date,minutes:z.number().int().min(1).max(1440),framework:txt,problems:txt,recall:txt,memory:txt});
export const daySchema=z.object({free:minutes,energy:z.enum(["low","medium","high"]),sleep:z.number().min(0).max(24),sleepRecorded:z.boolean().optional(),spent:minutes,skips:z.array(z.object({id,reason:z.string().max(100)})).max(200),completed:z.array(id).max(300),doneForDay:z.boolean()});
export const trackSchema=z.object({id,name:z.string().min(1).max(80),role:z.enum(["main","maintain","paused"]),next:txt,weeklyTarget:z.number().int().min(1).max(10),minutes:z.number().int().min(5).max(180),hardDeadline:z.union([date,z.literal("")])});
export const stateSchema=z.object({
 schemaVersion:z.literal(1),
 questions:z.array(questionSchema).max(1000).default([]),attempts:z.array(attemptSchema).max(5000).default([]),knowledgePoints:z.array(knowledgePointSchema).max(3000).default([]),
 settings:z.object({sleepFloor:z.number().min(4).max(12),weeklyCapacity:z.number().int().min(60).max(6000),examWindow:z.number().int().min(1).max(60),exerciseTarget:z.number().int().min(0).max(7),socialTarget:z.number().int().min(0).max(7),restMinutes:z.number().int().min(5).max(120)}),
 courses:z.array(courseSchema).max(50),sessions:z.array(sessionSchema).max(2000),gaps:z.array(gapSchema).max(2000),assignments:z.array(assignmentSchema).max(1000),reviews:z.array(reviewSchema).max(1000),
 days:z.record(daySchema),weeks:z.record(z.object({mode:z.enum(["auto","normal","busy","exam"]),risk:txt,reflection:txt,adjustment:txt,reviewed:z.boolean()})),
 tracks:z.array(trackSchema).max(30),life:z.array(z.object({id,date,type:z.enum(["rest","exercise","social","development"]),trackId:z.string().max(80),minutes})).max(3000),
 // 第三版新增：课表与可用时间口径。老记录里没有这两个字段，靠 default 补齐，仍然合法。
 timetable:z.array(timetableSchema).max(60).default([]),availability:availabilitySchema.default({...defaultAvailability})
}).superRefine((s,ctx)=>{
 const courses=new Set(s.courses.map(c=>c.id));
 for(const list of [s.courses,s.sessions,s.gaps,s.assignments,s.reviews,s.tracks,s.life,s.questions,s.attempts,s.knowledgePoints,s.timetable])if(new Set(list.map(x=>x.id)).size!==list.length)ctx.addIssue({code:"custom",message:"记录 ID 重复"});
 if(s.timetable.some(x=>!courses.has(x.courseId)))ctx.addIssue({code:"custom",message:"课表里的课程不存在"});
 if(s.timetable.some(x=>minutesOfTime(x.end)<=minutesOfTime(x.start)))ctx.addIssue({code:"custom",message:"下课时间必须晚于上课时间"});
 if(minutesOfTime(s.availability.dayEnd)<=minutesOfTime(s.availability.dayStart))ctx.addIssue({code:"custom",message:"可支配时间的结束必须晚于开始"});
 if(s.assignments.some(a=>a.blockedBy.includes(a.id)||a.blockedBy.some(b=>!s.assignments.some(x=>x.id===b))))ctx.addIssue({code:"custom",message:"作业的前置依赖有误"});
 if(s.tracks.filter(x=>x.role==="main").length>1||s.tracks.filter(x=>x.role==="maintain").length>1)ctx.addIssue({code:"custom",message:"最多一个主方向和一个维护方向"});
 if(s.questions.some(q=>!courses.has(q.courseId))||s.attempts.some(a=>!s.questions.some(q=>q.id===a.questionId&&a.selected<q.options.length&&a.correct===(a.selected===q.correctIndex))))ctx.addIssue({code:"custom",message:"题目或答题记录关联有误"});
 const points=new Set(s.knowledgePoints.map(k=>k.id));
 if(s.knowledgePoints.some(k=>!courses.has(k.courseId)))ctx.addIssue({code:"custom",message:"知识点的课程不存在"});
 if(s.questions.some(q=>q.knowledgePointId&&!points.has(q.knowledgePointId)))ctx.addIssue({code:"custom",message:"题目的知识点关联有误"});
 if([...s.sessions,...s.gaps,...s.reviews].some(x=>!courses.has(x.courseId))||s.assignments.some(x=>x.courseId&&!courses.has(x.courseId)))ctx.addIssue({code:"custom",message:"找不到对应课程"});
});
export type State=z.infer<typeof stateSchema>;
export type Course=z.infer<typeof courseSchema>;
export type Assignment=z.infer<typeof assignmentSchema>;
export type Session=z.infer<typeof sessionSchema>;
export type Action={id:string;kind:"assignment"|"closure"|"review"|"rest"|"development";sourceId:string;title:string;minutes:number;minimum:string;reason:string;score:number;hard:boolean};
export type Mode="normal"|"busy"|"exam";
export const modeNames={normal:"正常周",busy:"忙周",exam:"考试周"};
export const masteryNames=["未接触","有印象","能解释","能应用"];
export const newId=()=>crypto.randomUUID();
export function today(now=new Date()){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(now)}
export function addDays(d:string,n:number){const x=new Date(d+"T12:00:00+08:00");x.setUTCDate(x.getUTCDate()+n);return today(x)}
export function weekOf(d:string){const day=new Date(d+"T12:00:00+08:00").getUTCDay();return addDays(d,-((day+6)%7))}
export function daysUntil(d:string,t:string){return Math.round((Date.parse(d+"T12:00:00+08:00")-Date.parse(t+"T12:00:00+08:00"))/86400000)}
export function blankState():State{return {schemaVersion:1,questions:[],attempts:[],knowledgePoints:[],settings:{sleepFloor:7.5,weeklyCapacity:900,examWindow:28,exerciseTarget:3,socialTarget:1,restMinutes:20},courses:[],sessions:[],gaps:[],assignments:[],reviews:[],days:{},weeks:{},tracks:[],life:[],timetable:[],availability:{...defaultAvailability}}}
/** "HH:MM" → 从零点起的分钟数。用于课表和可用时间的加减。 */
export function minutesOfTime(v:string){const [h,m]=v.split(":").map(Number);return h*60+m}
export function formatMinutes(v:number){const n=Math.max(0,Math.round(v));return String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0")}
/** 1 = 周一 … 7 = 周日。和 timetableSchema.weekday 同一套编号。 */
export function weekdayOf(d:string){const day=new Date(d+"T12:00:00+08:00").getUTCDay();return day===0?7:day}
export function weekdayName(n:number){return "一二三四五六日"[(n+6)%7]}
export function classSlotsOn(s:State,d:string){return s.timetable.filter(x=>x.weekday===weekdayOf(d)).slice().sort((a,b)=>a.start.localeCompare(b.start))}
export function classMinutesOn(s:State,d:string){return classSlotsOn(s,d).reduce((n,x)=>n+Math.max(0,minutesOfTime(x.end)-minutesOfTime(x.start)),0)}
export function windowMinutes(s:State){return Math.max(0,minutesOfTime(s.availability.dayEnd)-minutesOfTime(s.availability.dayStart))}
/** 这天理论上还剩多少分钟：可支配窗口 − 上课 − 固定开销。只是建议值，用户记录过的天数以记录为准。 */
export function suggestedFree(s:State,d:string){return Math.max(0,windowMinutes(s)-classMinutesOn(s,d)-s.availability.bufferMinutes)}
export type DayAvailability={date:string;weekday:number;classes:{id:string;courseId:string;name:string;start:string;end:string;minutes:number;location:string}[];classMinutes:number;windowMinutes:number;suggestedFree:number;recorded:number|null;effective:number};
export function availabilityOf(s:State,d:string):DayAvailability{
 const classes=classSlotsOn(s,d).map(x=>({id:x.id,courseId:x.courseId,name:s.courses.find(c=>c.id===x.courseId)?.name??"课程",start:x.start,end:x.end,minutes:Math.max(0,minutesOfTime(x.end)-minutesOfTime(x.start)),location:x.location}));
 const suggested=suggestedFree(s,d),recorded=s.days[d]?s.days[d].free:null;
 return {date:d,weekday:weekdayOf(d),classes,classMinutes:classes.reduce((n,x)=>n+x.minutes,0),windowMinutes:windowMinutes(s),suggestedFree:suggested,recorded,effective:Math.min(1440,recorded??suggested)};
}
export function dayState(s:State,d:string){return s.days[d]??{free:90,energy:"medium" as const,sleep:7.5,sleepRecorded:false,spent:0,skips:[],completed:[],doneForDay:false}}
export function weekState(s:State,d:string){return s.weeks[weekOf(d)]??{mode:"auto" as const,risk:"",reflection:"",adjustment:"",reviewed:false}}
export function reviewDone(s:State,c:string,d:string){return s.reviews.filter(r=>r.courseId===c&&r.week===weekOf(d)).reduce((n,r)=>n+r.minutes,0)}
export function courseTarget(s:State,c:Course,d:string,mode?:Mode){const m=mode??getMode(s,d).mode;return m==="busy"?Math.max(30,Math.round(c.weeklyMinutes/2)):c.weeklyMinutes}
export function getMode(s:State,d:string):{mode:Mode;reason:string;load:number}{
 const load=s.courses.filter(c=>c.core).reduce((n,c)=>n+Math.max(0,c.weeklyMinutes-reviewDone(s,c.id,d)),0)+s.assignments.filter(a=>a.status==="open"&&daysUntil(a.due,d)<=6).reduce((n,a)=>n+Math.max(0,a.estimate-a.spent),0);
 const near=s.courses.filter(c=>c.examDate&&daysUntil(c.examDate,d)>=0&&daysUntil(c.examDate,d)<=s.settings.examWindow).sort((a,b)=>a.examDate.localeCompare(b.examDate))[0];
 const manual=weekState(s,d).mode;
 if(manual!=="auto")return {mode:manual,reason:"你手动选择了本周模式",load};
 if(near)return {mode:"exam",reason:near.name+"距考试 "+daysUntil(near.examDate,d)+" 天，进入考前窗口",load};
 if(load>s.settings.weeklyCapacity)return {mode:"busy",reason:"本周待投入 "+load+" 分钟，超过设定容量",load};
 return {mode:"normal",reason:"本周学习负荷在设定容量内",load};
}
export function recommend(s:State,d:string):{actions:Action[];warnings:string[];mode:Mode;reason:string;free:number;low:boolean}{
 const day=dayState(s,d),{mode,reason}=getMode(s,d),low=day.energy==="low"||(day.sleepRecorded===true&&day.sleep<s.settings.sleepFloor),free=Math.max(0,day.free-day.spent),warnings:string[]=[];
 const skip=new Set(day.skips.map(x=>x.id));
 const candidates:Action[]=[];
 for(const a of s.assignments.filter(x=>x.status==="open")){
 const left=daysUntil(a.due,d),hard=left<=1,remaining=Math.max(5,a.estimate-a.spent),chunk=Math.min(remaining,a.cap,low?20:mode==="busy"?30:60);
 if(hard&&remaining>free)warnings.push(a.title+"临近截止，预计剩余 "+remaining+" 分钟，超过今天余量。请缩小提交范围或主动协调。");
 candidates.push({id:"assignment:"+a.id,kind:"assignment",sourceId:a.id,title:a.title,minutes:chunk,minimum:a.minimum||"按最低合格要求推进；确认提交后再标记完成",reason:(left<0?"已逾期":left===0?"今天截止":left===1?"明天截止":left+" 天后截止")+" · "+a.grade+" 类作业",score:(hard?1000:200-left*5)+(a.grade==="A"?30:0),hard});
 }
 for(const c of s.courses){
 const opened=s.sessions.filter(x=>x.courseId===c.id&&x.status!=="closed").sort((a,b)=>b.date.localeCompare(a.date))[0];
 if(opened&&c.core)candidates.push({id:"closure:"+opened.id,kind:"closure",sourceId:opened.id,title:c.name+" · 课后关闭",minutes:low||mode==="busy"?2:12,minimum:low||mode==="busy"?"写下主题和一个卡点，先保留学习线索":"今天讲了什么 / 我会什么 / 我卡在哪里",reason:(opened.date===d?"今天的核心课":"有未关闭的核心课")+" · "+opened.topic,score:650+(opened.date===d?30:0),hard:false});
 const remain=courseTarget(s,c,d,mode)-reviewDone(s,c.id,d),gap=s.gaps.filter(g=>g.courseId===c.id&&g.status!=="resolved"),days=c.examDate?daysUntil(c.examDate,d):999;
 if(remain>0&&(c.core||(days>=0&&days<=s.settings.examWindow)))candidates.push({id:"review:"+c.id,kind:"review",sourceId:c.id,title:c.name+(mode==="exam"?" · 考前复习":" · 本周复习"),minutes:Math.min(remain,low?15:mode==="busy"?30:45),minimum:mode==="normal"?"压缩框架，闭卷讲清一条主线，处理最高风险问题":"保留闭卷回忆和最高风险问题，缩减笔记整理",reason:"本周还差 "+remain+" 分钟"+(gap.length?" · "+gap.length+" 个待处理问题":"")+(days>=0&&days<=s.settings.examWindow?" · 距考试 "+days+" 天":""),score:400+c.weight*15+(3-Math.max(0,c.mastery))*10+Math.min(gap.length,10)*4+(days>=0&&days<=s.settings.examWindow?250-days*3:0),hard:false});
 }
 for(const t of s.tracks.filter(x=>x.role!=="paused")){
 const count=s.life.filter(x=>x.type==="development"&&x.trackId===t.id&&weekOf(x.date)===weekOf(d)).length;
 if(count>=t.weeklyTarget)continue;
 const hard=!!t.hardDeadline&&daysUntil(t.hardDeadline,d)<=1;
 if((mode!=="normal"||low)&&!hard)continue;
 candidates.push({id:"development:"+t.id,kind:"development",sourceId:t.id,title:t.name+" · "+(t.role==="main"?"主方向":"维护"),minutes:Math.min(t.minutes,low?15:45),minimum:t.next||"推进一小步，并记录实际投入",reason:hard?"有必须处理的截止事项":"本周已推进 "+count+" / "+t.weeklyTarget+" 次",score:hard?1010:t.role==="main"?160:130,hard});
 }
 const restDone=s.life.some(x=>x.date===d&&x.type==="rest");
 if(low&&!restDone&&!day.doneForDay&&!skip.has("rest:"+d))candidates.push({id:"rest:"+d,kind:"rest",sourceId:d,title:"先恢复一下",minutes:Math.min(15,free),minimum:"离开屏幕、喝水或安静休息；到睡觉时间就收工",reason:day.sleep<s.settings.sleepFloor?"昨晚睡眠低于你设定的底线":"今天精力较低，先降低学习负荷",score:2000,hard:false});
 const allowed=candidates.filter(a=>!skip.has(a.id)&&!day.completed.includes(a.id)).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 let available=free;
 const actions:Action[]=[];
 if(!day.doneForDay)for(const a of allowed){
 if(actions.length>=3)break;
 const major=["review","assignment","development"].includes(a.kind);
 if(major&&!a.hard&&actions.some(x=>["review","assignment","development"].includes(x.kind)))continue;
 if(actions.some(x=>x.kind===a.kind&&x.sourceId===a.sourceId))continue;
 const duration=Math.min(a.minutes,available);
 if(duration<(a.kind==="closure"?2:a.kind==="rest"?1:5))continue;
 actions.push({...a,minutes:duration});available-=duration;
 }
 if(!day.doneForDay&&!restDone&&!low&&!skip.has("rest:"+d)&&actions.length<3&&available>=5)actions.push({id:"rest:"+d,kind:"rest",sourceId:d,title:"给自己一段休息",minutes:Math.min(s.settings.restMinutes,available),minimum:"散步、听音乐，或什么也不做",reason:"休息有自己的位置，不必等所有任务清空",score:0,hard:false});
 if(low)warnings.push("今天按低负荷推荐；睡眠与必要生活不用于填补学习缺口。");
 return {actions,warnings,mode,reason,free,low};
}
export function demoState(d:string):State{
 const s=blankState(),w=weekOf(d);
 s.days[d]={...dayState(s,d),sleepRecorded:true};
 s.courses=[{id:"physiology",name:"生理学",core:true,topics:"循环系统 · 心脏泵血与血压调节",mastery:1,examDate:addDays(d,42),weight:5,weeklyMinutes:120},{id:"biochemistry",name:"生物化学",core:true,topics:"糖代谢 · 糖酵解与三羧酸循环",mastery:2,examDate:addDays(d,46),weight:4,weeklyMinutes:120},{id:"anatomy",name:"系统解剖学",core:false,topics:"消化系统 · 腹部结构",mastery:1,examDate:addDays(d,55),weight:3,weeklyMinutes:60}];
 s.sessions=[{id:"sample-class",courseId:"biochemistry",date:d,topic:"糖酵解的关键步骤",mode:"B",modeEvents:[],status:"open",summary:"",canExplain:"",stuck:""}];
 s.gaps=[{id:"sample-gap",courseId:"physiology",sessionId:"",question:"如何用自己的话解释每搏输出量的影响因素？",risk:"high",status:"open",answer:"",created:d,knowledgePointId:""}];
 s.assignments=[{id:"sample-work",courseId:"biochemistry",title:"生化实验报告",grade:"B",due:addDays(d,3),estimate:45,cap:30,minimum:"补齐结果与讨论，检查必填项后提交",spent:0,status:"open",blockedBy:[]}];
 s.reviews=[{id:"sample-review",courseId:"physiology",week:w,date:d,minutes:45,framework:"循环系统主线",problems:"",recall:"",memory:""}];
 s.tracks=[{id:"english",name:"英语",role:"maintain",next:"复习 15 个旧词",weeklyTarget:3,minutes:15,hardDeadline:""},{id:"project",name:"个人项目",role:"main",next:"完成一个最小功能",weeklyTarget:2,minutes:30,hardDeadline:""}];
 s.timetable=[{id:"slot-monday",courseId:"biochemistry",weekday:weekdayOf(d),start:"08:00",end:"09:40",location:"教学楼 A302"},{id:"slot-wednesday",courseId:"physiology",weekday:weekdayOf(addDays(d,2)),start:"10:00",end:"11:40",location:"教学楼 B105"}];
 s.availability={...defaultAvailability};
 return s;
}
