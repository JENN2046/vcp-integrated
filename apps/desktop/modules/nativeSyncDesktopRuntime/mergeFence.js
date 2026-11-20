// Native configuration managers call apply after changing the displayed object.
const disabled=new Map();
export const mergeFence={local:new Set(),shared:new Set(),
 set(scope){this.local=new Set(scope.localIds||[]);this.shared=new Set(scope.sharedIds||[]);this.apply();document.dispatchEvent(new Event('native-sync:merge-fence'));},
 apply(){
  for(const [node,value]of disabled)if(node.isConnected)node.disabled=value;disabled.clear();
  const entries=[['#agentSettingsForm',globalThis.settingsManager?.getEditingAgentId?.()],['#groupSettingsForm',globalThis.GroupRenderer?.getEditingGroupId?.()]];
  for(const [selector,id]of entries)if(this.local.has(id))for(const n of document.querySelectorAll(selector+' input,'+selector+' textarea,'+selector+' select,'+selector+' button')){disabled.set(n,n.disabled);n.disabled=true;}
 }};
globalThis.NativeSyncMergeFence=mergeFence;
