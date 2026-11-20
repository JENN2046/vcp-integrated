<script setup>
import {ref,watch,nextTick,onUnmounted} from 'vue';
import {mountSharedDirectory} from '../../desktop/modules/nativeSyncSettings/sharedDirectory.js';
const props=defineProps({space:Object,context:Object,api:Function,onDeviceVisibility:Function});
const opened=ref(false),host=ref(null);let view,epoch=0;
watch([opened,()=>props.space?.id,()=>props.context?.sessionMarker],async()=>{const turn=++epoch;view?.dispose();view=null;if(!opened.value)return;await nextTick();if(turn!==epoch||!host.value)return;view=mountSharedDirectory(host.value,{api:props.api,spaceId:props.space.id,context:props.context,canDelete:props.space.config===true,onDeviceVisibility:props.onDeviceVisibility});});
onUnmounted(()=>{epoch++;view?.dispose();});
</script>
<template><section class="shared-directory"><button v-if="!opened" id="shared-directory-open" @click="opened=true">管理共享目录</button><template v-else><button @click="opened=false">收起目录</button><div ref="host"/></template></section></template>
<style>.shared-directory{padding:10px;border:1px solid #8885;margin:8px 0;border-radius:8px}.shared-directory-row{padding:8px;border-bottom:1px solid #8884;display:flex;flex-wrap:wrap;gap:6px}.shared-directory-row span{width:100%}.shared-directory [role=dialog]{padding:12px;border:2px solid #8888}.shared-directory button{padding:7px}.shared-directory input[type=checkbox]{width:auto}</style>
