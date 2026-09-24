// AI 提供方接缝：把「真实外部模型调用」全部关在这一个文件里。
// 默认是本地模板 provider，不发任何网络请求；只有服务端环境变量配好时才构造 HTTP provider。
// 约束（不要绕过）：密钥只从服务端环境读取，永远不进前端包、不进仓库、不回显给客户端；
// 这个文件是仓库里唯一允许出现 fetch 外部模型地址的地方，且不引入任何 SDK 依赖。
// 这里只用运行时自带的 fetch/AbortSignal，注释里写明请求形状，方便以后换成官方 SDK。
export type AiRole="user"|"assistant";
export type AiMessage={role:AiRole;content:string};
export type AiTask="explain"|"highlights"|"plan"|"ocr"|"general";
export type AiDocument={mediaType:"application/pdf";data:string;filename?:string};
export type AiRequest={
 task:AiTask;system:string;messages:AiMessage[];maxTokens?:number;
 /** 服务端读取 PDF 时使用；不会把文件内容暴露给浏览器。 */
 documents?:AiDocument[];
 /** 本地模板结果。没有配置模型时由它兜底，保证页面不会空白。 */
 fallback?:string;
};
export type AiError="not_configured"|"template_missing"|"timeout"|"upstream_unavailable"|"upstream_rejected"|"bad_response"|"empty_response";
export type AiStatus={configured:boolean;kind:"template"|"http";provider:string;model:string;hint:string};
export type AiOk={ok:true;engine:"template"|"http";provider:string;model:string;text:string;ms:number};
export type AiFail={ok:false;error:AiError;message:string;hint:string;provider:string;model:string;ms:number};
export type AiResponse=AiOk|AiFail;
export interface AiProvider{
 readonly name:string;readonly model:string;readonly kind:"template"|"http";
 /** 只回答「配没配好」。不含密钥，也不回显服务地址。 */
 status():AiStatus;
 generate(request:AiRequest,options?:{timeoutMs?:number}):Promise<AiResponse>;
}
export type AiConfig={baseUrl:string;apiKey:string;model:string;enabled:boolean;timeoutMs:number};
export const defaultAiModel="claude-opus-5";
/** 一次模型调用的等待上限：默认 25 秒，允许用 AI_TIMEOUT_MS 在 5–120 秒之间调整。 */
export const aiTimeouts={default:25000,min:5000,max:120000};
export const aiModelHint="可以填任意兼容 Anthropic Messages API 的服务地址与模型名。";
const providerNames={template:"local-template",http:"http-messages-api"} as const;
const configHint="要接入真实模型，请在服务端配置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL（密钥只放在服务端环境变量里，不要写进仓库）。未配置时使用本地模板，回答是规则生成的脚手架，不是模型生成的内容。";
export const aiErrorInfo:Record<AiError,{message:string;hint:string}>={
 not_configured:{message:"当前没有配置外部模型，已使用本地模板。",hint:configHint},
 template_missing:{message:"没有可用的本地模板，也没有配置外部模型。",hint:"这是调用方的问题：请求里必须带 fallback 文本。"},
 timeout:{message:"外部模型响应超时，已使用本地模板。",hint:"可以稍后重试，或用 AI_TIMEOUT_MS（毫秒，5–120 秒）把等待上限调大。"},
 upstream_unavailable:{message:"外部模型暂时不可用，已使用本地模板。",hint:"稍后重试；如果持续失败，请检查服务地址与额度。"},
 upstream_rejected:{message:"外部模型拒绝了请求，已使用本地模板。",hint:"通常是密钥无效或权限不足，请在服务端检查 AI_API_KEY。"},
 bad_response:{message:"外部模型返回了无法解析的内容，已使用本地模板。",hint:"确认服务地址兼容 Anthropic Messages API（返回 content 数组）。"},
 empty_response:{message:"外部模型返回了空内容，已使用本地模板。",hint:"可以重试；若反复出现，请检查模型名是否正确。"},
};
const emptyConfig:AiConfig={baseUrl:"",apiKey:"",model:"",enabled:false,timeoutMs:aiTimeouts.default};
/** AI_TIMEOUT_MS：只接受 5–120 秒，写错或超范围就退回默认值，避免调出一个永不超时或必然超时的值。 */
function readTimeout(value:string){
 const parsed=Number.parseInt(value,10);
 if(!Number.isFinite(parsed))return aiTimeouts.default;
 return Math.max(aiTimeouts.min,Math.min(aiTimeouts.max,parsed));
}
/** 只接受 https 的公网地址：服务端拿它发请求，不能让请求方把地址指到内网或本机。 */
function safeBaseUrl(value:string){
 const raw=value.trim();if(!raw)return "";
 try{
  const url=new URL(raw);
  if(url.protocol!=="https:")return "";
  const host=url.hostname.toLowerCase();
  if(host==="localhost"||host==="[::1]"||host.endsWith(".local")||/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host))return "";
  if(/^172\.(1[6-9]|2\d|3[01])\./.test(host))return "";
  return raw.replace(/\/+$/,"");
 }catch{return ""}
}
/**
 * 从注入的环境对象里读配置。环境对象来自 cloudflare:workers，不是请求体，
 * 所以攻击者无法自己指定地址（避免 SSRF）。非 https 或指向本机/内网的地址一律当作没配。
 */
