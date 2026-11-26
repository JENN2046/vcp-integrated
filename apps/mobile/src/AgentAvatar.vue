<script setup>
import {computed,ref,watch} from 'vue';
const props=defineProps({src:String,name:String});
const failed=ref(false);
watch(()=>props.src,()=>{failed.value=false;});
const initial=computed(()=>Array.from((props.name||'').trim())[0]?.toLocaleUpperCase()||'·');
</script>

<template>
 <span class="agent-avatar" aria-hidden="true"><img v-if="src&&!failed" :src="src" alt="" @error="failed=true"><span v-else>{{initial}}</span></span>
</template>
