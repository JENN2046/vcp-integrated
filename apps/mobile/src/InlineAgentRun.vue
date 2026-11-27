<script setup>
import {computed,onUnmounted,ref,watch} from 'vue';
import MobileIcon from './MobileIcon.vue';
const props=defineProps({job:{type:Object,required:true},status:{type:String,required:true},tasks:Array,connected:Boolean});
const title=computed(()=>props.connected?props.status:'连接中断 · 显示最近状态');
const taskStates={accepted:'已接受',waiting:'等待中',running:'运行中',cancelling:'正在取消'};
const now=ref(Date.now());
let timer;
watch(()=>props.connected,active=>{
 clearInterval(timer);
 if(active){now.value=Date.now();timer=setInterval(()=>{now.value=Date.now();},1000);}
},{immediate:true});
onUnmounted(()=>clearInterval(timer));
const elapsed=computed(()=>{
 if(!props.connected||!Number.isFinite(props.job.createdAt))return '';
 const sec=Math.max(0,Math.floor((now.value-props.job.createdAt)/1000));
 return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
});
</script>
<template><details class="inline-agent-run" :data-running="connected" :data-run-id="job.id" :data-run-state="job.state">
 <summary><span class="run-dot" aria-hidden="true"></span><strong>Agent Run</strong><span>{{title}}</span><time v-if="elapsed" :aria-label="'已用时间 '+elapsed">{{elapsed}}</time><MobileIcon name="chevron"/></summary>
 <ol><li>任务已记录</li><li v-if="job.state==='waiting_approval'">{{status}}</li><li v-for="task in tasks" :key="task.id">{{task.agent||'后台任务'}} · {{taskStates[task.state]}}</li></ol>
</details></template>
