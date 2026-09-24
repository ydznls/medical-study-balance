// 解析任务的存储访问层。SQL 全部收在这里，路由和 lib/material-task.ts 只依赖下面的接口。
// 这样服务逻辑可以脱离 D1 / R2 在测试里跑，也避免同一条 SQL 散落在多个路由里各写一遍。
// 只读写 0002 迁移新增的四张表，不触碰 balance_state / materials 之外的既有结构。
export type TaskStatus="pending"|"running"|"ready"|"needs_ocr"|"failed";
export type MaterialRecord={id:string;userId:string;courseId:string;name:string;filename:string;contentType:string;size:number;storageKey:string;url:string};
export type TaskRecord={
 id:string;userId:string;materialId:string;courseId:string;
 parseStatus:TaskStatus;parseEngine:string;parseError:string;parseAttempts:number;parseCursor:number;
 generateStatus:TaskStatus;generateEngine:string;generateError:string;generateAttempts:number;generateCursor:number;
 sourceSha256:string;byteSize:number;pageCount:number;blockCount:number;truncated:number;
 leaseUntil:string;createdAt:string;updatedAt:string;
};
export type BlockRecord={id:string;taskId:string;userId:string;materialId:string;courseId:string;ordinal:number;locator:string;locatorKind:string;locatorValue:number;heading:string;text:string;charCount:number};
/** 可被 updateTask 写入的列。故意用白名单而不是任意键，避免拼出可注入的列名。 */
export type TaskPatch=Partial<Pick<TaskRecord,"parseStatus"|"parseEngine"|"parseError"|"parseAttempts"|"parseCursor"|"generateStatus"|"generateEngine"|"generateError"|"generateAttempts"|"generateCursor"|"sourceSha256"|"byteSize"|"pageCount"|"blockCount"|"truncated"|"leaseUntil"|"updatedAt">>;
export interface TaskStore{
 findMaterial(userId:string,materialId:string):Promise<MaterialRecord|null>;
 getTask(userId:string,taskId:string):Promise<TaskRecord|null>;
 /** pending / running / ready / needs_ocr 都算可复用；failed 不算，失败要走 retry 或新建。 */
 findReusableTask(userId:string,materialId:string):Promise<TaskRecord|null>;
 createTask(row:TaskRecord):Promise<void>;
 updateTask(taskId:string,patch:TaskPatch):Promise<void>;
 /** 抢占执行权。pending/running/needs_ocr 且租约空闲或已过期时可执行。 */
 claimTask(taskId:string,now:string,leaseUntil:string):Promise<boolean>;
 deleteBlocks(taskId:string):Promise<void>;
 deleteBlockRange(taskId:string,fromOrdinal:number,toOrdinal:number):Promise<void>;
 insertBlocks(rows:BlockRecord[]):Promise<void>;
 countBlocks(taskId:string):Promise<number>;
 /** 按 ordinal 升序取一段块。fromOrdinal 从 1 开始。 */
 listBlocks(userId:string,taskId:string,fromOrdinal:number,limit:number):Promise<BlockRecord[]>;
}
const TASK_COLUMNS:Record<keyof TaskRecord,string>={
 id:"id",userId:"user_id",materialId:"material_id",courseId:"course_id",
 parseStatus:"parse_status",parseEngine:"parse_engine",parseError:"parse_error",parseAttempts:"parse_attempts",parseCursor:"parse_cursor",
 generateStatus:"generate_status",generateEngine:"generate_engine",generateError:"generate_error",generateAttempts:"generate_attempts",generateCursor:"generate_cursor",
 sourceSha256:"source_sha256",byteSize:"byte_size",pageCount:"page_count",blockCount:"block_count",truncated:"truncated",
 leaseUntil:"lease_until",createdAt:"created_at",updatedAt:"updated_at",
};
const BLOCK_COLUMNS:Record<keyof BlockRecord,string>={
 id:"id",taskId:"task_id",userId:"user_id",materialId:"material_id",courseId:"course_id",ordinal:"ordinal",
 locator:"locator",locatorKind:"locator_kind",locatorValue:"locator_value",heading:"heading",text:"text",charCount:"char_count",
};
const MATERIAL_COLUMNS="id,user_id AS userId,course_id AS courseId,name,filename,content_type AS contentType,size,storage_key AS storageKey,url";
function selectList(columns:Record<string,string>){return Object.entries(columns).map(([field,column])=>column===field?field:column+" AS "+field).join(",")}
function insertList(columns:Record<string,string>){return Object.values(columns).join(",")}
function placeholders(columns:Record<string,string>){return Object.values(columns).map(()=>"?").join(",")}
function insertValues<T extends object>(columns:Record<string,string>,row:T){return Object.keys(columns).map(field=>(row as Record<string,unknown>)[field])}
const TASK_SELECT=selectList(TASK_COLUMNS),TASK_INSERT=insertList(TASK_COLUMNS),TASK_VALUES=placeholders(TASK_COLUMNS);
const BLOCK_SELECT=selectList(BLOCK_COLUMNS),BLOCK_INSERT=insertList(BLOCK_COLUMNS),BLOCK_VALUES=placeholders(BLOCK_COLUMNS);
/** D1 对单次请求的语句数量和体积都有限制，按条数和累计字符数双重量分批写入。 */
const batchSize=25,batchChars=200000;
function chunkBlocks(rows:BlockRecord[]):BlockRecord[][]{
 const chunks:BlockRecord[][]=[];let current:BlockRecord[]=[],chars=0;
 for(const row of rows){
  if(current.length&&(current.length>=batchSize||chars+row.text.length>batchChars)){chunks.push(current);current=[];chars=0}
  current.push(row);chars+=row.text.length;
 }
 if(current.length)chunks.push(current);
 return chunks;
}
export function d1TaskStore(db:D1Database):TaskStore{
 const one=async<T>(sql:string,values:unknown[])=>(await db.prepare(sql).bind(...values).first<T>())??null;
 return {
  findMaterial:(userId,materialId)=>one<MaterialRecord>("SELECT "+MATERIAL_COLUMNS+" FROM materials WHERE id = ? AND user_id = ?",[materialId,userId]),
  getTask:(userId,taskId)=>one<TaskRecord>("SELECT "+TASK_SELECT+" FROM material_tasks WHERE id = ? AND user_id = ?",[taskId,userId]),
  findReusableTask:(userId,materialId)=>one<TaskRecord>("SELECT "+TASK_SELECT+" FROM material_tasks WHERE user_id = ? AND material_id = ? AND parse_status IN ('pending','running','ready','needs_ocr') ORDER BY created_at DESC LIMIT 1",[userId,materialId]),
  async createTask(row){await db.prepare("INSERT INTO material_tasks ("+TASK_INSERT+") VALUES ("+TASK_VALUES+")").bind(...insertValues(TASK_COLUMNS,row)).run()},
  async updateTask(taskId,patch){
   const fields=Object.keys(patch) as (keyof TaskPatch)[];
   if(!fields.length)return;
   const sql="UPDATE material_tasks SET "+fields.map(field=>TASK_COLUMNS[field as keyof TaskRecord]+" = ?").join(", ")+" WHERE id = ?";
   await db.prepare(sql).bind(...fields.map(field=>patch[field] as unknown),taskId).run();
  },
  async claimTask(taskId,now,leaseUntil){
   // 只在「从头开始」（parse_cursor = 0）时累加尝试次数，分页续跑不算一次新尝试，否则重试上限会被分页吃掉。
   const result=await db.prepare("UPDATE material_tasks SET parse_status = 'running', parse_attempts = parse_attempts + (CASE WHEN parse_cursor = 0 THEN 1 ELSE 0 END), lease_until = ?, updated_at = ? WHERE id = ? AND parse_status IN ('pending','running','needs_ocr') AND (lease_until = '' OR lease_until <= ?)").bind(leaseUntil,now,taskId,now).run();
   return !!result.meta.changes;
  },
  async deleteBlocks(taskId){await db.prepare("DELETE FROM material_blocks WHERE task_id = ?").bind(taskId).run()},
  async deleteBlockRange(taskId,fromOrdinal,toOrdinal){await db.prepare("DELETE FROM material_blocks WHERE task_id = ? AND ordinal >= ? AND ordinal < ?").bind(taskId,fromOrdinal,toOrdinal).run()},
  async insertBlocks(rows){
   for(const chunk of chunkBlocks(rows))await db.batch(chunk.map(row=>db.prepare("INSERT INTO material_blocks ("+BLOCK_INSERT+") VALUES ("+BLOCK_VALUES+")").bind(...insertValues(BLOCK_COLUMNS,row))));
  },
  async countBlocks(taskId){const row=await one<{n:number}>("SELECT COUNT(*) AS n FROM material_blocks WHERE task_id = ?",[taskId]);return row?.n??0},
  // user_id 也进 WHERE：服务层已经校验过归属，这里再挡一道，避免将来有人复用这条语句时漏掉隔离。
  listBlocks:async(userId,taskId,fromOrdinal,limit)=>(await db.prepare("SELECT "+BLOCK_SELECT+" FROM material_blocks WHERE user_id = ? AND task_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?").bind(userId,taskId,fromOrdinal,limit).all<BlockRecord>()).results,
 };
}
