// 重点讲解：按带教老师的顺序输出四段——先框架，再机制/因果，再举例，最后用问题检查理解。
// 有两层设计上的克制：
// 1) 本地模板只给「思考脚手架 + 用户资料里的原句」，绝不编造医学结论（剂量、首选处理、指南推荐）；
// 2) 模型可用时四段式仍然由这里保证，模型少给的段落会被本地模板补齐并如实说明。
import { type AiError, type AiProvider } from "./ai-provider.ts";
export type ExplainSectionKey="framework"|"mechanism"|"example"|"check";
export const explainSectionNames:Record<ExplainSectionKey,string>={framework:"先讲框架",mechanism:"机制与因果",example:"举例",check:"问题检查"};
export const explainSectionOrder:ExplainSectionKey[]=["framework","mechanism","example","check"];
export type ExplainPoint={label:string;detail?:string};
export type ExplainRequest={
 topic:string;question?:string;courseId?:string;courseName?:string;
 /** 从资料块或粘贴文本里带来的上下文，用于摘出真实原句。 */
 context?:string;
 points?:ExplainPoint[];
 style?:string;
};
export type ExplainSection={key:ExplainSectionKey;title:string;body:string;bullets:string[]};
export type ExplainResult={
 topic:string;question:string;engine:"template"|"http";provider:string;model:string;ok:boolean;error:AiError|null;
 sections:ExplainSection[];followUps:string[];notice:string|null;hint:string|null;ms:number;
};
export const explainLimits={maxTopic:200,maxQuestion:600,maxContext:6000,maxPoints:12};
export const explainStyle="teacher";
const stylePrompt="你是一位医学课程的带教老师，按四段式讲解：先讲框架，再讲机制与因果，再举例，最后用问题检查理解。";
const rules="只使用用户给出的资料内容；资料里没有的就说「你的资料里没有这部分」，不要编造剂量、数值或指南推荐。每一步都要能让用户指回原文。用中文，语言简短，不用寒暄。";
const templateNotice="当前使用本地模板：下面的框架、机制链条、举例步骤和检查问题都是按规则生成的脚手架，医学细节需要你从自己的资料里补全。配置服务端模型后，这里会换成模型生成的讲解，四段结构不变。";
/** 只在本地模板里出现的句子都要是「怎么做」，不是「医学结论」。 */
function contextLines(context?:string){
 return (context??"").split(/[\n。；;]/).map(line=>line.replace(/\s+/g," ").trim()).filter(line=>line.length>=6).slice(0,120);
}
const pick=(lines:string[],pattern:RegExp,limit:number)=>lines.filter(line=>pattern.test(line)).slice(0,limit);
function bulletsFor(key:ExplainSectionKey,request:ExplainRequest,lines:string[]):string[]{
 const topic=request.topic,question=(request.question??"").trim()||topic;
 const points=(request.points??[]).slice(0,explainLimits.maxPoints);
 if(key==="framework")return [
  "这一节要回答的问题："+question,
  "用一句话写下「"+topic+"」是什么——从资料里找原句，不要凭印象写。",
  "往上对齐：它属于哪一章的哪条主线；往下拆分：它由哪几步组成。",
  "框架压缩：把这一节压到 5 个词以内，写在纸上。",
  ...pick(lines,/是指|称为|定义为|包括|分为|概念/,2).map(line=>"资料原句："+line),
 ].slice(0,6);
 if(key==="mechanism")return [
  "因果链：起因 → 中间环节 → 结果。把资料里的因果句连成一条链，接不上的一环就是没懂的地方。",
  ...pick(lines,/机制|通路|途径|受体|导致|引起|激活|抑制|调节|代谢/,2).map(line=>"资料原句："+line),
  "反向自问：去掉链条里的哪一环，结果就不成立？",
  ...pick(lines,/区别|鉴别|不同|比较/,1).map(line=>"和相邻概念的差别："+line),
 ].slice(0,6);
 if(key==="example")return [
  "把机制放回一个具体病人：主诉 → 体征 → 检查 → 处理，标出每一步对应上面链条的哪一环。",
  ...pick(lines,/临床表现|诊断|首选|治疗|禁忌|并发症|预后/,2).map(line=>"资料原句："+line),
  "写一个反例：什么情况下这套机制不适用。",
  "把例子里的数值和单位单独抄一行——考试最常在这里设陷阱。",
 ].slice(0,6);
 return [
  "闭卷说出「"+topic+"」的框架，说不出来就回到第一段。",
  ...points.slice(0,3).map(point=>"「"+point.label+"」：是什么、为什么、举一个例子，三个都答上来才算掌握。"),
  "把「"+topic+"」讲给同学听；卡住的那一句，就是今天要写进长期记忆点的那一句。",
  "如果考题问「"+topic+"」和相邻概念的区别，你能说出两点吗？",
 ].slice(0,6);
}
export function localSections(request:ExplainRequest):ExplainSection[]{
 const lines=contextLines(request.context);
 return explainSectionOrder.map((key,index)=>({key,title:(index+1)+"、"+explainSectionNames[key],body:"",bullets:bulletsFor(key,request,lines)}));
}
export function renderSections(sections:ExplainSection[]){
 return sections.map(section=>section.title+"\n"+[section.body,...section.bullets.map(bullet=>"· "+bullet)].filter(Boolean).join("\n")).join("\n\n");
}
export function followUpsFor(request:ExplainRequest){
 const first=(request.points??[])[0]?.label;
 return [
  "换一个更基础的说法再讲一遍",
  "给 3 个闭卷回忆的问题",
  "这部分和上一节的关系是什么",
  ...(first?["把「"+first+"」按四段式展开"]:[]),
 ];
}
const sectionKeywords:Record<ExplainSectionKey,string>={
 framework:"框架|结构|总体|梳理",
 mechanism:"机制|因果|原理|为什么",
 example:"举例|例子|病例|案例|应用",
 check:"检查理解|问题检查|自测|提问|检验",
};
const matchers=explainSectionOrder.map(key=>({key,pattern:new RegExp("("+explainSectionNames[key]+"|"+sectionKeywords[key]+")")}));
/** 把模型返回的自由文本切回四段。切不出来就整段放弃，交给本地模板补齐。 */
export function parseSections(text:string):ExplainSection[]{
 const found=new Map<ExplainSectionKey,ExplainSection>();
 let current:ExplainSectionKey|null=null;
 for(const raw of text.split("\n")){
  const line=raw.trim();
  if(!line)continue;
  const cleaned=line.replace(/^[#*\s>]*/,"").replace(/[：:]\s*$/,"");
  const heading=cleaned.length<=24?matchers.find(m=>m.pattern.test(cleaned)):undefined;
  if(heading){current=heading.key;if(!found.has(current))found.set(current,{key:current,title:explainSectionNames[current],body:"",bullets:[]});continue}
  if(current===null){continue}
  const section=found.get(current)!;
  const bullet=line.match(/^[·•\-*\d.、)）]+/)?line.replace(/^[·•\-*\s]+/,"").replace(/^\d+[.、)）]\s*/,""):null;
  if(bullet&&bullet.length<=300&&section.bullets.length<8)section.bullets.push(bullet);
  else if(!section.body)section.body=line.slice(0,600);
  else if(section.body.length<600)section.body=(section.body+" "+line).slice(0,600);
 }
 return explainSectionOrder.filter(key=>found.has(key)).map(key=>found.get(key)!);
}
export const explainPrompt=(request:ExplainRequest)=>{
 const parts=["主题："+request.topic];
 if(request.courseName)parts.push("课程："+request.courseName);
 if(request.question?.trim())parts.push("我想问的问题："+request.question.trim());
 if(request.points?.length)parts.push("需要一带而过的重点：\n"+request.points.slice(0,explainLimits.maxPoints).map(point=>"- "+point.label).join("\n"));
 if(request.context?.trim())parts.push("我的资料原文（只允许引用这里的内容）：\n"+request.context.trim().slice(0,explainLimits.maxContext));
 parts.push("请按这四段的标题回答："+explainSectionOrder.map(key=>"「"+explainSectionNames[key]+"」").join("、")+"。每段用短句和要点，不要超过 6 条。");
 return parts.join("\n\n");
};
export async function explainTopic(provider:AiProvider,request:ExplainRequest):Promise<ExplainResult>{
 const topic=request.topic.trim().slice(0,explainLimits.maxTopic),question=(request.question??"").trim().slice(0,explainLimits.maxQuestion);
 const local=localSections({...request,topic,question}),followUps=followUpsFor({...request,topic,question});
 const status=provider.status();
 // 超时不在这里写死：由 provider 自己的配置决定（AI_TIMEOUT_MS），调用方不再各自定一套。
 const response=await provider.generate({task:"explain",system:stylePrompt+rules,messages:[{role:"user",content:explainPrompt({...request,topic,question})}],maxTokens:1400,fallback:renderSections(local)});
 const base={topic,question,provider:response.provider,model:response.model,followUps,ms:response.ms};
 if(response.ok===false)return {...base,engine:"template" as const,ok:false as const,error:response.error,sections:local,notice:response.message,hint:response.hint};
 if(response.engine!=="http")return {...base,engine:"template",ok:false,error:"not_configured",sections:local,notice:templateNotice,hint:status.hint};
 const parsed=parseSections(response.text);
 if(parsed.length<2)return {...base,engine:"template",ok:false,error:"bad_response",sections:local,notice:"模型返回的内容没有按四段式组织，已经改用本地模板。",hint:"可以重试一次，或检查模型是否适合长篇中文输出。"};
 const merged=explainSectionOrder.map((key,index)=>{
  const fromModel=parsed.find(section=>section.key===key);
  return fromModel?{...fromModel,title:(index+1)+"、"+explainSectionNames[key]}:{...local[index],body:"（这一段模型没有返回，下面是本地模板）"};
 });
 const missing=explainSectionOrder.length-parsed.length;
 return {...base,engine:"http",ok:true,error:null,sections:merged,notice:missing?"有 "+missing+" 段模型没有返回，已用本地模板补齐，其余为模型生成。":null,hint:null};
}
