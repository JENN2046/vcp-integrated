// The browser captures PCM only for the paired, same-origin local recognizer.
export function localSpeechRecognition() {
 if(!window.isSecureContext||location.protocol!=='https:'||!navigator.mediaDevices?.getUserMedia||
    !window.AudioWorkletNode||!window.AudioContext)return null;
 return class LocalSpeech {
  onlevel=null;
  onsettling=null;

  start(){
   this.alive=true;
   const context=this.context=new AudioContext();
   void context.resume().catch(()=>{if(this.alive)this.fail('audio-capture');});
   const setup=context.audioWorklet.addModule('/mobile/voice-pcm-processor.js');
   setup.catch(()=>{if(this.alive)this.fail('audio-capture');});
   const url=new URL('/mobile/api/voice',location.origin);
   url.protocol='wss:';
   const socket=this.socket=new WebSocket(url);
   socket.onmessage=event=>{
    if(!this.alive)return;
    let message;
    try{message=JSON.parse(event.data);}catch{return this.fail('network');}
    if(message?.error){
     const errors={VOICE_PAIR_REQUIRED:'pair-required',VOICE_LIMIT:'limit',VOICE_TIMEOUT:'limit'};
     return this.fail(errors[message.error]||'network');
    }
    if(message?.ready===true&&!this.requested){
     this.requested=true;
     void this.capture(context,setup);
     return;
    }
    if(typeof message?.text!=='string'||!this.requested)return this.fail('network');
    if(message.final===true)this.onsettling?.();
    this.onresult?.({results:[Object.assign([{transcript:message.text}],{isFinal:message.final===true})]});
    if(message.final===true){
     this.cleanup();
     this.settleTimer=setTimeout(()=>{this.settleTimer=null;this.onend?.();},500);
    }
   };
   socket.onerror=()=>this.fail('network');
   socket.onclose=()=>this.fail('network');
  }

  async capture(context,setup){
   try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1},video:false});
    if(!this.alive){stream.getTracks().forEach(track=>track.stop());return;}
    this.stream=stream;
    for(const track of stream.getTracks())track.addEventListener('ended',()=>this.fail('audio-capture'),{once:true});
    await setup;
    if(!this.alive)return;
    this.input=context.createMediaStreamSource(stream);
    const node=this.node=new AudioWorkletNode(context,'local-voice-pcm');
    node.port.onmessage=({data})=>{
     if(!this.alive)return;
     if(this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount+(data?.pcm?.byteLength||0)>128000)
      return this.fail('network');
     if(data==='flushed'){
      this.releaseAudio();
      this.socket.send('finish');
     }else if(data?.pcm instanceof ArrayBuffer){
      this.onlevel?.(data.level);
      this.socket.send(data.pcm);
     }
    };
    this.input.connect(node);
    node.connect(context.destination);
    this.onstart?.();
   }catch(error){if(this.alive)this.fail(error.name==='NotAllowedError'?'not-allowed':'audio-capture');}
  }

  stop(){
   if(!this.alive||this.ending)return;
   this.ending=true;
   this.stream?.getTracks().forEach(track=>track.stop());
   this.stream=null;
   if(this.node&&this.socket?.readyState===WebSocket.OPEN)this.node.port.postMessage('flush');
   else this.fail('network');
  }

  abort(){
   clearTimeout(this.settleTimer);
   this.cleanup();
  }

  fail(error){
   if(!this.alive)return;
   this.cleanup();
   this.onerror?.({error});
  }

  releaseAudio(){
   this.stream?.getTracks().forEach(track=>track.stop());
   this.stream=null;
   this.input?.disconnect();
   this.input=null;
   if(this.node){
    this.node.port.onmessage=null;
    this.node.disconnect();
    this.node=null;
   }
   if(this.context){
    void this.context.close().catch(()=>{});
    this.context=null;
   }
  }

  cleanup(){
   this.alive=false;
   this.releaseAudio();
   if(this.socket&&this.socket.readyState<WebSocket.CLOSING)this.socket.close();
   this.socket=null;
  }
 };
}
