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
<template><section class="shared-config"><button id="shared-config-open" class="shared-panel-toggle" type="button" :aria-expanded="opened" @click="opened=!opened">{{opened?'收起配置':topic?.configurationEditable===false?'查看共享配置':'编辑共享 Agent／群聊配置'}}</button><div v-if="opened" ref="host"/></section></template>
<style>
.shared-config{padding:12px;border:1px solid var(--border,#8885);border-radius:8px;margin:8px 0}
.shared-config .heading{display:flex;justify-content:space-between;align-items:center}
.shared-config label{display:block;margin:8px 0}
.shared-config :is(input:not([type=checkbox]),select,textarea){width:100%;box-sizing:border-box;padding:8px}
.shared-config input[type=checkbox]{width:auto}
.shared-config select[multiple]{min-height:100px}
.shared-config textarea{resize:vertical}
.shared-config button{margin:4px;padding:8px}
.shared-config p{font-size:.9rem}
.shared-config :is(.rule,.conflict){border:1px solid #8886;padding:8px;margin:8px 0}
.shared-config pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}
</style>