export function aiConfigFrom(source:unknown):AiConfig{
 if(!source||typeof source!=="object")return {...emptyConfig};
 const read=(key:string)=>{const value=(source as Record<string,unknown>)[key];return typeof value==="string"?value.trim():""};
 const baseUrl=safeBaseUrl(read("AI_BASE_URL")),apiKey=read("AI_API_KEY"),model=read("AI_MODEL")||defaultAiModel,enabled=read("AI_ENABLED")!=="false";
 return {baseUrl,apiKey,model,enabled:enabled&&!!baseUrl&&!!apiKey,timeoutMs:readTimeout(read("AI_TIMEOUT_MS"))};
}
export function aiStatus(config:AiConfig):AiStatus{
 if(!config.enabled)return {configured:false,kind:"template",provider:providerNames.template,model:"",hint:configHint};
 return {configured:true,kind:"http",provider:providerNames.http,model:config.model,hint:aiModelHint};
}
/** 本地模板 provider：不发请求，直接返回调用方给的 fallback。 */
export const deterministicProvider:AiProvider={
 name:providerNames.template,model:"",kind:"template",
 status:()=>aiStatus(emptyConfig),
 async generate(request){
  const started=Date.now();
  if(!request.fallback)return {ok:false,error:"template_missing",...aiErrorInfo.template_missing,provider:providerNames.template,model:"",ms:Date.now()-started};
  return {ok:true,engine:"template",provider:providerNames.template,model:"",text:request.fallback,ms:Date.now()-started};
 },
};
/**
 * HTTP provider：Anthropic Messages API 形状。
 * POST {baseUrl}/v1/messages，请求头 x-api-key + anthropic-version: 2023-06-01，
 * 请求体 {model,max_tokens,system,messages}，取响应 content[] 里的 text 段。
 * 换成官方 SDK 时只改这个函数体，调用方不用动。
 */
export function httpProvider(config:AiConfig):AiProvider{
 const provider=providerNames.http;
 return {
  name:provider,model:config.model,kind:"http",
  status:()=>aiStatus(config),
  async generate(request,options){
   const started=Date.now(),timeoutMs=Math.max(aiTimeouts.min,Math.min(aiTimeouts.max,options?.timeoutMs??config.timeoutMs));
   const fail=(error:AiError,extra?:string):AiFail=>({ok:false,error,...aiErrorInfo[error],hint:extra?aiErrorInfo[error].hint+"（"+extra+"）":aiErrorInfo[error].hint,provider,model:config.model,ms:Date.now()-started});
   if(!config.enabled)return fail("not_configured");
   const body={model:config.model,max_tokens:request.maxTokens??1200,system:request.system,messages:request.messages.map((message,index)=>({
    role:message.role,
    content:request.documents?.length&&index===request.messages.length-1&&message.role==="user"
      ?[...request.documents.map(document=>({type:"document",source:{type:"base64",media_type:document.mediaType,data:document.data}})),{type:"text",text:message.content}]
      :message.content,
   }))};
   try{
    const response=await fetch(config.baseUrl+"/v1/messages",{
     method:"POST",
     headers:{"content-type":"application/json","x-api-key":config.apiKey,"anthropic-version":"2023-06-01"},
     body:JSON.stringify(body),
     signal:AbortSignal.timeout(timeoutMs),
    });
    if(!response.ok){
     // 只记状态码，不记响应体：上游回显里可能带密钥或提示词。
     console.error("ai upstream rejected",response.status);
     return response.status===401||response.status===403?fail("upstream_rejected","HTTP "+response.status):fail("upstream_unavailable","HTTP "+response.status);
    }
    const data=await response.json() as {content?:{type?:string;text?:string}[]};
    if(!Array.isArray(data.content))return fail("bad_response");
    const text=data.content.filter(part=>part?.type==="text"&&typeof part.text==="string").map(part=>part.text as string).join("").trim();
    if(!text)return fail("empty_response");
    return {ok:true,engine:"http",provider,model:config.model,text,ms:Date.now()-started};
   }catch(error){
    const name=(error as {name?:string})?.name;
    if(name==="TimeoutError"||name==="AbortError")return fail("timeout");
    console.error("ai request failed",name??error);
    return fail("upstream_unavailable");
   }
  },
 };
}
/** 默认入口：配好了就走 HTTP，没配好就走本地模板。任何调用方都从这里拿 provider。 */
export function providerFromConfig(config:AiConfig):AiProvider{return config.enabled?httpProvider(config):deterministicProvider}
export function providerFromEnv(source:unknown):AiProvider{return providerFromConfig(aiConfigFrom(source))}
