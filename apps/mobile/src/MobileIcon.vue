<script setup>
defineProps({name: {type:String, required:true}});
const paths = {
 menu:'M4 8h16M4 16h11', settings:'M4 7h16M4 17h16M8 4v6M16 14v6',
 chevron:'m9 18 6-6-6-6', back:'m15 18-6-6 6-6',
 search:'M15.5 15.5 20 20M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
 work:'M3 12h4l3-6 4 12 3-6h4', send:'M12 19V5m-6 6 6-6 6 6',
 plus:'M12 5v14M5 12h14', file:'M13 3H6v18h12V8l-5-5Zm0 0v5h5M9 13h6m-6 4h6',
 close:'m6 6 12 12M18 6 6 18', check:'m5 12 4 4L19 6', tool:'m14 7 3 3 4-4a6 6 0 0 1-7 8l-6 6a2 2 0 0 1-3-3l6-6a6 6 0 0 1 7-8l-4 4Z'
};
</script>

<template>
 <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path :d="paths[name]"/></svg>
</template>
