/** 帧条目 store：条带选中、帧序数组、拍摄遍次、批量曝光、持久化 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, ExposurePass, FrameEntry } from '../types/frame';
import {
  applyFramePatch,
  createEmptyFrame,
  createEmptyPass,
  normalizeFrame,
  passesTotal,
  withPassSnapshots,
} from '../types/frame';

interface FrameState {
  frames: FrameEntry[];
  shotId: number | null;
  selectedFrameNo: number | null;
  dirty: boolean;
}

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    shotId: null,
    selectedFrameNo: null,
    dirty: false,
  }),
  getters: {
    count(state): number {
      return state.frames.length;
    },
    selected(state): FrameEntry | undefined {
      if (state.selectedFrameNo === null) return undefined;
      return state.frames.find((f) => f.frameNo === state.selectedFrameNo);
    },
    /** 全部帧的累计位移轨迹（mm） */
    offsets(state): number[] {
      return accumulateOffsets(state.frames.map((f) => f.propOffsetMm));
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return Math.round(state.frames.reduce((sum, f) => sum + 1 / (f.shotCount || 1), 0) * 100) / 100;
    },
    /** 当前镜头全部帧的拍摄合计张数（各遍次张数之和） */
    totalShotCount(state): number {
      return state.frames.reduce((sum, f) => sum + passesTotal(f.passes), 0);
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      this.frames = await api.listFrames(shotId);
      this.dirty = false;
      if (this.frames.length && !this.frames.some((f) => f.frameNo === this.selectedFrameNo)) {
        this.selectedFrameNo = this.frames[0].frameNo;
      }
    },
    select(frameNo: number | null) {
      this.selectedFrameNo = frameNo;
    },
    /** 整段帧序落库（脱代理后写入），帧序号按数组顺序重排 */
    async persist() {
      if (this.shotId === null) return;
      const ordered = this.frames.map((f, idx) =>
        withPassSnapshots({ ...f, frameNo: idx + 1, shotId: this.shotId as number }),
      );
      await api.replaceShotFrames(this.shotId, toPlain(ordered));
      this.frames = await api.listFrames(this.shotId);
      this.dirty = false;
    },
    async insertAt(index: number, seed?: Partial<FrameEntry>) {
      const base = createEmptyFrame(this.shotId ?? 0, index + 1);
      const anchor = this.frames[index - 1] ?? this.frames[0];
      let merged: FrameEntry = {
        ...base,
        ...(anchor
          ? {
              aperture: anchor.aperture,
              iso: anchor.iso,
              shutterAngle: anchor.shutterAngle,
              propOffsetMm: anchor.propOffsetMm,
              // 新帧默认先沿用锚点帧的首遍灯光/曝光/张数，作为唯一一遍（签发新 key）
              passes: [createEmptyPass({ ...anchor.passes[0], key: undefined })],
            }
          : {}),
        frameNo: index + 1,
        id: undefined,
      };
      // 模板里的扁平遍次字段（张数/曝光/灯光/备注）写入首遍后再重算合计
      merged = applyFramePatch(merged, seed ?? {});
      this.frames = [...this.frames.slice(0, index), merged, ...this.frames.slice(index)];
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async removeAt(index: number) {
      if (this.frames.length <= 1) return;
      this.frames = this.frames.filter((_, i) => i !== index);
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.frames = next.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    /**
     * 提交一帧改动：遍次字段（张数/曝光/灯光/备注）统一进首遍并立即重算合计，
     * 更新内存状态后按行落库，条带与明细的合计随即刷新。
     */
    async commitFrame(frameNo: number, next: FrameEntry) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const normalized = withPassSnapshots({ ...next, updatedAt: Date.now() });
      this.frames = this.frames.map((f, i) => (i === idx ? normalized : f));
      if (typeof normalized.id === 'number') {
        const { id, ...rest } = normalized;
        await api.updateFrame(id, toPlain(rest));
      }
    },
    /** 批量套用曝光参数：帧级光圈/ISO/快门角写入每帧，曝光时间写入每帧首遍 */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      this.frames = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return applyFramePatch(f, {
          exposureSec: batch.exposureSec,
          aperture: batch.aperture,
          iso: batch.iso,
          shutterAngle: batch.shutterAngle,
        });
      });
      await this.persist();
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量 / 遍次编辑都走这里） */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      await this.commitFrame(frameNo, applyFramePatch(this.frames[idx], patch));
    },
    /** 追加一遍：默认复制当前最后一遍的灯光与曝光参数，张数取 2，备注留空 */
    async addPass(frameNo: number) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return;
      const last = frame.passes[frame.passes.length - 1];
      const pass = createEmptyPass(
        last
          ? { lighting: last.lighting, exposureSec: last.exposureSec, shotCount: last.shotCount }
          : undefined,
      );
      pass.note = '';
      await this.commitFrame(frameNo, { ...frame, passes: [...frame.passes, pass] });
    },
    /**
     * 删除一遍：删到只剩一遍时保留这遍原有参数，
     * 即不会被重置成默认值，仅刷新帧级合计快照。
     */
    async removePass(frameNo: number, passKey: string) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame || frame.passes.length <= 1) return;
      const passes = frame.passes.filter((p) => p.key !== passKey);
      if (passes.length === frame.passes.length) return;
      await this.commitFrame(frameNo, { ...frame, passes });
    },
    /** 更新一遍的灯光 / 曝光时间 / 拍摄张数 / 备注，并立即重算合计 */
    async patchPass(frameNo: number, passKey: string, patch: Partial<ExposurePass>) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return;
      const passes = frame.passes.map((p) => (p.key === passKey ? createEmptyPass({ ...p, ...patch }) : p));
      await this.commitFrame(frameNo, { ...frame, passes });
    },
    /** 遍次上下换序（dir：-1 上移，1 下移） */
    async movePass(frameNo: number, passKey: string, dir: -1 | 1) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return;
      const from = frame.passes.findIndex((p) => p.key === passKey);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= frame.passes.length) return;
      const passes = frame.passes.slice();
      const [moved] = passes.splice(from, 1);
      passes.splice(to, 0, moved);
      await this.commitFrame(frameNo, { ...frame, passes });
    },
    /** 条带单帧颜色：按曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: frame.exposureSec });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },
    /** 防御性规范化（载入外部数据时兜底） */
    normalize(frames: FrameEntry[]): FrameEntry[] {
      return frames.map(normalizeFrame);
    },
  },
});
