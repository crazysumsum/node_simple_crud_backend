<script setup>
import { onMounted, ref } from "vue";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const health = ref(null);
const loading = ref(false);
const error = ref("");

async function loadHealth() {
  loading.value = true;
  error.value = "";

  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/health`);

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const responseBody = await response.json();
    health.value = responseBody.data;
  } catch (requestError) {
    health.value = null;
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadHealth);
</script>

<template>
  <main class="shell">
    <section class="workspace">
      <div class="intro">
        <p class="eyebrow">ERP Development Environment</p>
        <h1>Node.js + MySQL + Vue 3</h1>
        <p>
          前後端專案已經分離，後端提供 Express API，前端使用 Vue 3 與 Vite。
        </p>
      </div>

      <div class="status-panel">
        <div class="panel-header">
          <h2>系統狀態</h2>
          <button type="button" @click="loadHealth" :disabled="loading">
            {{ loading ? "檢查中" : "重新檢查" }}
          </button>
        </div>

        <dl v-if="health" class="status-grid">
          <div>
            <dt>API</dt>
            <dd>{{ health.status }}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{{ health.database }}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{{ health.timestamp }}</dd>
          </div>
        </dl>

        <p v-else-if="error" class="error">
          無法連線 API：{{ error }}
        </p>

        <p v-else class="muted">等待檢查結果...</p>
      </div>
    </section>
  </main>
</template>
