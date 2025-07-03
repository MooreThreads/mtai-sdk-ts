<script lang="ts" setup>
import { ref, watch } from 'vue'
import type { DH2DSession } from 'mtai'
import DH2D from '../components/DH2D.vue'

const sessionRef = ref<DH2DSession | null>(null)
const status = ref('sleeping')
const botText = ref('')
const asrText = ref('')
const start = ref(false)
const videoId = ref('liruyun')

watch(status, (newStatus) => {
  if (newStatus !== 'talking') botText.value = ''
  if (newStatus !== 'listening') asrText.value = ''
})

const closeSession = () => {
  console.log("Stopping session...")
  console.log("Current sessionRef:", sessionRef.value)
  console.log("Session methods:", Object.keys(sessionRef.value || {}))
  if (sessionRef.value) {
    // 1. 发送sleep命令让数字人停止说话
    sessionRef.value.send({ type: 'sleep' })

    // 2. 立即更新状态为sleeping
    status.value = 'sleeping'

    // 3. 清空所有文本
    botText.value = ""
    asrText.value = ""
  }
}

const handleBotOutput = (text: string) => {
  // 限制最大长度为40个字符
  const newText = botText.value + text
  botText.value = newText.length > 40 ? newText.slice(-40) : newText
}

const videoOptions = [
  { value: 'liruyun', label: 'Liruyun' },
  { value: 'aigc_20250212', label: 'AIGC' }
]
</script>

<template>
  <div class="app-container">
    <div v-if="!start" class="center-button">
      <button
          class="start-button"
          @click="start = true"
      >
        Click to Start
      </button>
    </div>

    <DH2D
        v-if="start"
        ref="sessionRef"
        asrKey=" "
        :videoId="videoId"
        style="
        width: 100%;
        height: 100%;
        position: absolute;
        top: 0;
        left: 0;
      "
        @asrOutput="(text) => asrText = text"
        @botOutput="handleBotOutput"
        @statusChanged="(s) => status = s"
    />

    <div class="info-panel">
      <div class="character-select">
        <label for="videoId" style="margin-right: 10px; font-weight: 500;">选择角色:</label>
        <select
            id="videoId"
            v-model="videoId"
            class="select-box"
        >
          <option v-for="option in videoOptions" :value="option.value" :key="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <div class="status-info">
        <div><strong>状态:</strong> {{ status }}</div>
        <div><strong>回复内容:</strong> {{ botText }}</div>
        <div><strong>识别文本:</strong> {{ asrText }}</div>
      </div>

      <div class="control-buttons">
        <!-- 替换Wake Up按钮为提示信息 -->
        <div class="speak-instruction" style="margin-bottom: 10px;">
          <strong>操作提示:</strong> 请按住空格键说话
        </div>
        <button
            class="btn btn-danger"
            @click="closeSession"
            :disabled="!start"
            style="margin-left: 10px;"
        >
          结束会话
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 保持原有样式不变 */
.app-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
}

.center-button {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 10;
  text-align: center;
}

.start-button {
  padding: 15px 30px;
  font-size: 18px;
  background-color: green;
  color: white;
  border-radius: 5px;
  cursor: pointer;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease;
}

.start-button:hover {
  opacity: 0.9;
}

.info-panel {
  background-color: white;
  padding: 15px;
  border-radius: 5px;
  position: absolute;
  bottom: 50px;
  left: 1px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  font-size: 16px;
  z-index: 10;
}

.character-select {
  margin-bottom: 15px;
}

.select-box {
  padding: 8px 12px;
  border-radius: 5px;
  border: 1px solid #ccc;
  background-color: #f8f8f8;
  cursor: pointer;
}

.status-info {
  line-height: 1.5;
  margin-bottom: 10px;
}

.control-buttons {
  margin-top: 15px;
}

.speak-instruction {
  color: #333;
  font-size: 14px;
  padding: 8px;
  background-color: #f0f8ff;
  border-radius: 4px;
  margin-bottom: 10px;
}

.btn {
  padding: 8px 16px;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-weight: 500;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  transition: all 0.2s ease;
}

.btn-danger {
  background-color: #dc3545;
}

.btn:hover {
  opacity: 0.9;
}
</style>