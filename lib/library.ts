import { z } from "zod";
export const questionInputSchema=z.object({prompt:z.string().trim().min(1).max(2000),options:z.array(z.string().trim().min(1).max(500)).min(2).max(6),correctIndex:z.number().int().min(0).max(5),explanation:z.string().max(4000).default(""),source:z.string().max(300).default("")}).refine(q=>q.correctIndex<q.options.length,{message:"正确答案必须对应一个选项"});
export const questionSchema=questionInputSchema.and(z.object({id:z.string().min(1).max(80),courseId:z.string().min(1).max(80),knowledgePointId:z.string().max(80).default(""),materialId:z.string().max(80).default("")}));
export const attemptSchema=z.object({id:z.string().min(1).max(80),questionId:z.string().min(1).max(80),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),selected:z.number().int().min(0).max(5),correct:z.boolean()});
export const importSchema=z.array(questionInputSchema).min(1).max(200);
export type Material={id:string;courseId:string;name:string;kind:string;location:string;filename:string;size:number;url:string;createdAt:string};
export const materialKinds={ppt:"课堂 PPT",textbook:"课本 / 参考书",bank:"题库资料",other:"其他资料"};
export const fileTypes:Record<string,string>={pdf:"application/pdf",ppt:"application/vnd.ms-powerpoint",pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",doc:"application/msword",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",txt:"text/plain",epub:"application/epub+zip"};
export const maxFileBytes=20*1024*1024;
/**
 * 能被服务端解析的扩展名。服务端用它判断任务能否创建，前端也用它决定按钮是否可点。
 * 放在这里而不是 lib/extract/：前端只需要一份扩展名清单，不能因此把解析器打进浏览器包。
 */
export const parseableExtensions=["txt","pptx","docx","pdf"] as const;
export function canParseFile(filename?:string){return (parseableExtensions as readonly string[]).includes((filename??"").split(".").pop()?.toLowerCase()??"")}
