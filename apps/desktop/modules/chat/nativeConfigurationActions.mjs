// Conflict handling stays in the existing editor. Rebase requires an explicit
// user choice; it never publishes or discards the current form by itself.
export async function offerNativeConfigurationRebase({api,base,uiHelper,onVersion}){
 if(!base||!uiHelper?.showConfirmDialog)return false;
 const info=await api.sharedConfigContext();if(!info?.enabled)return false;
 const current=await api.sharedConfigRequest({route:'shared/config?'+new URLSearchParams({sharedSpaceId:info.topic.sharedSpaceId,sharedId:base.sharedId})});
 if(current?.success===false||!current.object)return false;
 if(!await uiHelper.showConfirmDialog(`共享配置已从版本 ${base.version} 变为 ${current.object.version}。当前草稿已保留。是否以新版为基准保留草稿？之后再次保存将提交当前草稿中的共享字段。`,'共享配置冲突','保留草稿并重新确认','暂不保存',true))return false;
 const result=await api.sharedConfigRequest({route:'shared/config-resolution',body:{sharedSpaceId:info.topic.sharedSpaceId,sharedId:base.sharedId,choice:'local'}});
 if(result?.success===false)throw Error(result.error||'SHARED_CONFIG_CONFLICT');
 onVersion?.({sharedId:base.sharedId,version:result.object.version});
 uiHelper.showToastNotification?.('草稿已保留，请核对后再次点击保存。','info');return true;
}
