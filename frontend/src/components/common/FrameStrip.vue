<script setup lang="ts">
/**
 * 帧序横向条带：按首遍曝光时间 / 道具位移量着色，支持点击选中与拖拽换序。
 * 选中帧后可在条带内就地调整道具位移，并通过遍次编辑器增删拍摄遍次、
 * 修改每遍灯光 / 曝光时间 / 张数 / 备注、上下换序；合计张数即时重算。
 * 仅渲染色块与文字标注，不涉及任何图像处理与成片输出。
 */
import { computed, ref } from 'vue';
import type { ExposurePass, FrameEntry } from '../../types/frame';
import { totalShotCount } from '../../types/frame';
import { frameColor, type FrameColorInput } from '../../utils/frameMath';
import PassList from './PassList.vue';

interface Props {
  frames: FrameEntry[];
  selected?: number | null;
  readonly?: boolean;
  colorBy?: 'offset' | 'exposure';
}

const props = withDefaults(defineProps<Props>(), {
  selected: null,
  readonly: false,
  colorBy: 'offset',
});

const emit = defineEmits<{
  (e: 'update:selected', frameNo: number | null): void;
  (e: 'reorder', from: number, to: number): void;
  (e: 'patch', frameNo: number, patch: Partial<FrameEntry>): void;
  (e: 'pass-update', frameNo: number, uid: string, patch: Partial<ExposurePass>): void;
  (e: 'pass-add', frameNo: number): void;
  (e: 'pass-remove', frameNo: number, uid: string): void;
  (e: 'pass-move', frameNo: number, from: number, to: number): void;
}>();

const dragFrom = ref<number | null>(null);

function firstExposure(frame: FrameEntry): number {
  return frame.passes[0]?.exposureSec ?? 0.25;
}

function colorOf(frame: FrameEntry): string {
  const input: FrameColorInput = {
    propOffsetMm: props.colorBy === 'offset' ? frame.propOffsetMm : 0,
    exposureSec: props.colorBy === 'exposure' ? firstExposure(frame) : 0.25,
  };
  return frameColor(input);
}

function passesTitle(frame: FrameEntry): string {
  const detail = frame.passes
    .map((p, i) => `第${i + 1}遍 ${p.lighting} ${p.exposureSec}s ×${p.shotCount}张`)
    .join('；');
  return `第 ${frame.frameNo} 帧 · 共 ${frame.passes.length} 遍合计 ${totalShotCount(frame.passes)} 张 · 位移 ${frame.propOffsetMm}mm · ${detail}`;
}

function onSelect(frameNo: number) {
  emit('update:selected', props.selected === frameNo ? null : frameNo);
}

function onDragStart(index: number, ev: DragEvent) {
  if (props.readonly) return;
  dragFrom.value = index;
  ev.dataTransfer?.setData('text/plain', String(index));
}

function onDrop(index: number) {
  if (props.readonly) return;
  const from = dragFrom.value;
  dragFrom.value = null;
  if (from === null || from === index) return;
  emit('reorder', from, index);
}

function patchSelected(patch: Partial<FrameEntry>) {
  if (props.selected === null || props.selected === undefined) return;
  emit('patch', props.selected, patch);
}

function emitPassUpdate(uid: string, patch: Partial<ExposurePass>) {
  if (selectedFrame.value) emit('pass-update', selectedFrame.value.frameNo, uid, patch);
}

function emitPassAdd() {
  if (selectedFrame.value) emit('pass-add', selectedFrame.value.frameNo);
}

function emitPassRemove(uid: string) {
  if (selectedFrame.value) emit('pass-remove', selectedFrame.value.frameNo, uid);
}

function emitPassMove(from: number, to: number) {
  if (selectedFrame.value) emit('pass-move', selectedFrame.value.frameNo, from, to);
}

const selectedFrame = computed(() => props.frames.find((f) => f.frameNo === props.selected) ?? null);

const totalOffset = computed(() =>
  Math.round(props.frames.reduce((sum, f) => sum + (f.propOffsetMm || 0), 0) * 100) / 100,
);

const stripTotalShots = computed(() => props.frames.reduce((sum, f) => sum + totalShotCount(f.passes), 0));
</script>

<template>
  <div class="frame-strip" data-testid="frame-strip">
    <div class="strip-meta">
      <span>帧序条带：{{ frames.length }} 帧</span>
      <span data-testid="strip-total-shots">合计拍摄 {{ stripTotalShots }} 张</span>
      <span>位移合计 {{ totalOffset }} mm</span>
      <span v-if="!readonly" class="hint">点击选中 · 拖拽换序</span>
    </div>

    <div class="strip-track">
      <div
        v-for="(frame, index) in frames"
        :key="frame.frameNo"
        class="strip-cell"
        :class="{ active: frame.frameNo === selected, readonly }"
        :style="{ background: colorOf(frame) }"
        :draggable="!readonly"
        :data-testid="`strip-cell-${frame.frameNo}`"
        :title="passesTitle(frame)"
        @click="onSelect(frame.frameNo)"
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <span class="cell-no">{{ frame.frameNo }}</span>
        <span class="cell-sub" :data-testid="`strip-shots-${frame.frameNo}`">{{ totalShotCount(frame.passes) }}张/{{ frame.passes.length }}遍</span>
        <span class="cell-sub">{{ frame.propOffsetMm }}mm</span>
      </div>
      <div v-if="!frames.length" class="strip-empty">当前镜头还没有帧条目，请先插入一帧</div>
    </div>

    <div v-if="selectedFrame && !readonly" class="strip-editor" data-testid="strip-editor">
      <div class="editor-title">
        第 {{ selectedFrame.frameNo }} 帧参数 · 共 {{ selectedFrame.passes.length }} 遍，
        合计 {{ totalShotCount(selectedFrame.passes) }} 张
      </div>
      <div class="editor-grid">
        <label class="field">
          <span>道具位移 mm</span>
          <input
            type="number"
            min="-200"
            max="200"
            step="0.5"
            :value="selectedFrame.propOffsetMm"
            :data-testid="`strip-offset-${selectedFrame.frameNo}`"
            @change="patchSelected({ propOffsetMm: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>
      <div class="editor-passes">
        <PassList
          :passes="selectedFrame.passes"
          :frame-no="selectedFrame.frameNo"
          compact
          @update="emitPassUpdate"
          @add="emitPassAdd"
          @remove="emitPassRemove"
          @move="emitPassMove"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame-strip {
  border: 1px solid #d8dee9;
  border-radius: 10px;
  padding: 12px;
  background: #fbfcfe;
}
.strip-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #5a6472;
  margin-bottom: 10px;
}
.strip-meta .hint {
  color: #8a94a6;
}
.strip-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.strip-cell {
  min-width: 60px;
  height: 74px;
  border-radius: 8px;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  border: 2px solid transparent;
  flex: 0 0 auto;
  transition: transform 0.12s ease;
}
.strip-cell:hover {
  transform: translateY(-2px);
}
.strip-cell.active {
  border-color: #1f2d3d;
  box-shadow: 0 0 0 2px rgba(31, 45, 61, 0.18);
}
.strip-cell.readonly {
  cursor: default;
}
.cell-no {
  font-weight: 700;
  font-size: 14px;
}
.cell-sub {
  font-size: 11px;
  opacity: 0.92;
}
.strip-empty {
  color: #8a94a6;
  font-size: 13px;
  padding: 18px 4px;
}
.strip-editor {
  margin-top: 12px;
  border-top: 1px dashed #d8dee9;
  padding-top: 10px;
}
.editor-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.editor-passes {
  margin-top: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
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
</style>
