"use client";
// 重点讲解窗口：复制或选择一条重点后打开，按老师风格给四段——框架、机制与因果、举例、问题检查。
// 没有配置模型时显示本地模板和配置提示，页面不会空白；配置好后同一个接口换成模型生成。
import { useCallback,useEffect,useState } from "react";
import { AlertCircle,ArrowUpRight,Check,GraduationCap,RotateCcw } from "lucide-react";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { explainLimits,type ExplainSection } from "@/lib/explain";
import type { ExplainSeed } from "./coach-panel";
type ExplainResponse={
 topic:string;question:string;engine:"template"|"http";provider:string;model:string;ok:boolean;error:string|null;
 sections:ExplainSection[];followUps:string[];notice:string|null;hint:string|null;ms:number;
 ai:{configured:boolean;kind:"template"|"http";provider:string;model:string;hint:string};
 sources:{materialId:string;locator:string;locatorKind:string;heading:string}[];
 materials:{name:string;blocks:number}[];
 skipped:{name:string;message:string}[];
 notes:string[];message?:string;
};
const fullText=(response:ExplainResponse)=>response.sections.map(section=>section.title+"\n"+[section.body,...section.bullets.map(bullet=>"· "+bullet)].filter(Boolean).join("\n")).join("\n\n");
export default function ExplainDialog({seed,onClose}:{seed:ExplainSeed|null;onClose:()=>void}){
 const [topic,setTopic]=useState(""),[question,setQuestion]=useState(""),[text,setText]=useState("");
 const [result,setResult]=useState<ExplainResponse|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 useEffect(()=>{
  if(!seed)return;
  setTopic(seed.topic);setQuestion(seed.question??"");setText(seed.text??"");setResult(null);setError("");
 },[seed]);
 const ask=useCallback(async(current:{topic:string;question:string;text:string})=>{
  setBusy(true);setError("");
  try{
   const response=await fetch("/api/v1/explain",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({topic:current.topic.trim(),question:current.question.trim()||undefined,text:current.text.trim()||undefined,materialIds:seed?.materialIds?.length?seed.materialIds:undefined,courseId:seed?.courseId,points:seed?.points}),signal:AbortSignal.timeout(40000)});
   const body=await response.json() as ExplainResponse;
   if(!response.ok){setResult(null);setError(body.message??"讲解暂时不可用，请稍后重试。");return}
   setResult(body);
  }catch{setResult(null);setError("讲解请求超时或失败，请检查网络后重试。")}finally{setBusy(false)}
 },[seed]);
 async function copy(value:string,label:string){
  try{await navigator.clipboard.writeText(value);toast.success(label+"已复制")}
  catch{toast.error("这个浏览器不允许自动复制，请手动选中复制。")}
 }
 return <Dialog open={!!seed} onOpenChange={value=>{if(!value&&!busy)onClose()}}>
  <DialogContent className="balance-dialog explain-dialog">
   <DialogHeader><DialogTitle>重点讲解</DialogTitle><DialogDescription>先讲框架，再讲机制与因果，再举例，最后用问题检查理解。{seed?.points?.length?` 本次带上 ${seed.points.length} 条重点。`:""}</DialogDescription></DialogHeader>
   <div className="coach-fields">
    <label htmlFor="explain-topic">要讲的重点</label>
    <input id="explain-topic" value={topic} maxLength={explainLimits.maxTopic} onChange={event=>setTopic(event.target.value)}/>
    <label htmlFor="explain-question">你想问的问题（可留空）</label>
    <textarea id="explain-question" rows={2} maxLength={explainLimits.maxQuestion} value={question} onChange={event=>setQuestion(event.target.value)} placeholder="例如：为什么心率加快时每搏输出量不一定增加？"/>
    <label htmlFor="explain-text">补充资料原文（可留空）</label>
    <textarea id="explain-text" rows={3} maxLength={20000} value={text} onChange={event=>setText(event.target.value)} placeholder="粘贴课件或课本里的原句，讲解只会引用这里的内容。"/>
   </div>
   <div className="dialog-actions left">
    <button className="btn ghost" type="button" disabled={busy} onClick={()=>void copy([topic,question,text].filter(Boolean).join("\n"),"重点内容")}>复制我填的内容</button>
    <button className="btn" type="button" disabled={busy||!topic.trim()} onClick={()=>void ask({topic,question,text})}>{busy?"讲解中…":result?"再讲一遍":"按老师风格讲一遍"} <ArrowUpRight size={16}/></button>
   </div>
   {error&&<div className="error-banner" role="alert">{error}</div>}
   {busy&&!result&&<div className="quiet-empty">正在按四段式组织讲解，最长可能要等二十多秒。</div>}
   {result&&<>
    <div className={result.engine==="http"?"notice":"notice template"}><span>{result.engine==="http"?<><strong>模型生成</strong> · {result.provider} / {result.model} · {(result.ms/1000).toFixed(1)} 秒</>:<><strong>本地模板</strong> · 规则生成，不是模型输出</>}</span>{result.notice&&<small>{result.notice}</small>}</div>
    {result.hint&&<p className="task-note">{result.hint}</p>}
    {result.sections.map(section=><section className="explain-section" key={section.key}>
     <div className="section-title"><h3>{section.title}</h3><button className="text-link" onClick={()=>void copy(section.title+"\n"+[section.body,...section.bullets.map(bullet=>"· "+bullet)].join("\n"),"这一段")}>复制这一段</button></div>
     {section.body&&<p className="preserve">{section.body}</p>}
     <ul>{section.bullets.map((bullet,index)=><li key={index}>{bullet}</li>)}</ul>
    </section>)}
    <div className="explain-followups">{result.followUps.map(followUp=><button className="btn ghost small" key={followUp} onClick={()=>{setQuestion(followUp);void ask({topic,question:followUp,text})}}>{followUp}</button>)}</div>
    {result.materials.length>0&&<p className="task-note">用了 {result.materials.length} 份资料：{result.materials.map(material=>material.name+"（"+material.blocks+" 段）").join("、")}</p>}
    {result.skipped.map((item,index)=><div className="warning" key={item.name+index}><AlertCircle size={17}/><span>{item.name||"选中的资料"}：{item.message}</span></div>)}
    {result.notes.map((note,index)=><p className="task-note" key={index}>{note}</p>)}
    {result.sources.length>0&&<details className="history"><summary>这条讲解引用了 {result.sources.length} 处原文位置</summary>{result.sources.map((source,index)=><div className="between record" key={index}><span>{source.locator}{source.heading?" · "+source.heading:""}</span><span className="pill">{source.locatorKind}</span></div>)}</details>}
    <div className="actions"><button className="btn soft small" onClick={()=>void copy(fullText(result),"整段讲解")}><Check size={15}/>复制全部四段</button><button className="btn ghost small" disabled={busy} onClick={()=>void ask({topic,question,text})}><RotateCcw size={15}/>换个说法再讲一遍</button><span className="muted"><GraduationCap size={14}/> 讲完记得闭卷复述一次</span></div>
   </>}
  </DialogContent>
 </Dialog>;
}
