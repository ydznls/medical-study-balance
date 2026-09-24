// GET  /api/v1/schedule/availability?date= —— 课表、可支配窗口，以及本周每天的可用时间。
// POST /api/v1/schedule/availability —— 保存课表 / 可支配窗口 / 某几天的可用时间与精力。
// 可用时间的口径只有一处：lib/balance.ts 的 availabilityOf（记录过的天数以记录为准，没记录按课表推算）。
import { addDays, availabilityOf, dayState, stateSchema, today, weekOf, weekdayName, type State } from "@/lib/balance";
import { availabilityInputSchema, type AvailabilityInput } from "@/lib/coach-api";
import { coachUnavailable, guard, invalid, invalidFrom, json, readJsonBody, readState, realDate, writeState } from "../../coach-routes";
export const dynamic="force-dynamic";
function weekView(state:State,date:string){
 const week=weekOf(date),days=Array.from({length:7},(_,index)=>addDays(week,index));
 return {
  date,week,
  availability:state.availability,
  timetable:state.timetable.map(slot=>({...slot,courseName:state.courses.find(course=>course.id===slot.courseId)?.name??"课程"})),
  days:days.map(day=>{
   const view=availabilityOf(state,day);
   return {date:day,weekday:view.weekday,weekdayName:weekdayName(view.weekday),classes:view.classes,classMinutes:view.classMinutes,windowMinutes:view.windowMinutes,suggestedFree:view.suggestedFree,recorded:view.recorded,effective:view.effective,mode:state.weeks[week]?.mode??"auto"};
  }),
 };
}
export async function GET(request:Request){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const raw=new URL(request.url).searchParams.get("date"),date=raw??today();
 if(!realDate(date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 try{
  const loaded=await readState(checked.user.userId);
  if(!loaded.ok)return loaded.response;
  return json({apiVersion:"v1",...weekView(loaded.state,date),revision:loaded.revision,persisted:false});
 }catch(error){return coachUnavailable(error,"read availability failed")}
}
export async function POST(request:Request){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const body=await readJsonBody(request);
 if(!body.ok)return body.response;
 let input:AvailabilityInput;
 try{input=availabilityInputSchema.parse(JSON.parse(body.raw||"{}"))}catch(error){return invalidFrom(error)}
 if(input.days?.some(day=>!realDate(day.date)))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 try{
  const loaded=await readState(checked.user.userId);
  if(!loaded.ok)return loaded.response;
  const next:State=structuredClone(loaded.state);
  if(input.availability)next.availability=input.availability;
  if(input.timetable)next.timetable=input.timetable;
  for(const day of input.days??[])next.days[day.date]={...dayState(next,day.date),...(day.free===undefined?{}:{free:day.free}),...(day.energy?{energy:day.energy}:{})};
  const parsed=stateSchema.safeParse(next);
  // 课表引用了不存在的课程、下课早于上课这类问题由 stateSchema 兜住，这里把它的中文说明原样返回。
  if(!parsed.success)return invalidFrom(parsed.error);
  const saved=await writeState(checked.user.userId,input.revision,parsed.data);
  if(!saved.ok)return json({error:"conflict",message:"另一窗口更新了记录。请先刷新，再重新保存可用时间。"},409);
  const date=input.days?.[0]?.date&&realDate(input.days[0].date)?input.days[0].date:today();
  return json({apiVersion:"v1",...weekView(parsed.data,date),revision:saved.revision,persisted:true});
 }catch(error){return coachUnavailable(error,"write availability failed")}
}
