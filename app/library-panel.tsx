"use client";
import { useEffect,useState } from "react";
import { BookOpen,FileText,Plus,ExternalLink,Check } from "lucide-react";
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from "@/components/ui/dialog";
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from "@/components/ui/select";
import { Tabs,TabsList,TabsTrigger,TabsContent } from "@/components/ui/tabs";
import { RadioGroup,RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { newId,today,type State } from "@/lib/balance";
import { importSchema,questionInputSchema,materialKinds,maxFileBytes,type Material } from "@/lib/library";
import { blockLabel,canLoadMorePreview,describeTask,parseGate,previewFrom,shouldRunStep,taskViewLimits,type TaskSummary } from "@/lib/material-task-view";
import type { ExplainSeed } from "./coach-panel";
type Props={data:State;demo:boolean;saving:boolean;edit:(fn:(s:State)=>void,message?:string)=>Promise<boolean>;onExplain:(seed:ExplainSeed)=>void;onGoCourses:()=>void;onStartOwn:()=>Promise<void>};
/** 资料列表接口在 Material 之外多给了 hasFile 和最近一条解析任务摘要。 */
type MaterialRow=Material&{hasFile?:boolean;parse?:TaskSummary|null};
type PreviewBlock={ordinal:number;locator:string;locatorKind:string;locatorValue:number;heading:string;text:string;charCount:number};
type PreviewState={materialId:string;taskId:string;name:string;blocks:PreviewBlock[];pages:number;total:number;hasMore:boolean;loading:boolean;error:string};
function Pick({value,onChange,items,label}:{value:string;onChange:(v:string)=>void;items:[string,string][];label:string}){return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue placeholder={label}/></SelectTrigger><SelectContent>{items.map(([id,n])=><SelectItem value={id} key={id}>{n}</SelectItem>)}</SelectContent></Select>}
export default function LibraryPanel({data,demo,saving,edit,onExplain,onGoCourses,onStartOwn}:Props){
 const [materials,setMaterials]=useState<MaterialRow[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false),[fetching,setFetching]=useState(false),[course,setCourse]=useState("all"),[filter,setFilter]=useState("all");
 const [taskBusy,setTaskBusy]=useState(""),[preview,setPreview]=useState<PreviewState|null>(null);
 const [modal,setModal]=useState<"material"|"question"|"import"|null>(null),[selectedCourse,setSelectedCourse]=useState(""),[kind,setKind]=useState("ppt"),[selected,setSelected]=useState(""),[practice,setPractice]=useState<string|null>(null),[checked,setChecked]=useState(false);
 const courses=data.courses.map(c=>[c.id,c.name] as [string,string]);
 const cname=(id:string)=>data.courses.find(c=>c.id===id)?.name??"课程";
 async function reload(){if(demo)return;setFetching(true);setError("");try{const r=await fetch("/api/v1/materials",{signal:AbortSignal.timeout(15000),cache:"no-store"}),j=await r.json() as {error?:string;materials:MaterialRow[]};if(!r.ok)throw Error(j.error);setMaterials(j.materials)}catch{setError("资料库暂时无法读取，请检查网络后重试。")}finally{setFetching(false)}}
 useEffect(()=>{void reload()},[demo]);
 /** 统一的接口调用：只认 JSON，失败时抛出服务端给的中文说明。 */
 async function api(path:string,init?:RequestInit,timeout=20000){const r=await fetch(path,{...init,cache:"no-store",signal:AbortSignal.timeout(timeout)}),j=await r.json() as {error?:string;message?:string;task?:TaskSummary;done?:boolean;blocks?:PreviewBlock[];total?:number;hasMore?:boolean};if(!r.ok)throw Error(j.message||j.error||"请求失败，请重试。");return j}
 function applyTask(materialId:string,task:TaskSummary){setMaterials(list=>list.map(m=>m.id===materialId?{...m,parse:task}:m))}
 /**
  * 开始 / 继续 / 重试解析。一次点击最多发 taskViewLimits.maxRunStepsPerClick 个 run 请求：
  * 服务端每次 run 只写入一部分块，这里跑到预算上限就停下，剩下交给用户再点一次——不做后台轮询，避免无限请求。
  */
 async function startParse(m:MaterialRow){
  if(taskBusy)return;
  setTaskBusy(m.id);setError("");
  try{
   const base="/api/v1/materials/"+encodeURIComponent(m.id)+"/tasks";
   let task=m.parse??null;
   if(task?.parseStatus==="failed"&&task.id)task=(await api(base+"/"+encodeURIComponent(task.id)+"/retry",{method:"POST"})).task??task;
   else if(!task)task=(await api(base,{method:"POST"})).task??null;
   if(!task?.id)throw Error("解析任务没能建立，请刷新页面后重试。");
   const taskId=task.id;
   applyTask(m.id,task);
   let steps=0,done=task.parseStatus==="ready";
   while(shouldRunStep(task,steps)){
    const body=await api(base+"/"+encodeURIComponent(taskId)+"/run",{method:"POST"},180000);
    if(body.task)task=body.task;
    steps++;applyTask(m.id,task);
    if(body.done){done=true;break}
   }
   const view=describeTask(task);
   if(task.parseStatus==="failed")toast.error(view.detail);
   else if(task.parseStatus==="needs_ocr")toast.info(view.detail);
   else if(done&&task.parseStatus==="ready")toast.success(view.detail);
   else toast.info(`已处理 ${task.writtenBlocks??0} 块，还没到末尾，可以再点一次继续。`);
  }catch(e){setError(e instanceof Error?e.message:"解析请求失败，请检查网络后重试。")}
  finally{setTaskBusy("")}
 }
 async function loadPreview(materialId:string,taskId:string,pages:number,replace:boolean){
  try{
   const j=await api(`/api/v1/materials/${encodeURIComponent(materialId)}/tasks/${encodeURIComponent(taskId)}/blocks?from=${previewFrom(pages)}&limit=${taskViewLimits.previewPageSize}`);
   const rows=j.blocks??[];
   setPreview(p=>p&&p.taskId===taskId?{...p,blocks:replace?rows:[...p.blocks,...rows],pages:pages+1,total:j.total??p.total,hasMore:!!j.hasMore,loading:false,error:""}:p);
  }catch(e){setPreview(p=>p&&p.taskId===taskId?{...p,loading:false,error:e instanceof Error?e.message:"解析内容暂时读不出来，请稍后重试。"}:p)}
 }
 async function openPreview(m:MaterialRow,task:TaskSummary){
  if(!task.id)return;
  setPreview({materialId:m.id,taskId:task.id,name:m.name,blocks:[],pages:0,total:task.storedBlocks??0,hasMore:true,loading:true,error:""});
  await loadPreview(m.id,task.id,0,true);
 }
 function open(m:typeof modal){setSelectedCourse(course==="all"?courses[0]?.[0]??"":course);setKind("ppt");setModal(m);setError("")}
 async function submit(e:React.FormEvent<HTMLFormElement>){
 e.preventDefault();if(busy||saving)return;const form=new FormData(e.currentTarget);form.set("courseId",selectedCourse);setError("");setBusy(true);
 try{
 if(modal==="material"){
 if(demo)throw Error("请先点击“开始我的一周”，再保存个人资料。");form.set("kind",kind);const file=form.get("file");if(file instanceof File&&file.size>maxFileBytes)throw Error("单个文件最大 20 MB，大文件可以先保存 HTTPS 链接。");
 const r=await fetch("/api/v1/materials",{method:"POST",body:form,signal:AbortSignal.timeout(90000)}),j=await r.json() as {error?:string};if(!r.ok)throw Error(j.error);toast.success("资料已归档");setModal(null);await reload();
 }else{
 let inputs;
 if(modal==="import"){const file=form.get("jsonFile");if(file instanceof File&&file.size>500000)throw Error("导入文件请控制在 500 KB 以内。");const raw=file instanceof File&&file.size?await file.text():String(form.get("json")??"");inputs=importSchema.parse(JSON.parse(raw))}
 else inputs=[questionInputSchema.parse({prompt:form.get("prompt"),options:String(form.get("options")).split("\n").map(v=>v.trim()).filter(Boolean),correctIndex:Number(form.get("correct"))-1,explanation:form.get("explanation"),source:form.get("source")})];
 if(await edit(s=>{s.questions.push(...inputs.map(q=>({...q,id:newId(),courseId:selectedCourse,knowledgePointId:"",materialId:""})))},`已添加 ${inputs.length} 道题`))setModal(null);
 }
 }catch(e){setError(e instanceof SyntaxError?"JSON 格式不正确，请参考下方示例。":e instanceof Error&&e.name==="ZodError"?"题目格式有误：需要题干、2–6 个选项和有效的正确答案。":e instanceof Error&&e.name==="TimeoutError"?"请求超时，请先刷新资料列表确认是否已保存，再重试。":e instanceof Error?e.message:"保存失败，请重试")}finally{setBusy(false)}
 }
 const questions=data.questions.filter(q=>(course==="all"||q.courseId===course)&&(filter!=="wrong"||data.attempts.filter(a=>a.questionId===q.id).at(-1)?.correct===false));
 const current=data.questions.find(q=>q.id===practice);
 async function answer(){if(!current||selected===""||saving)return;const choice=Number(selected),correct=choice===current.correctIndex;
 if(await edit(s=>{s.attempts.push({id:newId(),questionId:current.id,date:today(),selected:choice,correct});if(!correct&&!s.gaps.some(g=>g.sessionId==="quiz:"+current.id&&g.status!=="resolved"))s.gaps.push({id:newId(),courseId:current.courseId,sessionId:"quiz:"+current.id,question:"错题："+current.prompt,risk:"normal",status:"open",answer:"来源："+current.source+"\n解析："+current.explanation,created:today(),knowledgePointId:current.knowledgePointId})},correct?"回答正确":"已记录错题，加入课程问题池"))setChecked(true);
 }
 return <section className="library"><div className="section-title"><div><span className="eyebrow">把资料接回复习</span><h2>资料与题库</h2><p className="muted">按课程收好原文件，练习后留下真正需要解决的问题。</p></div><BookOpen size={28}/></div>
 <div className="library-filter"><Pick label="筛选课程" value={course} onChange={setCourse} items={[["all","全部课程"],...courses]}/><span>{materials.filter(m=>course==="all"||m.courseId===course).length} 份资料 · {data.questions.filter(q=>course==="all"||q.courseId===course).length} 道题</span></div>
 {error&&!modal&&<div role="alert" className="error-banner">{error}<button className="text-link" onClick={reload}>重试</button></div>}
 {!courses.length&&<div className="notice"><span>资料和题目需要先绑定到一门课程。</span><button className="btn small" onClick={onGoCourses}>去添加课程</button></div>}
 <Tabs defaultValue="materials"><TabsList className="class-tabs"><TabsTrigger value="materials">PPT / 课本</TabsTrigger><TabsTrigger value="questions">题库 / 错题</TabsTrigger></TabsList>
 <TabsContent value="materials"><div className="section-title section-gap"><h3>课程资料</h3><button className="btn small" disabled={saving} onClick={()=>demo?void onStartOwn():courses.length?open("material"):onGoCourses()}><Plus size={16}/>{demo?"开始我的一周":courses.length?"添加资料":"先添加课程"}</button></div>
 <p className="muted">PDF 可在浏览器阅读；PPT、Word、EPUB 保留原文件，交给对应应用打开。单个文件最大 20 MB，也可保存 HTTPS 链接。</p>
 <p className="muted">TXT、PPTX、DOCX 和普通文字型 PDF 可以解析成带位置标记的文本块；扫描版 PDF 会自动尝试系统内配置的 OCR，并保留页码来源。</p>
 <p className="muted">解析完成后，这份资料会出现在「学习教练」的重点提炼里，也可以在下面的卡片上直接打开「重点讲解」。</p>
 {demo&&<div className="notice">当前是示例体验。点击页面顶部“开始我的一周”后，即可上传自己的资料。</div>}
 {fetching?<p role="status">正在读取资料…</p>:materials.filter(m=>course==="all"||m.courseId===course).length===0?<div className="quiet-empty"><FileText/><h3>先收好一份常用资料</h3><p>老师的 PPT、课本章节和题库文件，都可以从这里回到对应课程。</p></div>:<div className="material-grid">{materials.filter(m=>course==="all"||m.courseId===course).map(m=>{const task=m.parse??null,view=describeTask(task),gate=parseGate({hasFile:m.hasFile,filename:m.filename}),working=taskBusy===m.id;return <article className="panel" key={m.id}><span className="pill">{materialKinds[m.kind as keyof typeof materialKinds]}</span><h3>{m.name}</h3><p>{cname(m.courseId)} · {m.location||"未标记章节"}</p><small>{m.url?"外部链接":m.filename+" · "+(m.size/1024/1024).toFixed(1)+" MB"}</small><div className={"task-status tone-"+view.tone}><span className="pill">{view.label}</span><span className="task-detail">{view.detail}</span></div>{view.busy&&view.percent>0&&<div className="task-progress" role="progressbar" aria-label="解析进度" aria-valuenow={view.percent} aria-valuemin={0} aria-valuemax={100}><i style={{width:view.percent+"%"}}/></div>}<div className="task-actions">{!gate.ok?<span className="task-note">{gate.reason}</span>:view.action!=="none"&&<button className="btn small" disabled={working||demo} onClick={()=>startParse(m)}>{working?"处理中…":view.actionLabel}</button>}{view.canPreview&&task&&<button className="btn soft small" disabled={working} onClick={()=>openPreview(m,task)}>查看解析内容</button>}{view.status==="ready"&&<button className="btn soft small" disabled={demo} onClick={()=>onExplain({topic:m.name,courseId:m.courseId,materialIds:[m.id],question:"这份资料里，本周最该掌握的重点是什么？"})}>提炼重点讲解</button>}<a className="btn soft small" href={"/api/v1/materials/"+encodeURIComponent(m.id)} target="_blank" rel="noopener noreferrer">{m.url?"打开链接":"打开原文件"}<ExternalLink size={15}/></a></div></article>})}</div>}
 </TabsContent>
 <TabsContent value="questions"><div className="section-title section-gap"><h3>小批量练习，及时回看</h3><div className="actions"><button className="btn ghost small" disabled={saving} onClick={()=>demo?void onStartOwn():courses.length?open("import"):onGoCourses()}>{demo?"开始后导入":courses.length?"导入题目":"先添加课程"}</button><button className="btn small" disabled={saving} onClick={()=>demo?void onStartOwn():courses.length?open("question"):onGoCourses()}><Plus size={16}/>{demo?"开始后录题":courses.length?"录一道题":"先添加课程"}</button></div></div>
 <div className="library-filter"><Pick value={filter} label="筛选题目" onChange={setFilter} items={[["all","全部题目"],["wrong","最近一次答错"]]}/><span>题库文件请回到“PPT / 课本”选择“题库资料”上传；这里支持手动录题或导入 JSON。</span></div>
 {demo&&<div className="notice">当前是示例体验，资料和题目不会保存。请先点击页面顶部“开始我的一周”，再添加自己的课程资料。</div>}
 {!questions.length?<div className="quiet-empty"><h3>{filter==="wrong"?"暂无待重练错题":"还没有可练习的题目"}</h3><p>手动录入，或导入最多 200 道 JSON 格式题目。解析内容以你的课程资料为准。</p></div>:questions.map(q=>{const last=data.attempts.filter(a=>a.questionId===q.id).at(-1);return <article className="simple-row" key={q.id}><div><span className="eyebrow">{cname(q.courseId)} · {last?(last.correct?"最近答对":"需要重练"):"尚未练习"}</span><h3>{q.prompt}</h3><p>{q.source||"未标记来源"}</p></div><button className="btn soft small" onClick={()=>{setPractice(q.id);setSelected("");setChecked(false)}}>练习</button></article>})}
 </TabsContent></Tabs>
 <Dialog open={!!modal} onOpenChange={v=>{if(!v&&!busy&&!saving)setModal(null)}}><DialogContent className="balance-dialog"><DialogHeader><DialogTitle>{modal==="material"?"添加课程资料":modal==="import"?"批量导入单选题":"录入一道单选题"}</DialogTitle><DialogDescription>{modal==="material"?"上传原文件或保存一个资料链接。":"标记来源，方便答错后回到课本或 PPT。"}</DialogDescription></DialogHeader>
 <form onSubmit={submit}><div className="form-fields"><div className="field"><label>所属课程</label><Pick label="所属课程" value={selectedCourse} onChange={setSelectedCourse} items={courses}/></div>
 {modal==="material"?<><div className="field"><label htmlFor="material-name">资料名称</label><input id="material-name" name="name" required maxLength={160}/></div><div className="field"><label>资料类型</label><Pick label="资料类型" value={kind} onChange={setKind} items={Object.entries(materialKinds)}/></div><div className="field"><label htmlFor="location">章节 / 页码</label><input id="location" name="location" maxLength={300} placeholder="例如：第 4 章，第 32–48 页"/></div><div className="field"><label htmlFor="file">选择文件（与链接二选一）</label><input id="file" type="file" name="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.txt,.epub"/></div><div className="field"><label htmlFor="url">或：HTTPS 资料链接</label><input id="url" type="url" name="url" placeholder="https://…" maxLength={2000}/></div></>:modal==="question"?<><div className="field"><label htmlFor="prompt">题干</label><textarea id="prompt" name="prompt" required maxLength={2000}/></div><div className="field"><label htmlFor="options">选项（每行一项，2–6 项）</label><textarea id="options" name="options" required rows={4}/></div><div className="field"><label htmlFor="correct">正确答案是第几个选项？</label><input id="correct" name="correct" type="number" min={1} max={6} defaultValue={1} required/></div><div className="field"><label htmlFor="explanation">解析</label><textarea id="explanation" name="explanation" maxLength={4000}/></div><div className="field"><label htmlFor="source">来源 / 页码</label><input id="source" name="source" maxLength={300}/></div></>:<><div className="field"><label htmlFor="jsonFile">选择 JSON 文件</label><input id="jsonFile" name="jsonFile" type="file" accept=".json,application/json"/></div><div className="field"><label htmlFor="json">或粘贴题目 JSON</label><textarea id="json" name="json" rows={7} maxLength={500000}/></div><details><summary>查看格式示例（correctIndex 从 0 开始）</summary><pre className="json-example">{JSON.stringify([{prompt:"示例：以下哪个是选项一？",options:["选项一","选项二"],correctIndex:0,explanation:"这里填写课程解析。",source:"课本第 1 页"}],null,2)}</pre></details></>}
 </div>{error&&<div className="error-banner" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="btn ghost" disabled={busy||saving} onClick={()=>setModal(null)}>取消</button><button className="btn" disabled={busy||saving||!selectedCourse}>{busy||saving?"保存中…":"保存"}</button></div></form></DialogContent></Dialog>
 <Dialog open={!!current} onOpenChange={v=>{if(!v&&!saving)setPractice(null)}}><DialogContent className="balance-dialog"><DialogHeader><DialogTitle>闭卷练习</DialogTitle><DialogDescription>{current?cname(current.courseId)+" · "+(current.source||"未标记来源"):""}</DialogDescription></DialogHeader>{current&&<><h3 className="preserve">{current.prompt}</h3><RadioGroup aria-label="选择答案" value={selected} onValueChange={setSelected} disabled={checked||saving}>{current.options.map((option,i)=><label className="quiz-option" key={i}><RadioGroupItem value={String(i)}/><span>{String.fromCharCode(65+i)}. {option}</span></label>)}</RadioGroup>{checked&&<div className="note-panel" role="status"><h3>{Number(selected)===current.correctIndex?<><Check size={18}/>回答正确</>:"已记入错题与课程问题池"}</h3><p>正确答案：{String.fromCharCode(65+current.correctIndex)}. {current.options[current.correctIndex]}</p><p className="preserve">{current.explanation||"暂无解析，请回到原资料核对。"}</p><small>重练答对后，仍需到课程问题池确认是否真正解决。</small></div>}<div className="dialog-actions"><button className="btn ghost" disabled={saving} onClick={()=>setPractice(null)}>关闭</button>{!checked&&<button className="btn" disabled={selected===""||saving} onClick={answer}>{saving?"记录中…":"提交并查看解析"}</button>}</div></>}</DialogContent></Dialog>
 <Dialog open={!!preview} onOpenChange={v=>{if(!v)setPreview(null)}}><DialogContent className="balance-dialog"><DialogHeader><DialogTitle>解析内容</DialogTitle><DialogDescription>{preview?`${preview.name} · 已读取 ${preview.blocks.length} / ${preview.total} 块`:"解析预览"}</DialogDescription></DialogHeader>
 {preview&&<>{preview.error&&<div className="error-banner" role="alert">{preview.error}</div>}
 {!preview.blocks.length?preview.loading?<p role="status">正在读取解析内容…</p>:<div className="quiet-empty"><h3>还没有可预览的内容</h3><p>任务完成后再打开这里，就能看到按页或段落切好的文本。</p></div>:<ol className="preview-list">{preview.blocks.map(block=><li className="preview-block" key={block.ordinal}><small className="locator">{blockLabel(block)}</small><p className="preserve">{block.text}</p></li>)}</ol>}
 <div className="dialog-actions"><small className="muted">{preview.error?"":!preview.hasMore?"已经到末尾。":canLoadMorePreview(preview.pages,preview.hasMore)?`单次最多读 ${taskViewLimits.maxPreviewPages} 页，每页 ${taskViewLimits.previewPageSize} 块。`:`已到单次预览上限（${taskViewLimits.maxPreviewPages} 页），关闭后重新打开可从头再看。`}</small>{canLoadMorePreview(preview.pages,preview.hasMore)&&<button className="btn soft" disabled={preview.loading} onClick={()=>loadPreview(preview.materialId,preview.taskId,preview.pages,false)}>{preview.loading?"读取中…":"加载更多"}</button>}<button className="btn ghost" onClick={()=>setPreview(null)}>关闭</button></div></>}</DialogContent></Dialog>
 </section>;
}
