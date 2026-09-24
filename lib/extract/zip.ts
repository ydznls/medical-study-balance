// 最小 ZIP 读取器：只解析中央目录，按需解压指定条目。
// 使用运行时自带的 DecompressionStream("deflate-raw")，不引入任何依赖。
// 不支持：ZIP64、加密归档、非 UTF-8 文件名（OOXML 内部路径均为 ASCII）。
const EOCD_SIG=0x06054b50,CD_SIG=0x02014b50,LOCAL_SIG=0x04034b50,ZIP64_LOCATOR_SIG=0x07064b50;
const MAX_COMMENT=0xffff,METHOD_STORE=0,METHOD_DEFLATE=8;
export class ZipError extends Error{code:string;constructor(code:string,message:string){super(message);this.name="ZipError";this.code=code}}
export type ZipEntry={name:string;method:number;compressedSize:number;size:number;offset:number};
type View={bytes:Uint8Array;view:DataView};
function viewOf(bytes:Uint8Array):View{return {bytes,view:new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)}}
function decodeName(bytes:Uint8Array){return new TextDecoder("utf-8").decode(bytes)}
async function inflateRaw(data:Uint8Array):Promise<Uint8Array>{
 if(typeof DecompressionStream==="undefined")throw new ZipError("runtime_unsupported","当前运行时不支持 DecompressionStream，无法解压资料。");
 const stream=new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** 读取中央目录。条目顺序与归档内顺序一致。 */
export function listZipEntries(bytes:Uint8Array):ZipEntry[]{
 const {view}=viewOf(bytes),length=bytes.length;
 if(length<22)throw new ZipError("corrupt_archive","文件太小，不是完整的 ZIP 归档。");
 let eocd=-1;
 for(let i=length-22;i>=Math.max(0,length-22-MAX_COMMENT);i--)if(view.getUint32(i,true)===EOCD_SIG){eocd=i;break}
 if(eocd<0)throw new ZipError("corrupt_archive","没有找到 ZIP 中央目录，文件可能已损坏或没有上传完整。");
 if(eocd>=20&&view.getUint32(eocd-20,true)===ZIP64_LOCATOR_SIG)throw new ZipError("zip64_unsupported","这个归档使用了 ZIP64 格式，暂不支持。");
 const count=view.getUint16(eocd+10,true),offset=view.getUint32(eocd+16,true);
 if(count===0xffff||offset===0xffffffff)throw new ZipError("zip64_unsupported","这个归档使用了 ZIP64 格式，暂不支持。");
 if(count===0)throw new ZipError("corrupt_archive","这个归档里没有任何文件。");
 if(offset>length)throw new ZipError("corrupt_archive","ZIP 中央目录的位置超出了文件范围。");
 const entries:ZipEntry[]=[];
 let at=offset;
 for(let i=0;i<count;i++){
  if(at+46>length||view.getUint32(at,true)!==CD_SIG)throw new ZipError("corrupt_archive","ZIP 中央目录条目损坏。");
  const nameLength=view.getUint16(at+28,true),extraLength=view.getUint16(at+30,true),commentLength=view.getUint16(at+32,true);
  const compressedSize=view.getUint32(at+20,true),size=view.getUint32(at+24,true),local=view.getUint32(at+42,true);
  if(compressedSize===0xffffffff||size===0xffffffff||local===0xffffffff)throw new ZipError("zip64_unsupported","这个归档使用了 ZIP64 格式，暂不支持。");
  if(at+46+nameLength>length)throw new ZipError("corrupt_archive","ZIP 条目名称超出文件范围。");
  entries.push({name:decodeName(bytes.subarray(at+46,at+46+nameLength)),method:view.getUint16(at+10,true),compressedSize,size,offset:local});
  at+=46+nameLength+extraLength+commentLength;
 }
 return entries;
}
/** 按需解压：wanted 返回 false 的条目只登记名称，不读取内容。 */
export async function readZipEntries(bytes:Uint8Array,wanted?:(name:string)=>boolean):Promise<Map<string,Uint8Array>>{
 const {view}=viewOf(bytes),out=new Map<string,Uint8Array>();
 for(const entry of listZipEntries(bytes)){
  if(wanted&&!wanted(entry.name))continue;
  const at=entry.offset;
  if(at+30>bytes.length||view.getUint32(at,true)!==LOCAL_SIG)throw new ZipError("corrupt_archive","ZIP 条目头部损坏："+entry.name);
  const nameLength=view.getUint16(at+26,true),extraLength=view.getUint16(at+28,true);
  const start=at+30+nameLength+extraLength,end=start+entry.compressedSize;
  if(end>bytes.length)throw new ZipError("corrupt_archive","ZIP 条目内容超出文件范围："+entry.name);
  const raw=bytes.subarray(start,end);
  if(entry.method===METHOD_STORE)out.set(entry.name,raw.slice());
  else if(entry.method===METHOD_DEFLATE){try{out.set(entry.name,await inflateRaw(raw))}catch(error){if(error instanceof ZipError)throw error;throw new ZipError("corrupt_archive","ZIP 条目解压失败："+entry.name)}}
  else throw new ZipError("unsupported_compression","这个归档使用了不支持的压缩方式（编号 "+entry.method+"）。");
 }
 return out;
}
