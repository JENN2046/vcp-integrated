/** Projection only: generation replies precede later, unconsumed input to that work. */
export function orderSharedHistory(history){
 if(!Array.isArray(history))return history;const result=[...history];
 for(const message of history){const c=message?.continuity||message?._nativeSyncMetadata?.fields?.continuity;if(message?.role!=='assistant'||message.isGroupMessage||c?.known!==true||!c.executionId)continue;
  const consumed=new Set(c.dependsOnMessageIds||[]),through=result.reduce((last,other,index)=>other.role==='user'&&(other.continuity||other._nativeSyncMetadata?.fields?.continuity)?.executionId===c.executionId&&consumed.has(other.id)?index:last,-1),before=result.findIndex((other,index)=>index>through&&other.role==='user'&&(other.continuity||other._nativeSyncMetadata?.fields?.continuity)?.executionId===c.executionId&&!consumed.has(other.id)),position=result.indexOf(message);
  if(through>=0&&before>=0&&position>before){result.splice(position,1);result.splice(before,0,message);}
 }return result;
}
