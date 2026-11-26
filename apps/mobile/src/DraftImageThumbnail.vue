<script setup>
import {ref,watch} from 'vue';
import MobileIcon from './MobileIcon.vue';

const props=defineProps({file:{type:File,required:true}});
const url=ref(''),failed=ref(false);
watch(()=>props.file,(file,_previous,onCleanup)=>{
 const objectUrl=URL.createObjectURL(file);
 failed.value=false;
 url.value=objectUrl;
 onCleanup(()=>URL.revokeObjectURL(objectUrl));
},{immediate:true});
</script>

<template>
 <img v-if="!failed" :key="url" :src="url" alt="" @error="failed=true">
 <MobileIcon v-else name="file"/>
</template>
