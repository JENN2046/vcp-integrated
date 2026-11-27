<script setup>
import {computed,onUnmounted,ref,watch} from 'vue';
import MobileIcon from './MobileIcon.vue';
const props=defineProps({job:{type:Object,required:true},live:Object,connected:Boolean,hasReply:Boolean,replySyncing:Boolean});
const emit=defineEmits(['open-reply']);
const running=computed(()=>['queued','running','waiting_approval','cancelling'].includes(props.job.state));
const title=computed(()=>props.replySyncing?'正在同步回复':!props.connected&&running.value?'连接中断 · 显示最近状态':
 running.value&&props.live?.approval?'等待桌面审批':running.value&&props.live?.tool?props.live.tool+' · '+(props.live.toolStatus||'状态待核对'):
 ({queued:'等待开始',running:'正在生成回复',waiting_approval:'等待桌面审批',cancelling:'正在请求取消',completed:'任务完成',failed:'任务失败',cancelled:'任务已取消',review_required:'需要核对'})[props.job.state]||'状态待核对');
const now=ref(Date.now());
let timer;
watch(()=>running.value&&props.connected,active=>{
 clearInterval(timer);
 if(active){now.value=Date.now();timer=setInterval(()=>{now.value=Date.now();},1000);}
},{immediate:true});
onUnmounted(()=>clearInterval(timer));
const elapsed=computed(()=>{
 if(!running.value||!props.connected||!Number.isFinite(props.job.createdAt))return '';
 const sec=Math.max(0,Math.floor((now.value-props.job.createdAt)/1000));
 return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
});
</script>
<template><details class="inline-agent-run" :data-running="running&&connected" :data-run-id="job.id" :data-run-state="job.state">
 <summary><span class="run-dot" aria-hidden="true"></span><strong>Agent Run</strong><span>{{title}}</span><time v-if="elapsed" :aria-label="'已用时间 '+elapsed">{{elapsed}}</time><MobileIcon name="chevron"/></summary>
 <ol><li>任务已记录</li><li v-if="job.state!=='queued'">{{title}}</li><li v-for="tool in job.tools||[]" :key="tool.id">{{tool.name}} · {{({'completed':'已完成','running':'运行中','failed':'失败','dispatched':'已派发','denied':'已拒绝','cancelled':'已取消'})[tool.status]||'状态待核对'}}</li><li v-if="job.errorCode" class="run-error">{{job.errorCode}}</li></ol>
 <button v-if="hasReply" class="work-reply" type="button" @click="emit('open-reply')">查看原回复</button>
</details></template>
