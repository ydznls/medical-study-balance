"use client";
// 学习教练：今天该学什么（带理由、时长、优先级、降级提示）、本周节奏、重点提炼、重点讲解入口。
// 数据全部来自 /api/v1/schedule/plan 和 /api/v1/knowledge/highlights；
// 写操作（可用时间、课表、存知识卡）走父组件的 edit()，让 revision 只有一个写入方。
import { useCallback,useEffect,useMemo,useState } from "react";
import { AlertCircle,ArrowUpRight,Check,ChevronRight,Clock,GraduationCap,Plus,RotateCcw } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { addDays,dayState,newId,today,weekdayName,weekdayOf,weekOf,type Mode,type State } from "@/lib/balance";
import { highlightKindNames,type Highlight,type HighlightKind } from "@/lib/highlights";
import { rhythmKindNames } from "@/lib/study-rhythm";
import type { DayPlan,WeekPlan } from "@/lib/study-plan";
export type ExplainSeed={topic:string;question?:string;courseId?:string;materialIds?:string[];text?:string;points?:{label:string;detail?:string}[]};
type PlanResponse={plan:DayPlan;weekPlan:WeekPlan;weekday:number;error?:string;message?:string};
type MaterialOption={id:string;name:string;courseId:string;courseName:string;blocks:number;ready:boolean};
type HighlightsResponse={highlights:Highlight[];counts:Record<HighlightKind,number>;notes:string[];materials:{materialId:string;name:string;blocks:number}[];skipped:{materialId:string;name:string;message:string}[];error?:string;message?:string};
const modeNames:Record<Mode,string>={normal:"正常周",busy:"忙周",exam:"考试周"};
const kinds:(keyof typeof highlightKindNames)[]=["key","frequent","unmastered"];
const kindHints:Record<HighlightKind,string>={key:"这一周要建立的框架：先看这些，再看细节。",frequent:"反复考的形状：定义、鉴别、数值、首选处理。",unmastered:"你记录过的卡点和做错过的题，复习时优先处理。"};
export default function CoachPanel({data,demo,saving,edit,onExplain,onGoToday}:{data:State;demo:boolean;saving:boolean;edit:(fn:(s:State)=>void,message?:string)=>Promise<boolean>;onExplain:(seed:ExplainSeed)=>void;onGoToday:()=>void}){
 const date=today();
 const [plan,setPlan]=useState<PlanResponse|null>(null),[planNote,setPlanNote]=useState(""),[planBusy,setPlanBusy]=useState(false);
 const [minutes,setMinutes]=useState(""),[mode,setMode]=useState<"auto"|Mode>("auto");
 const [highlights,setHighlights]=useState<HighlightsResponse|null>(null),[hlNote,setHlNote]=useState(""),[hlBusy,setHlBusy]=useState(false);
 const [materials,setMaterials]=useState<MaterialOption[]>([]),[picked,setPicked]=useState<string[]>([]);
 const [text,setText]=useState(""),[topic,setTopic]=useState(""),[question,setQuestion]=useState("");
 const loadPlan=useCallback(async(override:{availableMinutes?:number;mode?:string}={})=>{
  setPlanBusy(true);setPlanNote("");
  const query=new URLSearchParams({date});
  if(override.availableMinutes!==undefined)query.set("availableMinutes",String(override.availableMinutes));
  if(override.mode&&override.mode!=="auto")query.set("mode",override.mode);
  try{
   const response=await fetch("/api/v1/schedule/plan?"+query.toString(),{cache:"no-store",signal:AbortSignal.timeout(15000)});
   const body=await response.json() as PlanResponse;
   if(!response.ok){setPlan(null);setPlanNote(body.message??"暂时无法生成计划，请稍后重试。");return}
   setPlan(body);setMinutes(String(body.plan.free));
  }catch{setPlan(null);setPlanNote("生成计划超时了，请检查网络后重试。")}finally{setPlanBusy(false)}
 },[date]);
 const loadMaterials=useCallback(async()=>{
  try{
   const response=await fetch("/api/v1/materials",{cache:"no-store",signal:AbortSignal.timeout(15000)});
   if(!response.ok)return;
   const body=await response.json() as {materials:{id:string;name:string;courseId:string;parse?:{parseStatus:string;storedBlocks:number}|null}[]};
   setMaterials(body.materials.map(material=>({id:material.id,name:material.name,courseId:material.courseId,courseName:data.courses.find(course=>course.id===material.courseId)?.name??"其他",blocks:material.parse?.storedBlocks??0,ready:material.parse?.parseStatus==="ready"})));
  }catch{}
 },[data.courses]);
 const loadHighlights=useCallback(async(materialIds:string[]=[],pasted="")=>{
  setHlBusy(true);setHlNote("");
  try{
   const response=await fetch("/api/v1/knowledge/highlights",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({date,materialIds,text:pasted}),signal:AbortSignal.timeout(20000)});
   const body=await response.json() as HighlightsResponse;
   if(!response.ok){setHighlights(null);setHlNote(body.message??"暂时无法提炼重点，请稍后重试。");return}
   setHighlights(body);
  }catch{setHighlights(null);setHlNote("提炼超时了，请检查网络后重试。")}finally{setHlBusy(false)}
 },[date]);
 useEffect(()=>{void loadPlan();void loadMaterials()},[loadPlan,loadMaterials]);
 useEffect(()=>{void loadHighlights()},[loadHighlights]);
 // 可用时间变化后重新规划：先写记录（今天的总可用时间），再让服务端按新余量重排。
 async function saveFreeMinutes(){
  const value=Math.max(0,Math.min(1440,Math.round(Number(minutes)||0)));
  if(await edit(next=>{const day={...dayState(next,date)};day.free=Math.min(1440,day.spent+value);next.days[date]=day},"今天的可用时间已更新"))await loadPlan({availableMinutes:value,mode});
 }
 async function saveWindow(patch:Partial<State["availability"]>){await edit(next=>{next.availability={...next.availability,...patch}},"可支配时间已更新")}
 async function saveSlot(slot:{id:string;courseId:string;weekday:number;start:string;end:string;location:string}){await edit(next=>{next.timetable=[...next.timetable,slot]},"已加入课表")}
 function dropSlot(id:string){return edit(next=>{next.timetable=next.timetable.filter(slot=>slot.id!==id)},"已移出课表")}
 function saveKnowledge(highlight:Highlight){
  const courseId=data.courses.some(course=>course.id===highlight.courseId)?highlight.courseId:data.courses[0]?.id;
  if(!courseId){return Promise.resolve(false)}
  return edit(next=>{next.knowledgePoints.push({id:newId(),courseId,label:highlight.label,detail:highlight.detail,materialId:highlight.source.materialId,locator:highlight.source.locator,status:"accepted",createdAt:date})},"已存为知识卡");
 }
 const ready=useMemo(()=>materials.filter(material=>material.ready),[materials]);
 const weekDays=useMemo(()=>Array.from({length:7},(_,index)=>addDays(weekOf(date),index)),[date]);
 const blocksByDay=useMemo(()=>{
  const map=new Map<string,WeekPlan["blocks"]>();
  for(const block of plan?.weekPlan.blocks??[]){const list=map.get(block.date)??[];list.push(block);map.set(block.date,list)}
  return map;
 },[plan]);
 return <div className="coach">
 {demo&&<div className="notice"><span><strong>这是示例记录</strong> · 建立我的一周后，这里的计划会按你录入的课表和考试日期生成。</span><button className="btn small" onClick={onGoToday}>去建立记录 <ArrowUpRight size={16}/></button></div>}
 <div className="dashboard-grid"><section>
  <div className="section-title"><h2>今天的关键行动</h2><span>{plan?`${plan.plan.actions.length} / 3 件 · ${modeNames[plan.plan.mode]}`:"读取中…"}</span></div>
  {planNote&&<div className="error-banner" role="alert">{planNote}</div>}
  {planBusy&&!plan&&<div className="quiet-empty">正在按课表、截止时间和掌握度排今天的计划…</div>}
  {plan&&<>
   <div className="plan-reason"><span className="pill">{modeNames[plan.plan.mode]}</span><p>{plan.plan.modeReason}</p><small>本周待投入 {plan.plan.load} 分钟 · 今天可用 {plan.plan.free} 分钟{plan.plan.availability.classes.length?` · 今天 ${plan.plan.availability.classes.length} 节课（${plan.plan.availability.classMinutes} 分钟）`:""}</small></div>
   {plan.plan.warnings.map((warning,index)=><div className="warning" key={index}><AlertCircle size={17}/><span>{warning}</span></div>)}
   {plan.plan.actions.length===0?<div className="quiet-empty">今天没有必须推进的行动。可以在「今日」留白，或到课程页安排一次复习。</div>:plan.plan.actions.map(action=><article className="plan-action" key={action.id}>
    <span className="plan-index">{String(action.priority).padStart(2,"0")}</span>
    <div className="plan-body">
     <h3>{action.title}</h3>
     <p>{action.minimum}</p>
     <div className="plan-meta"><span><Clock size={14}/> {action.minutes} 分钟</span><span>{action.reason}</span></div>
     {action.degrade&&<small className="text-warn">{action.degrade}</small>}
     {action.waitingFor.length>0&&<small className="text-warn">还等：{action.waitingFor.map(id=>data.assignments.find(item=>item.id===id)?.title??"前置任务").join("、")}</small>}
    </div>
    <button className="btn ghost small" onClick={onGoToday}>去今日执行</button>
   </article>)}
   {plan.plan.notes.map((note,index)=><p className="coach-note" key={index}>{note}</p>)}
   <div className="plan-adjust">
    <label htmlFor="coach-minutes">今天还能投入</label>
    <input id="coach-minutes" type="number" min={0} max={1440} step={5} value={minutes} onChange={event=>setMinutes(event.target.value)}/>
    <span className="muted">分钟</span>
    <button className="btn soft small" disabled={planBusy} onClick={()=>void loadPlan({availableMinutes:Math.max(0,Math.round(Number(minutes)||0)),mode})}><RotateCcw size={15}/>按这个余量重新规划</button>
    <button className="btn ghost small" disabled={saving||demo} onClick={()=>void saveFreeMinutes()}>保存为今天的可用时间</button>
   </div>
   <div className="plan-adjust">
    <label htmlFor="coach-mode">本周模式</label>
    <select id="coach-mode" value={mode} onChange={event=>setMode(event.target.value as "auto"|Mode)}>
     <option value="auto">自动判断</option><option value="normal">正常周</option><option value="busy">忙周</option><option value="exam">考试周</option>
    </select>
    <span className="muted">改完点上面重新规划，先看效果再决定要不要切换本周模式。</span>
   </div>
  </>}
  <div className="section-title section-gap"><h2>本周学习节奏</h2><span>课前预习 · 课后复习 · 周末深度复习</span></div>
  {!plan?<div className="quiet-empty">生成计划后，这里会按课表排出每门课的节奏。</div>:<>
   {plan.weekPlan.notes.map((note,index)=><p className="coach-note" key={index}>{note}</p>)}
   <div className="rhythm-list">{weekDays.map(day=>{
    const blocks=blocksByDay.get(day)??[],isToday=day===date,info=plan.weekPlan.days.find(item=>item.date===day);
    return <div className={"rhythm-day"+(isToday?" current":"")} key={day}>
     <div className="rhythm-day-head"><strong>{day.slice(5)} 周{weekdayName(weekdayOf(day))}</strong><span>{isToday?"今天":""}</span><small>{info?.classMinutes?`课 ${info.classMinutes} 分钟 · `:""}可用 {info?.free} 分钟{info?.recorded===null?"（按课表推算）":""}</small></div>
     {blocks.length===0?<p className="muted">这天没有安排节奏块。</p>:blocks.map(block=><div className="rhythm-row" key={block.date+block.kind+block.courseId}>
      <span className={"pill kind-"+block.kind}>{rhythmKindNames[block.kind]}</span>
      <div><strong>{block.label}</strong><small>{block.capped?"今天余量不足，已压缩到 ":""}{block.minutes} 分钟 · {block.minimum}</small><details><summary>为什么是这个时长</summary><p>{block.reason}</p></details></div>
     </div>)}
    </div>
   })}</div>
   <div className="section-title section-gap"><h2>每门课的目标</h2><span>本周复习额度</span></div>
   {plan.weekPlan.courses.map(course=><div className="budget-row" key={course.courseId}><div className="between"><strong>{course.name}</strong><span>{course.reviewed} / {course.target} 分钟</span></div><Progress value={Math.min(100,course.reviewed/Math.max(1,course.target)*100)} aria-label={course.name+"本周复习额度"}/><div className="between"><span>{course.blocks} 个节奏块 · 计划 {course.minutes} 分钟{course.gaps?` · ${course.gaps} 个未关闭卡点`:""}</span><span>{course.daysToExam===null?"考试待定":course.daysToExam>=0?"距考试 "+course.daysToExam+" 天":"考试已过"}</span></div></div>)}
  </>}
 </section><aside>
  <section className="panel"><div className="section-title"><h2>可用时间</h2><span className="pill">{data.availability.dayStart}–{data.availability.dayEnd}</span></div>
   <p>按下课、通勤和吃饭之外的可支配窗口算：窗口减去当天课程，再减去固定开销，得到建议可用时间。记录过的天数以你填的数字为准。</p>
   <div className="coach-fields">
    <label htmlFor="coach-start">窗口开始</label><input id="coach-start" type="time" value={data.availability.dayStart} disabled={demo||saving} onChange={event=>void saveWindow({dayStart:event.target.value})}/>
    <label htmlFor="coach-end">窗口结束</label><input id="coach-end" type="time" value={data.availability.dayEnd} disabled={demo||saving} onChange={event=>void saveWindow({dayEnd:event.target.value})}/>
    <label htmlFor="coach-buffer">固定开销（分钟）</label><input id="coach-buffer" type="number" min={0} max={240} step={5} value={data.availability.bufferMinutes} disabled={demo||saving} onChange={event=>void saveWindow({bufferMinutes:Math.max(0,Math.min(240,Math.round(Number(event.target.value)||0)))})}/>
   </div>
  </section>
  <section className="panel"><div className="section-title"><h2>课表</h2><button className="btn ghost small" disabled={demo||saving||!data.courses.length} onClick={()=>void saveSlot({id:newId(),courseId:data.courses[0].id,weekday:1,start:"08:00",end:"09:40",location:""})}><Plus size={15}/>加一节课</button></div>
   {data.timetable.length===0?<div className="quiet-empty">还没有课表。加一节课后，课前预习和课后复习会跟着上课时间走。</div>:<div className="slot-list">{data.timetable.slice().sort((a,b)=>a.weekday-b.weekday||a.start.localeCompare(b.start)).map(slot=><div className="slot-row" key={slot.id}>
    <span className="pill">周{weekdayName(slot.weekday)}</span>
    <div className="slot-body">
     <select aria-label="课程" value={slot.courseId} disabled={demo||saving} onChange={event=>void edit(next=>{next.timetable=next.timetable.map(item=>item.id===slot.id?{...item,courseId:event.target.value}:item)},"课表已更新")}>{data.courses.map(course=><option key={course.id} value={course.id}>{course.name}</option>)}</select>
     <div className="slot-times">
      <input aria-label="上课时间" type="time" value={slot.start} disabled={demo||saving} onChange={event=>void edit(next=>{next.timetable=next.timetable.map(item=>item.id===slot.id?{...item,start:event.target.value}:item)},"课表已更新")}/>
      <input aria-label="下课时间" type="time" value={slot.end} disabled={demo||saving} onChange={event=>void edit(next=>{next.timetable=next.timetable.map(item=>item.id===slot.id?{...item,end:event.target.value}:item)},"课表已更新")}/>
      <input aria-label="地点" placeholder="地点（可留空）" value={slot.location} maxLength={60} disabled={demo||saving} onChange={event=>void edit(next=>{next.timetable=next.timetable.map(item=>item.id===slot.id?{...item,location:event.target.value}:item)},"课表已更新")}/>
     </div>
    </div>
    <button className="text-link" disabled={demo||saving} onClick={()=>void dropSlot(slot.id)}>移出</button>
   </div>)}</div>}
   <p className="task-note">地点和具体教师不影响计划，只用来对上你的纸质课表。</p>
  </section>
  <section className="panel"><div className="section-title"><h2>重点讲解</h2><GraduationCap size={19}/></div>
   <p>输入一个重点或你的问题，按带教老师的顺序讲：先框架，再机制与因果，再举例，最后用问题检查理解。</p>
   <div className="coach-fields">
    <label htmlFor="coach-topic">要讲的重点</label>
    <input id="coach-topic" value={topic} maxLength={200} placeholder="例如：每搏输出量的影响因素" onChange={event=>setTopic(event.target.value)}/>
    <label htmlFor="coach-question">你想问的问题（可留空）</label>
    <textarea id="coach-question" rows={2} maxLength={600} value={question} onChange={event=>setQuestion(event.target.value)}/>
   </div>
   <button className="btn full" disabled={!topic.trim()} onClick={()=>onExplain({topic:topic.trim(),question:question.trim()||undefined,courseId:picked.length?ready.find(material=>material.id===picked[0])?.courseId:undefined,materialIds:picked,text:text.trim()||undefined})}>按老师风格讲一遍 <ArrowUpRight size={16}/></button>
   <p className="task-note">讲解会带上你勾选的资料原文；没有配置模型时返回本地模板（规则生成的框架和问题），不会编造医学结论。</p>
  </section>
 </aside></div>
 <div className="section-title section-gap"><h2>本周重点与高频考点</h2><span>全部来自你的资料和记录</span></div>
 {!demo&&ready.length===0?<div className="quiet-empty">还没有解析好的资料。到「资料与题库」上传 PPTX / DOCX / TXT 并解析，这里就能从正文里提炼重点。</div>:<div className="coach-materials">
  {ready.map(material=><button key={material.id} className={"material-chip"+(picked.includes(material.id)?" on":"")} onClick={()=>setPicked(current=>current.includes(material.id)?current.filter(id=>id!==material.id):[...current,material.id])}><Check size={14}/>{material.name}<small>{material.courseName} · {material.blocks} 段</small></button>)}
 </div>}
 <div className="coach-fields wide">
  <label htmlFor="coach-text">粘贴讲义要点或课堂笔记（可留空）</label>
  <textarea id="coach-text" rows={4} maxLength={20000} value={text} onChange={event=>setText(event.target.value)} placeholder="直接粘贴这一周的讲义要点、老师划的重点，或你自己写的问题。"/>
 </div>
 <div className="actions">
  <button className="btn" disabled={hlBusy} onClick={()=>void loadHighlights(picked,text)}>{hlBusy?"提炼中…":"提炼重点"} <ChevronRight size={16}/></button>
  {(picked.length>0||text.trim())&&<button className="btn ghost" disabled={hlBusy} onClick={()=>{setPicked([]);setText("");void loadHighlights([],"")}}>清空重来</button>}
 </div>
 {hlNote&&<div className="error-banner" role="alert">{hlNote}</div>}
 {highlights&&<>
  {highlights.skipped.map(item=><div className="warning" key={item.materialId}><AlertCircle size={17}/><span>{item.name||"选中的资料"}：{item.message}</span></div>)}
  <div className="highlight-grid">{kinds.map(kind=>{
   const list=highlights.highlights.filter(highlight=>highlight.kind===kind);
   return <section className={"panel highlight-group kind-"+kind} key={kind}>
    <div className="section-title"><h3>{highlightKindNames[kind]}</h3><span>{list.length}</span></div>
    <p className="task-note">{kindHints[kind]}</p>
    {list.length===0?<p className="muted">这次没有提炼到这一类重点。</p>:<ul className="highlight-list">{list.map(highlight=><li key={highlight.id}>
     <strong>{highlight.label}</strong>
     <small>{highlight.detail}</small>
     {highlight.evidence!==highlight.label&&<blockquote>{highlight.evidence}</blockquote>}
     <div className="highlight-actions">
      <button className="btn soft small" onClick={()=>onExplain({topic:highlight.label,question:undefined,courseId:highlight.courseId||undefined,materialIds:highlight.source.materialId?[highlight.source.materialId]:picked,text:highlight.evidence,points:[{label:highlight.label,detail:highlight.detail}]})}>讲解这个 <ArrowUpRight size={14}/></button>
      <button className="btn ghost small" disabled={saving||demo||!data.courses.length} onClick={()=>void saveKnowledge(highlight)}>存为知识卡</button>
     </div>
    </li>)}</ul>}
   </section>;
  })}</div>
  {highlights.notes.map((note,index)=><p className="coach-note" key={index}>{note}</p>)}
 </>}
 </div>;
}
