<script setup lang="ts">
/**
 * 拍摄遍次编辑器：一个画面常分两遍拍摄（先背景、换灯后前景），
 * 每遍记录灯光、曝光时间、拍摄张数与备注；可增删遍次、上下换序。
 * 合计张数 = 各遍张数之和，任意一遍张数变化后立即重算。
 * 删除遍次到只剩一遍时，最后一遍不可删除，其原有参数保留。
 */
import { computed } from 'vue';
import type { ExposurePass, ShotCount } from '../../types/frame';
import { SHOT_COUNT_OPTIONS, totalShotCount } from '../../types/frame';
import { EXPOSURE_OPTIONS } from '../../utils/exposure';

interface Props {
  passes: ExposurePass[];
  frameNo: number;
  lightingOptions?: string[];
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  lightingOptions: () => ['主灯 + 柔光箱', '背景灯（低功率）', '双侧补光', '顶光 + 反光板', '单灯侧逆光'],
  compact: false,
});

const emit = defineEmits<{
  (e: 'update', uid: string, patch: Partial<ExposurePass>): void;
  (e: 'add'): void;
  (e: 'remove', uid: string): void;
  (e: 'move', from: number, to: number): void;
}>();

const shotCountOptions = SHOT_COUNT_OPTIONS;
const exposureOptions = EXPOSURE_OPTIONS;
const total = computed(() => totalShotCount(props.passes));

function patchOf(pass: ExposurePass, patch: Partial<ExposurePass>) {
  emit('update', pass.uid, patch);
}

function shotCountOf(pass: ExposurePass, raw: string) {
  const value = Number(raw);
  const shotCount = (shotCountOptions.includes(value as ShotCount) ? value : 1) as ShotCount;
  patchOf(pass, { shotCount });
}

function exposureOf(pass: ExposurePass, raw: string) {
  patchOf(pass, { exposureSec: Number(raw) });
}

function removeOf(pass: ExposurePass) {
  emit('remove', pass.uid);
}

function moveOf(index: number, dir: -1 | 1) {
  emit('move', index, index + dir);
}
</script>

<template>
  <div class="pass-list" :data-testid="`pass-list-${frameNo}`">
    <div class="pass-head">
      <span class="pass-title">拍摄遍次（{{ passes.length }} 遍）</span>
      <span class="pass-total" :data-testid="`pass-total-${frameNo}`">合计 {{ total }} 张</span>
      <button type="button" class="btn small" :data-testid="`pass-add-${frameNo}`" @click="emit('add')">增加一遍</button>
    </div>

    <div
      v-for="(pass, index) in passes"
      :key="pass.uid"
      class="pass-card"
      :data-testid="`pass-card-${frameNo}-${index}`"
    >
      <div class="pass-card-head">
        <span class="pass-no">第 {{ index + 1 }} 遍</span>
        <div class="pass-order">
          <button
            type="button"
            class="btn tiny"
            :disabled="index === 0"
            :data-testid="`pass-up-${frameNo}-${index}`"
            title="上移"
            @click="moveOf(index, -1)"
          >
            上移
          </button>
          <button
            type="button"
            class="btn tiny"
            :disabled="index === passes.length - 1"
            :data-testid="`pass-down-${frameNo}-${index}`"
            title="下移"
            @click="moveOf(index, 1)"
          >
            下移
          </button>
          <button
            type="button"
            class="btn tiny danger"
            :disabled="passes.length <= 1"
            :data-testid="`pass-remove-${frameNo}-${index}`"
            :title="passes.length <= 1 ? '至少保留一遍，参数保持不变' : '删除该遍'"
            @click="removeOf(pass)"
          >
            删除
          </button>
        </div>
      </div>

      <div class="pass-grid" :class="{ compact }">
        <label class="field">
          <span>灯光</span>
          <input
            list="pass-lighting-options"
            type="text"
            maxlength="30"
            :value="pass.lighting"
            :data-testid="`pass-lighting-${frameNo}-${index}`"
            @change="patchOf(pass, { lighting: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="field">
          <span>曝光时间（秒）</span>
          <select
            :value="pass.exposureSec"
            :data-testid="`pass-exposure-${frameNo}-${index}`"
            @change="exposureOf(pass, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in exposureOptions" :key="opt" :value="opt">{{ opt }} s</option>
          </select>
        </label>
        <label class="field">
          <span>拍摄张数</span>
          <select
            :value="pass.shotCount"
            :data-testid="`pass-shotcount-${frameNo}-${index}`"
            @change="shotCountOf(pass, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in shotCountOptions" :key="opt" :value="opt">{{ opt }} 张</option>
          </select>
        </label>
        <label class="field wide">
          <span>备注</span>
          <input
            type="text"
            maxlength="80"
            :value="pass.note"
            :data-testid="`pass-note-${frameNo}-${index}`"
            placeholder="如：先拍背景，换灯后再拍前景"
            @change="patchOf(pass, { note: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>
    </div>

    <datalist id="pass-lighting-options">
      <option v-for="opt in lightingOptions" :key="opt" :value="opt"></option>
    </datalist>
  </div>
</template>

<style scoped>
.pass-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pass-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pass-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2d3d;
}
.pass-total {
  margin-left: auto;
  font-size: 13px;
  font-weight: 700;
  color: #2f6fed;
}
.pass-card {
  border: 1px solid #e2e7ef;
  border-radius: 8px;
  padding: 10px;
  background: #fbfcfe;
}
.pass-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.pass-no {
  font-size: 12px;
  font-weight: 600;
  color: #5a6472;
}
.pass-order {
  display: flex;
  gap: 6px;
}
.pass-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 8px;
}
.pass-grid.compact {
  grid-template-columns: repeat(3, minmax(110px, 1fr));
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field.wide {
  grid-column: span 1;
}
.pass-grid:not(.compact) .field.wide {
  grid-column: span 1;
}
.field select,
.field input {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
  box-sizing: border-box;
  width: 100%;
}
.btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 12px;
}
.btn.small {
  height: 26px;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 900px) {
  .pass-grid,
  .pass-grid.compact {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }
}
</style>
