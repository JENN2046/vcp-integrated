class VoicePCM extends AudioWorkletProcessor {
 constructor(){super();this.phase=0;this.sum=0;this.count=0;this.buffer=new Int16Array(1600);this.offset=0;this.energy=0;this.stopped=false;this.port.onmessage=event=>{if(event.data!=='flush'||this.stopped)return;this.stopped=true;if(this.offset){const tail=this.buffer.slice(0,this.offset);this.port.postMessage({pcm:tail.buffer,level:Math.sqrt(this.energy/this.offset)},[tail.buffer]);}this.port.postMessage('flushed');};}
 process(inputs) {
  const ch=inputs[0]?.[0];
  if(!ch||this.stopped)return true;
  for(const value of ch){
   this.phase+=16000;this.sum+=value;this.count++;
   if(this.phase<sampleRate)continue;
   this.phase-=sampleRate;
   const average=Math.max(-1,Math.min(1,this.sum/this.count));
   this.energy+=average*average;
   this.buffer[this.offset++]=Math.round(average*(average<0?32768:32767));
   this.count=0;this.sum=0;
   if(this.offset===this.buffer.length){
    this.port.postMessage({pcm:this.buffer.buffer,level:Math.sqrt(this.energy/this.offset)},[this.buffer.buffer]);this.buffer=new Int16Array(1600);this.offset=0;this.energy=0;
   }
  }
  return true;
 }
}
registerProcessor('local-voice-pcm',VoicePCM);
