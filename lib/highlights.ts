// 重点提炼：把已解析的资料块、用户粘贴的文本、卡点和错题，整理成「本周重点 / 高频考点 / 未掌握点」。
// 全部是规则，不调用模型：挑中的每一条都必须能指回原句（source.locator + evidence），
// 用户看到的是「这句话出现在第几张幻灯片」，而不是一个说不清来源的结论。
export type HighlightKind="key"|"frequent"|"unmastered";
export const highlightKindNames:Record<HighlightKind,string>={key:"本周重点",frequent:"高频考点",unmastered:"未掌握点"};
export const highlightKindHints:Record<HighlightKind,string>={
 key:"这一周要建立的框架：先看这些，再看细节。",
 frequent:"医学考试反复考的形状：定义、鉴别、数值、首选处理。",
 unmastered:"你自己记录过的卡点和做错过的题，优先在复习里处理。",
};
export const highlightLimits={key:6,frequent:6,unmastered:6,maxTotal:15};
export type HighlightSource={kind:"block"|"text"|"gap"|"attempt";materialId:string;locator:string;locatorKind:string;locatorValue:number;heading:string};
export type Highlight={id:string;kind:HighlightKind;label:string;detail:string;evidence:string;courseId:string;score:number;signals:string[];source:HighlightSource};
export type HighlightBlock={materialId:string;courseId:string;locator:string;locatorKind:string;locatorValue:number;heading:string;text:string};
export type HighlightGap={id:string;courseId:string;question:string;risk:"high"|"normal";status:string};
export type HighlightAttempt={questionId:string;courseId:string;prompt:string;wrong:number};
export type HighlightInput={courseId?:string;text?:string;blocks?:HighlightBlock[];gaps?:HighlightGap[];attempts?:HighlightAttempt[]};
export type HighlightResult={highlights:Highlight[];counts:Record<HighlightKind,number>;notes:string[];scanned:{blocks:number;lines:number;gaps:number;attempts:number}};
type Signal={key:string;label:string;weight:number;test:(line:string,heading:boolean)=>boolean};
/** 信号表就是「为什么挑中它」的解释表，界面上直接显示 label，用户能自己判断这条值不值得看。 */
const signals:Signal[]=[
 {key:"heading",label:"资料里的小节标题",weight:30,test:(line,heading)=>heading},
 {key:"clinical",label:"涉及诊断、治疗或首选处理",weight:14,test:line=>/(临床表现|诊断|治疗|首选|禁忌|适应证|适应症|并发症|鉴别|预后)/.test(line)},
 {key:"define",label:"定义句（是什么）",weight:12,test:line=>/(是指|称为|叫做|定义为|即为|又称为)/.test(line)},
 {key:"mechanism",label:"机制句（为什么）",weight:12,test:line=>/(机制|通路|途径|受体|导致|引起|激活|抑制|调节|代谢)/.test(line)},
 {key:"compare",label:"对比或鉴别",weight:10,test:line=>/(区别|不同点|鉴别|比较|对比)/.test(line)},
 {key:"enumerate",label:"并列结构，容易出多选",weight:9,test:line=>/[①②③④⑤]|(^|[^0-9])(1[.、)]|（1）)|\d[.、]\s*\S/.test(line)&&line.split(/[、；;]/).length>=3},
 {key:"quantity",label:"带数值或单位",weight:8,test:line=>/\d+(\.\d+)?\s*(mg|g|kg|ml|L|%|mmHg|mmol|mol|次\/分|小时|分钟|天|周|岁|倍|度)/.test(line)},
 {key:"question",label:"你还没解决的问题",weight:20,test:line=>/[？?]$|不懂|不会|没搞懂|搞不清|记不住/.test(line)},
];
const minLine=6,maxLine=140,maxLabel=110;
function cjkCount(line:string){return (line.match(/[一-龥]/g)??[]).length}
function hash(value:string){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
function clean(line:string){return line.replace(/\s+/g," ").replace(/^[\s·•\-—*>▍■□(（\d.、)）]+/,"").replace(/[\s·•\-—*]+$/,"").trim()}
function usable(line:string){return line.length>=minLine&&line.length<=maxLine&&cjkCount(line)>=4}
/**
 * 长段落按句末标点切开：一个重点应该是一句话，不是一整段。
 * 问号刻意不当作分隔符——切掉之后「你还没解决的问题」这条信号就永远匹配不上，
 * 而带问号的原句本身正是用户最需要被提醒的那一条。
 */
function linesOf(text:string){
 return text.split(/[\n。；;!！]/).map(clean).filter(usable).map(line=>line.length>maxLine?line.slice(0,maxLine):line);
}
function scoreOf(line:string,heading:boolean){
 const hit=signals.filter(s=>s.test(line,heading));
 return {signals:hit.map(s=>s.label),score:hit.reduce((n,s)=>n+s.weight,0)+(heading?0:Math.min(6,Math.floor(line.length/25)))};
}
function make(kind:HighlightKind,label:string,detail:string,evidence:string,courseId:string,score:number,hit:string[],source:HighlightSource):Highlight{
 return {id:kind+":"+hash(kind+label),kind,label,detail,evidence,courseId,score,signals:hit,source};
}
/**
 * 三类重点的取材不同：
 * 本周重点看「结构」（标题、段首），高频考点看「考点形状」（定义 / 鉴别 / 数值 / 首选处理），
 * 未掌握点只看用户自己的证据（卡点、错题、粘贴文本里带疑问的句子）。
 */
export function extractHighlights(input:HighlightInput):HighlightResult{
 const courseId=input.courseId??"",notes:string[]=[],scanned={blocks:0,lines:0,gaps:0,attempts:0};
 const keyPool:Highlight[]=[],freqPool:Highlight[]=[],unmasteredPool:Highlight[]=[];
 const push=(pool:Highlight[],item:Highlight)=>{if(!pool.some(x=>x.label===item.label))pool.push(item)};
 for(const block of input.blocks??[]){
  scanned.blocks+=1;
  const from={kind:"block" as const,materialId:block.materialId,locator:block.locator,locatorKind:block.locatorKind,locatorValue:block.locatorValue,heading:block.heading};
  const blockCourse=block.courseId||input.courseId||"";
  if(block.heading.trim()&&usable(block.heading)){
   const {signals:hit,score}=scoreOf(block.heading,true);
   // 标题代表整节的组织方式，是框架而不是细节，所以只进「本周重点」并额外加权。
   push(keyPool,make("key",clean(block.heading),"资料里的小节标题 · "+block.locator,clean(block.heading),blockCourse,score+15,hit,from));
  }
  const lines=linesOf(block.text);
  scanned.lines+=lines.length;
  lines.forEach((line,index)=>{
   const {signals:hit,score}=scoreOf(line,false);
   if(!hit.length)return;
   const course=blockCourse||courseId;
   const detail="出自 "+block.locator+(block.heading?"《"+block.heading+"》":"")+" · "+hit.join(" / ");
   // 段首句更容易是这一节的结论，给它一点结构加成，但不要盖过考点信号。
   const head=index===0?6:0;
   push(freqPool,make("frequent",line,detail,line,course,score,hit,from));
   push(keyPool,make("key",line,detail,line,course,score+head+2,hit,from));
  });
 }
 if(input.text&&input.text.trim()){
  const from={kind:"text" as const,materialId:"",locator:"粘贴的文本",locatorKind:"text",locatorValue:0,heading:""};
  const lines=linesOf(input.text);
  scanned.lines+=lines.length;
  for(const line of lines){
   const {signals:hit,score}=scoreOf(line,false);
   if(!hit.length)continue;
   const detail="来自你粘贴的文本 · "+hit.join(" / ");
   push(freqPool,make("frequent",line,detail,line,courseId,score,hit,from));
   push(keyPool,make("key",line,detail,line,courseId,score+2,hit,from));
   if(hit.includes("你还没解决的问题"))push(unmasteredPool,make("unmastered",line,detail,line,courseId,score+10,hit,from));
  }
 }
 for(const gap of input.gaps??[]){
  if(gap.status==="resolved")continue;
  scanned.gaps+=1;
  const course=gap.courseId||courseId,label=clean(gap.question).slice(0,maxLabel);
  if(!label)continue;
  const from={kind:"gap" as const,materialId:"",locator:"卡点记录",locatorKind:"gap",locatorValue:0,heading:""};
  push(unmasteredPool,make("unmastered",label,(gap.risk==="high"?"高风险卡点":"卡点")+" · 还没关闭",gap.question.slice(0,200),course,gap.risk==="high"?60:40,[gap.risk==="high"?"高风险卡点":"卡点"],from));
 }
 const wrongById=new Map<string,HighlightAttempt>();
 for(const attempt of input.attempts??[]){
  if(attempt.wrong<=0)continue;
  const current=wrongById.get(attempt.questionId);
  if(!current||attempt.wrong>current.wrong)wrongById.set(attempt.questionId,attempt);
 }
 for(const attempt of wrongById.values()){
  scanned.attempts+=1;
  const from={kind:"attempt" as const,materialId:"",locator:"错题记录",locatorKind:"attempt",locatorValue:0,heading:""};
  const label=clean(attempt.prompt).slice(0,maxLabel);
  if(!label)continue;
  push(unmasteredPool,make("unmastered",label,"做错过 "+attempt.wrong+" 次 · 复习时用闭卷回忆重做",attempt.prompt.slice(0,200),attempt.courseId||courseId,30+attempt.wrong*8,["做错过 "+attempt.wrong+" 次"],from));
 }
 const rank=(pool:Highlight[])=>pool.sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label));
 const pick=(pool:Highlight[],kind:HighlightKind)=>rank(pool).slice(0,highlightLimits[kind]);
 const key=pick(keyPool,"key"),frequent=pick(freqPool,"frequent"),unmastered=pick(unmasteredPool,"unmastered");
 const all=[...key,...frequent,...unmastered].slice(0,highlightLimits.maxTotal);
 const counts={key:key.length,frequent:frequent.length,unmastered:unmastered.length};
 if(!scanned.blocks&&!input.text?.trim())notes.push("没有选中已解析的资料，也没有粘贴文本：可以先去资料页解析一份讲义，或把本周讲义要点直接贴进来。");
 if(!key.length&&!frequent.length)notes.push("资料里没有识别到定义、鉴别、数值或首选处理这类考点句式；可以自己粘贴几条重点，或换一份文字版讲义。");
 if(!unmastered.length)notes.push("还没有未掌握的记录。上完课在「今日」写下卡点，或做一遍题，这里会自动出现。");
 if(scanned.blocks&&!scanned.lines)notes.push("选中的资料没有可用正文（可能只解析出了标题，或内容被截断）。");
 return {highlights:all,counts,notes,scanned};
}
