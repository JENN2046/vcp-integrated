<script setup>
import {onMounted,onUnmounted,ref,watch} from 'vue';
const props=defineProps({level:Number,phase:String,phrase:String});
const emit=defineEmits(['stop','cancel']);
const canvas=ref(null),stopButton=ref(null);
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const glyphs='·.·:+=*x01o+.:';
const count=560;
const points=Array.from({length:count},(_,i)=>{
 const y=1-(i+.5)*2/count,a=i*2.3999632,r=Math.sqrt(1-y*y);
 return {x:Math.cos(a)*r,y,z:Math.sin(a)*r,ring:a,coil:i*1.64633,c:glyphs[i%glyphs.length]};
});
let raf,previous=0,rotation=0,amplitude=0,completion=0,phraseGlyphs=[];
watch(()=>props.phrase,value=>{phraseGlyphs=Array.from(value||'').filter(c=>c.trim()).slice(-18);});
function paint(now){
 const surface=canvas.value;
 if(!surface)return;
 const context=surface.getContext('2d'),size=surface.width;
 if(!context)return;
 const dt=previous?Math.min(48,now-previous):16;previous=now;
 const still=motion.matches,time=still?0:now/1000;
 const target=Math.max(0,Math.min(1,(Number(props.level||0)-.013)*16));
 amplitude=still?0:amplitude+(target-amplitude)*(1-Math.exp(-dt/(target>amplitude?62:230)));
 completion=still?0:completion+((props.phase==='finishing'?1:0)-completion)*(1-Math.exp(-dt/175));
 if(!still)rotation+=dt*(.00031+amplitude*.0003);
 const co=Math.cos(rotation),si=Math.sin(rotation),tilt=.22;
 const dark=document.documentElement.dataset.theme==='dark';
 context.clearRect(0,0,size,size);
 const center=size/2;
 context.textAlign='center';context.textBaseline='middle';
 const projected=points.map((p,i)=>{
  const wave=(.13*Math.sin(3.7*p.y+2.4*p.x+6.0*time)+.075*Math.sin(4*p.z-4.6*time)+.035*Math.cos(6*p.x+2*time));
  const stretch=1+amplitude*wave;
  let x=(p.x*co+p.z*si)*stretch,y=p.y*stretch,z=(p.z*co-p.x*si)*stretch;
  if(completion>.001){
   const a=p.ring+time*.6,r=.76+.20*Math.cos(p.coil);
   x+=(Math.cos(a)*r-x)*completion;
   y+=(Math.sin(a)*r*.73+.17*Math.sin(p.coil)-y)*completion;
   z+=(Math.sin(a)*r*.68-z)*completion;
  }
  const depth=z*Math.cos(tilt)+y*Math.sin(tilt);
  y=y*Math.cos(tilt)-z*Math.sin(tilt);
  return {x,y,z:depth,p,i};
 }).sort((a,b)=>a.z-b.z);
 const radius=size*(.377+amplitude*.026);
 for(const {x,y,z,p,i} of projected){
  const front=Math.max(0,Math.min(1,z));
  const perspective=1/(1-.21*z);
  const px=center+x*radius*perspective,py=center+y*radius*perspective;
  const live=z>.46&&phraseGlyphs.length&&i%13===0;
  const alpha=z<0?.08+(z+1)*.10:.74+front*.25;
  context.globalAlpha=alpha;
  context.fillStyle=dark?(live?'#dce8df':'#f3f5f1'):(live?'#113f5a':'#172536');
  const fontSize=size*(.020+front*.011)*(live?1.12:1);
  if((p.c==='·'||p.c==='.')&&!live){
   context.beginPath();context.arc(px,py,fontSize*.146,0,Math.PI*2);context.fill();
  }else{
   context.font=(z>0?'650 ':'450 ')+fontSize.toFixed(1)+'px ui-monospace, monospace';
   context.fillText(live?phraseGlyphs[i%phraseGlyphs.length]:p.c,px,py);
  }
 }
 context.globalAlpha=1;
 raf=requestAnimationFrame(paint);
}
onMounted(()=>{stopButton.value?.focus({preventScroll:true});raf=requestAnimationFrame(paint);});
onUnmounted(()=>cancelAnimationFrame(raf));
</script>
<template>
 <section class="voice-stage" aria-label="语音听写">
  <button ref="stopButton" class="voice-stage-orb" type="button" :disabled="phase==='finishing'" aria-label="结束语音输入" @click="emit('stop')">
   <canvas ref="canvas" width="512" height="512" aria-hidden="true"></canvas>
  </button>
  <div class="voice-stage-controls">
   <span class="voice-stage-state" role="status">{{phase==='starting'?'正在开启麦克风':phase==='finishing'?'正在完成识别':'正在听 · 说完停顿即可'}}</span>
   <button class="voice-stage-cancel" type="button" id="voice-cancel" @click="emit('cancel')">取消</button>
  </div>
 </section>
</template>
