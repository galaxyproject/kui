<script setup lang="ts">
withDefaults(defineProps<{ title?: string; subtitle?: string }>(), { title: '', subtitle: '' });
</script>

<template>
  <div class="card">
    <div v-if="title" class="mb-2">
      <h3 class="text-base font-bold">{{ title }}</h3>
      <p v-if="subtitle" class="text-xs text-galaxy-muted">{{ subtitle }}</p>
    </div>
    <slot />
  </div>
</template>
