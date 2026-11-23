<script setup>
import {computed} from 'vue';

const props=defineProps({relay:{type:Object,required:true}});
const next=computed(()=>props.relay.members.find(member=>member.ordinal===props.relay.nextOrdinal));
const status=computed(()=>{
 const r=props.relay, member=next.value?.name;
 switch(r.state){
 case 'awaiting_handoff': return '等待桌面接管';
 case 'awaiting_continue': return '等待桌面继续';
 case 'first_member':
 case 'continuing': return member ? '等待'+member+'的正式回复' : '等待桌面结算';
 case 'review_required': return '结果待核对，请回桌面处理';
 case 'abandoned': return '已人工结束，剩余接力已停止';
 case 'completed': return '接力已完成';
 default: return '接力状态待核对';
 }
});
function memberStatus(member){
 const r=props.relay;
 if(member.replySeq!==null)return '正式回复已确认';
 if(member.ordinal===r.unknownOrdinal)return '已派发，结果待核对';
 if(member.ordinal===r.nextOrdinal){
  if(r.state==='awaiting_handoff')return '待接管';
  if(r.state==='awaiting_continue')return '待继续';
  return '等待正式回复';
 }
 if(r.unknownOrdinal!==null && member.ordinal>r.unknownOrdinal)return '未开始';
 if(r.state==='abandoned'||r.state==='review_required')return '没有已确认的回复';
 return '待轮到';
}
</script>

<template>
 <article class="execution-job desktop-relay" :data-exec-id="relay.id" :data-state="relay.state">
  <strong>{{status}}</strong>
  <p v-if="relay.state==='awaiting_handoff' && next">请在另一台有权桌面接管，下一位是{{next.name}}。</p>
  <p v-else-if="relay.state==='awaiting_continue' && next">请在{{relay.executor || '已接管的桌面'}}继续，下一位是{{next.name}}。</p>
  <p v-else-if="relay.state==='continuing' && relay.executor">执行桌面：{{relay.executor}}</p>
  <small>桌面群聊接力 · {{relay.confirmedCount}} / {{relay.memberCount}} 位成员已确认</small>
  <ol class="group-steps"><li v-for="member in relay.members" :key="member.ordinal" :value="member.ordinal+1">{{member.name}} · {{memberStatus(member)}}</li></ol>
  <small v-if="relay.members.length<relay.memberCount">显示前 128 位及当前待处理成员。</small>
 </article>
</template>
