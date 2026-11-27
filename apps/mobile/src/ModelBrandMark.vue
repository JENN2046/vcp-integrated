<script setup>
import {computed} from 'vue';
import openai from './model-brands/openai.svg';
import claude from './model-brands/claude.svg';
import gemini from './model-brands/gemini.svg';
import deepseek from './model-brands/deepseek.svg';
import qwen from './model-brands/qwen.svg';
import doubao from './model-brands/doubao.svg';
import grok from './model-brands/grok.svg';
import mistral from './model-brands/mistral.svg';
const props=defineProps({model:String});
const brands=[
 [/^(?:openai|chatgpt|gpt(?:[-.]|$)|o[134](?:[-.]|$))/u,openai,'openai'],
 [/^(?:anthropic|claude)(?:[-_.:]|$)/u,claude,'claude'],
 [/^gemini(?:[-_.:]|$)/u,gemini,'gemini'],
 [/^deepseek(?:[-_.:]|$)/u,deepseek,'deepseek'],
 [/^(?:qwen(?:[0-9_.:-]|$)|qwq(?:[-_.:]|$))/u,qwen,'qwen'],
 [/^(?:doubao|豆包)(?:[-_.:]|$)/u,doubao,'doubao'],
 [/^(?:grok|xai)(?:[-_.:]|$)/u,grok,'grok'],
 [/^(?:mistral|mixtral)(?:[-_.:]|$)/u,mistral,'mistral']
];
const brand=computed(()=>{
 const id=String(props.model||'').trim().toLowerCase();
 const family=id.split('/').at(-1).replace(/^test-/u,'');
 return brands.find(([matches])=>matches.test(family));
});
</script>
<template>
 <img v-if="brand" class="model-brand-mark" :src="brand[1]" :data-model-brand="brand[2]" alt="" aria-hidden="true">
 <svg v-else class="model-brand-mark" data-model-brand="generic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" aria-hidden="true">
  <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z M4 7.5l8 4.5 8-4.5 M12 12v9"/>
 </svg>
</template>
