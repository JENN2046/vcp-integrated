<script setup>
import {ref,watch,nextTick,onUnmounted} from 'vue';
import {sharedConfig} from './contracts.generated.js';
import {mountSharedEditor} from '../../desktop/modules/nativeSyncSettings/sharedEditor.js';
const props=defineProps({topic:Object,context:Object,api:Function});
const opened=ref(false),host=ref(null);let editor,epoch=0;
watch([opened,()=>props.topic?.sharedOwnerId,()=>props.context?.sessionMarker,()=>props.topic?.sharedSpaceId],async()=>{
 const turn=++epoch;editor?.dispose();editor=null;if(!opened.value)return;await nextTick();if(turn!==epoch||!host.value)return;
 editor=mountSharedEditor(host.value,{api:props.api,normalize:sharedConfig,topic:props.topic,context:props.context});
});
onUnmounted(()=>{epoch++;editor?.dispose();});
</script>
<template><section class="shared-config"><button v-if="!opened" id="shared-config-open" @click="opened=true">{{topic?.configurationEditable===false?'查看共享配置':'编辑共享 Agent／群聊配置'}}</button><template v-else><button @click="opened=false">收起</button><div ref="host"/></template></section></template>
<style>
.shared-config{padding:12px;border:1px solid var(--border,#8885);border-radius:8px;margin:8px 0}.heading{display:flex;justify-content:space-between;align-items:center}label{display:block;margin:8px 0}input:not([type=checkbox]),select,textarea{width:100%;box-sizing:border-box;padding:8px}input[type=checkbox]{width:auto}select[multiple]{min-height:100px}textarea{resize:vertical}button{margin:4px;padding:8px}p{font-size:.9rem}.rule,.conflict{border:1px solid #8886;padding:8px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}
</style>
