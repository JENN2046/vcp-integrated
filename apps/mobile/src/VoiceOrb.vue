<script setup>
const points=Array.from({length:160},(_,i)=>{
 const y=1-(i+.5)*2/160,a=i*2.3999632,r=Math.sqrt(1-y*y),z=Math.sin(a)*r;
 return {x:21+17*Math.cos(a)*r,y:21+17*y,r:.45+.45*z,z};
}).filter(p=>p.z>0);
</script>
<template><svg viewBox="0 0 42 42" width="34" height="34" aria-hidden="true" class="voice-orb-dots"><circle v-for="(p,i) in points" :key="i" :cx="p.x" :cy="p.y" :r="p.r" fill="currentColor" :opacity=".27+.73*p.z"/></svg></template>
