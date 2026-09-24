// GET/POST /api/v1/schedule/plan —— 生成今天和本周的学习计划。
// 今天：最多 3 个最关键行动，每个都带原因、预计时长、优先级、降级提示和前置依赖。
// 本周：每门核心课的课前预习 / 课后复习 / 周末深度复习，时长按负荷、掌握度、距考试天数和当天余量动态调整。
// GET 用查询参数、POST 用 JSON，两者字段完全一致；都不写库（临时覆盖只活在这次响应里）。
import { z } from "zod";
import { today, weekdayOf } from "@/lib/balance";
import { planInputSchema, planModeValue, type PlanInput } from "@/lib/coach-api";
import { dayPlan, weekPlan, withPlanOverride, type PlanOverride } from "@/lib/study-plan";
import { coachUnavailable, guard, intParam, invalid, json, readJsonBody, readState, realDate } from "../../coach-routes";
export const dynamic="force-dynamic";
function overrideOf(input:PlanInput):PlanOverride{
 return {freeMinutes:input.availableMinutes,energy:input.energy,mode:input.mode&&input.mode!=="auto"?input.mode:undefined};
}
export async function GET(request:Request){
 const checked=await guard(request,{origin:false});
 if(!checked.ok)return checked.response;
 const query=new URL(request.url).searchParams,date=query.get("date")??today();
 if(!realDate(date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 const mode=query.get("mode");
 if(mode&&!planModeValue.safeParse(mode).success)return invalid("模式只能是 normal、busy、exam 或 auto。");
 const input:PlanInput={date,availableMinutes:intParam(query.get("availableMinutes"),{min:0,max:1440}),energy:(query.get("energy") as PlanInput["energy"])??undefined,mode:(mode as PlanInput["mode"])??undefined};
 return respond(checked.user.userId,date,input);
}
export async function POST(request:Request){
 const checked=await guard(request);
 if(!checked.ok)return checked.response;
 const body=await readJsonBody(request);
 if(!body.ok)return body.response;
 let input:PlanInput;
 try{input=planInputSchema.parse(JSON.parse(body.raw||"{}"))}catch(error){
  const message=error instanceof z.ZodError?"请求内容有误：日期要像 2026-09-23，availableMinutes 是还没使用的分钟数（0–1440）。":"请求内容不是合法的 JSON。";
  return invalid(message);
 }
 const date=input.date??today();
 if(!realDate(date))return invalid("日期格式有误，应该像 2026-09-23 这样。");
 return respond(checked.user.userId,date,input);
}
async function respond(userId:string,date:string,input:PlanInput){
 try{
  const loaded=await readState(userId);
  if(!loaded.ok)return loaded.response;
  // 覆盖只应用到这次生成上：同一天可以用不同的余量反复试算，不会动保存的记录。
  const work=withPlanOverride(loaded.state,date,overrideOf(input));
  return json({apiVersion:"v1",engine:"rules",date,weekday:weekdayOf(date),plan:dayPlan(work,date),weekPlan:weekPlan(work,date),revision:loaded.revision,persisted:false,overrides:overrideOf(input)});
 }catch(error){return coachUnavailable(error,"generate plan failed")}
}
