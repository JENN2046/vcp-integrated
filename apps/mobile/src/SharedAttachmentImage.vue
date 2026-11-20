<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue';
import {readAttachment} from './attachmentRead.js';
const props=defineProps({url:String,alt:String}),source=ref(''),failed=ref(false),target=ref(null),visible=ref(false);let controller,observer,turn=0;
function clear(){turn++;controller?.abort();controller=null;if(source.value)URL.revokeObjectURL(source.value);source.value='';}
watch([()=>props.url,visible],async([url,seen])=>{clear();failed.value=false;if(!url||!seen)return;const request=turn;controller=new AbortController();try{const blob=await readAttachment(url,{signal:controller.signal});if(request!==turn)return;if(!blob.type.startsWith('image/'))throw Error('IMAGE_REQUIRED');source.value=URL.createObjectURL(blob);}catch(e){if(request===turn&&e.name!=='AbortError')failed.value=true;}},{immediate:true});
onMounted(()=>{if(!globalThis.IntersectionObserver){visible.value=true;return;}observer=new IntersectionObserver(items=>{if(items.some(i=>i.isIntersecting)){visible.value=true;observer.disconnect();}},{rootMargin:'200px'});observer.observe(target.value);});
onBeforeUnmount(()=>{observer?.disconnect();clear();});
</script>
<template><span ref="target"><img v-if="source" :src="source" :alt="alt" loading="lazy"><small v-else-if="failed" role="status">图片暂时无法读取，可点击附件核对。</small><small v-else>图片附件</small></span></template>
