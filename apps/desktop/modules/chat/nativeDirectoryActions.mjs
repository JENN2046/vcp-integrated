// One native confirmation surface; the main process resolves all shared IDs.
export async function prepareNativeDeletion(api,scope){
 if(typeof api.getNativeDeletionContext!=='function')throw Error('NATIVE_DIRECTORY_UNAVAILABLE');
 const context=await api.getNativeDeletionContext(scope);
 if(context?.success!==true||!['local','shared'].includes(context.kind))throw Error(context?.error||'NATIVE_DIRECTORY_UNAVAILABLE');
 return context;
}
export function nativeDeletionOptions(context,mode='all'){
 if(context.core){
  if(mode!=='all')throw Error('CORE_DELETE_SCOPE_CHANGED');
  return undefined;
 }
 return context.kind==='shared'?{mode,confirmed:true,expectedVersion:context.expectedVersion,operationId:context.operationId,expectedBinding:context.expectedBinding}:undefined;
}
export function nativeDeletionText(context,original,name,mode='all'){
 if(context.kind!=='shared')return original;
 name=context.name||name;
 return mode==='device'?`仅将“${name}”移出本机列表？其他设备、共享历史和执行记录保留。`:`删除共享对象“${name}”？此操作会同步到所有设备；原账本和执行回执保留。`;
}
