<script setup lang="ts">
/**
 * 拍摄遍次编辑器：一帧可分多遍拍摄（先背景、换灯后前景），
 * 每遍记录灯光、曝光时间、拍摄张数与备注，支持新增 / 删除 / 上下换序。
 * 改动通过事件抛出，合计张数由 passes 即时派生（帧条带与明细随之重算）。
 */
import { computed } from 'vue';
import type { ExposurePass } from '../../types/frame';
import { EXPOSURE_OPTIONS } from '../../utils/exposure';

interface Props {
  passes: ExposurePass[];
  frameNo: number;
  disabled?: boolean;
  lightingOptions?: string[];
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  lightingOptions: () => ['主灯 + 柔光箱', '双侧补光', '顶光 + 反光板', '单灯侧逆光'],
});

const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'remove', passKey: string): void;
  (e: 'move', passKey: string, dir: -1 | 1): void;
  (e: 'patch', passKey: string, patch: Partial<ExposurePass>): void;
}>();

/** 合计张数：某遍张数变化后立即重算 */
const total = computed(() => props.passes.reduce((sum, p) => sum + (Number(p.shotCount) || 0), 0));

/** 灯光下拉在默认预设之外，补上已有遍次里出现过的自定义灯光 */
const lightingChoices = computed(() => {
  const set = new Set<string>(props.lightingOptions);
  for (const p of props.passes) {
    if (p.lighting) set.add(p.lighting);
  }
  return [...set];
});

/** 曝光时间在标准档位之外，补上各遍已用的非标准值（旧数据迁移值可正常显示） */
function exposureChoices(pass: ExposurePass): number[] {
  return EXPOSURE_OPTIONS.includes(pass.exposureSec) ? EXPOSURE_OPTIONS : [pass.exposureSec, ...EXPOSURE_OPTIONS];
}

function edit(pass: ExposurePass, field: keyof ExposurePass, raw: string | number) {
  if (field === 'shotCount' || field === 'exposureSec') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    emit('patch', pass.key, { [field]: n } as Partial<ExposurePass>);
    return;
  }
  emit('patch', pass.key, { [field]: String(raw) } as Partial<ExposurePass>);
}
</script>

<template>
  <div class="pass-editor" data-testid="pass-editor">
    <div v-for="(pass, index) in passes" :key="pass.key" class="pass-card" :data-testid="`pass-card-${frameNo}-${index}`">
      <div class="pass-head">
        <span class="pass-no" :data-testid="`pass-index-${frameNo}-${index}`">第 {{ index + 1 }} 遍</span>
        <span class="pass-sum">{{ pass.shotCount }} 张</span>
        <div class="pass-order">
          <button
            type="button"
            class="btn tiny"
            :disabled="disabled || index === 0"
            :data-testid="`pass-up-${frameNo}-${index}`"
            title="上移本遍"
            @click="emit('move', pass.key, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            class="btn tiny"
            :disabled="disabled || index === passes.length - 1"
            :data-testid="`pass-down-${frameNo}-${index}`"
            title="下移本遍"
            @click="emit('move', pass.key, 1)"
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          class="btn tiny danger"
          :disabled="disabled || passes.length <= 1"
          :data-testid="`pass-remove-${frameNo}-${index}`"
          :title="passes.length <= 1 ? '至少保留一遍' : '删除本遍'"
          @click="emit('remove', pass.key)"
        >
          删除
        </button>
      </div>
      <div class="pass-grid">
        <label class="field">
          <span>灯光</span>
          <select
            :value="pass.lighting"
            :disabled="disabled"
            :data-testid="`pass-lighting-${frameNo}-${index}`"
            @change="edit(pass, 'lighting', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in lightingChoices" :key="opt" :value="opt">{{ opt }}</option>
          </select>
        </label>
        <label class="field">
          <span>曝光时间 s</span>
          <select
            :value="pass.exposureSec"
            :disabled="disabled"
            :data-testid="`pass-exposure-${frameNo}-${index}`"
            @change="edit(pass, 'exposureSec', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="opt in exposureChoices(pass)" :key="opt" :value="opt">{{ opt }} s</option>
          </select>
        </label>
        <label class="field">
          <span>拍摄张数</span>
          <input
            type="number"
            min="1"
            max="99"
            step="1"
            :value="pass.shotCount"
            :disabled="disabled"
            :data-testid="`pass-shotcount-${frameNo}-${index}`"
            @change="edit(pass, 'shotCount', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field wide">
          <span>备注</span>
          <input
            type="text"
            maxlength="80"
            :value="pass.note"
            :disabled="disabled"
            placeholder="如：背景层 / 换灯拍前景"
            :data-testid="`pass-note-${frameNo}-${index}`"
            @change="edit(pass, 'note', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>

    <div class="pass-foot">
      <button type="button" class="btn small primary" :disabled="disabled" data-testid="pass-add" @click="emit('add')">
        ＋ 增加一遍
      </button>
      <span class="pass-total" data-testid="pass-total">
        共 {{ passes.length }} 遍 · 合计 <strong>{{ total }}</strong> 张
      </span>
    </div>
  </div>
</template>

<style scoped>
.pass-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pass-card {
  border: 1px solid #dbe2ec;
  border-radius: 8px;
  padding: 8px 10px;
  background: #fbfcfe;
}
.pass-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.pass-no {
  font-size: 13px;
  font-weight: 600;
  color: #1f2d3d;
}
.pass-sum {
  font-size: 12px;
  color: #5a6472;
}
.pass-order {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.pass-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field.wide {
  grid-column: span 2;
}
.field input,
.field select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.pass-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pass-total {
  font-size: 12px;
  color: #5a6472;
}
.pass-total strong {
  color: #1f2d3d;
  font-size: 14px;
}
.btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.tiny {
  height: 24px;
  padding: 0 7px;
  font-size: 12px;
  line-height: 1;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
