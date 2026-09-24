// 学习教练四个接口（schedule/availability、schedule/plan、knowledge/highlights、explain）的输入校验。
// 放在 lib/ 而不是各路由文件里有两个原因：
// 1) Next.js 的 route.ts 只允许导出 HTTP 方法与配置，schema 藏在里面就没法直接断言；
// 2) 越界输入该被挡在哪一条，是这个系统的对外契约，应该和计划、时长、重点的规则放在一起被测到。
// 依赖刻意保持很轻：只引入已有的 schema 与上下文的容量上限，不引入存储与网络。
import { z } from "zod";
import { availabilitySchema, timetableSchema } from "./balance.ts";
import { coachContextLimits } from "./coach-context.ts";
import { explainLimits } from "./explain.ts";
/** 日期一律 "YYYY-MM-DD"。形状校验只在这里，真实性校验交给 realDate。 */
export const dayValue=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 只接受真实存在的日期：2026-02-30 这类会被 Date 归一化，必须显式挡掉。 */
export function realDate(value:string){
 return Number.isFinite(Date.parse(value+"T12:00:00Z"))&&new Date(value+"T12:00:00Z").toISOString().slice(0,10)===value;
}
export const energyValues=["low","medium","high"] as const;
export const planModes=["auto","normal","busy","exam"] as const;
export const planModeValue=z.enum(planModes);
const minutesValue=z.number().int().min(0).max(1440);
const energyValue=z.enum(energyValues);
/**
 * POST /api/v1/schedule/plan 与同名 GET 的查询参数共用的字段。
 * availableMinutes 是「今天还没用掉的分钟数」，不是总时长；上限就是一天 1440 分钟。
 * strict：多写字段直接拒绝，避免前端把拼错的字段名当成生效。
 */
export const planInputSchema=z.object({
 date:dayValue.optional(),
 availableMinutes:minutesValue.optional(),
 energy:energyValue.optional(),
 mode:planModeValue.optional(),
}).strict();
export type PlanInput=z.infer<typeof planInputSchema>;
/** POST /api/v1/schedule/availability：整份课表替换、可支配窗口替换，或按天记录可用时间。 */
export const availabilityInputSchema=z.object({
 /** 乐观并发用的版本号，0 表示首次写入。 */
 revision:z.number().int().min(0),
 timetable:z.array(timetableSchema).max(60).optional(),
 availability:availabilitySchema.optional(),
 days:z.array(z.object({date:dayValue,free:minutesValue.optional(),energy:energyValue.optional()})).max(31).optional(),
}).strict();
export type AvailabilityInput=z.infer<typeof availabilityInputSchema>;
/** POST /api/v1/knowledge/highlights：勾选资料、粘贴文本，以及要不要带上卡点和错题。 */
export const highlightsInputSchema=z.object({
 courseId:z.string().max(80).optional(),
 date:dayValue.optional(),
 materialIds:z.array(z.string().max(80)).max(coachContextLimits.maxMaterials).optional(),
 text:z.string().max(20000).optional(),
 includeGaps:z.boolean().optional(),
 includeAttempts:z.boolean().optional(),
 maxBlocksPerMaterial:z.number().int().min(1).max(coachContextLimits.maxBlocksPerMaterial).optional(),
}).strict();
export type HighlightsInput=z.infer<typeof highlightsInputSchema>;
/** POST /api/v1/explain：topic 必填，其余都可以留空。 */
export const explainInputSchema=z.object({
 topic:z.string().min(1).max(explainLimits.maxTopic),
 question:z.string().max(explainLimits.maxQuestion).optional(),
 courseId:z.string().max(80).optional(),
 date:dayValue.optional(),
 materialIds:z.array(z.string().max(80)).max(coachContextLimits.maxMaterials).optional(),
 text:z.string().max(20000).optional(),
 points:z.array(z.object({label:z.string().min(1).max(200),detail:z.string().max(600).optional()})).max(explainLimits.maxPoints).optional(),
}).strict();
export type ExplainInput=z.infer<typeof explainInputSchema>;
/** GET 查询参数里逗号分隔的资料 id 列表，最多取 maxMaterials 个。 */
export function idList(value:string|null){
 return value?value.split(",").map(item=>item.trim()).filter(Boolean).slice(0,coachContextLimits.maxMaterials):undefined;
}
