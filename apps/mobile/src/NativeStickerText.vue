<script setup>
import { computed, reactive } from 'vue';

const props = defineProps({ parts: Array, fallback: String, base: String });
const failed = reactive(new Set());
const unavailable = '表情包暂不可用';
const segments = computed(() => props.parts || [{text: props.fallback
    ?.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*(?:>|$)/gi, unavailable)
    .replace(/\/pw=[^/\s"'<>]*/gi, '/pw=[已隐藏]')}]);
</script>

<template>
 <span class="native-sticker-text"><template v-for="(part,index) in segments" :key="index"><template v-if="part.text!==undefined">{{part.text}}</template><img v-else-if="base&&Number.isInteger(part.sticker)&&!failed.has(part.sticker)"
   class="native-sticker" :src="base+'/'+part.sticker" alt="表情包" loading="lazy" @error="failed.add(part.sticker)"><span v-else class="native-sticker-unavailable">表情包暂不可用</span></template></span>
</template>

<style scoped>
.native-sticker{display:inline-block;vertical-align:middle;max-width:min(10rem,100%);max-height:10rem;object-fit:contain}
.native-sticker-unavailable{color:var(--muted)}
</style>
