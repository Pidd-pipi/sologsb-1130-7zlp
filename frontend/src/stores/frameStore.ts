/** 帧条目 store：条带选中、帧序数组、拍摄遍次、批量曝光、持久化 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, ExposurePass, FrameEntry } from '../types/frame';
import { createEmptyFrame, createEmptyPass, createPassUid, normalizeFrame, totalShotCount } from '../types/frame';

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
    /** 全部帧的合计拍摄张数（各遍张数之和） */
    totalShots(state): number {
      return state.frames.reduce((sum, f) => sum + totalShotCount(f.passes), 0);
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return (
        Math.round(
          state.frames.reduce((sum, f) => sum + 1 / Math.max(1, totalShotCount(f.passes)), 0) * 100,
        ) / 100
      );
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      this.frames = (await api.listFrames(shotId)).map(normalizeFrame);
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
      const ordered = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1, shotId: this.shotId as number }));
      await api.replaceShotFrames(this.shotId, toPlain(ordered));
      this.frames = await api.listFrames(this.shotId);
      this.dirty = false;
    },
    /** 由插入种子构造遍次：显式 passes 优先，其次旧版单套字段，最后继承锚点帧 */
    buildSeedPasses(seed: Partial<FrameEntry> | undefined, anchor: FrameEntry | undefined): ExposurePass[] {
      if (seed && Array.isArray(seed.passes) && seed.passes.length) {
        return seed.passes.map((p) => ({ ...p, uid: createPassUid() }));
      }
      if (seed && (seed.shotCount || seed.exposureSec || seed.lighting || seed.aperture || seed.iso)) {
        return [createEmptyPass(seed)];
      }
      if (anchor) {
        return anchor.passes.map((p) => ({ ...p, uid: createPassUid() }));
      }
      return [createEmptyPass()];
    },
    async insertAt(index: number, seed?: Partial<FrameEntry>) {
      const base = createEmptyFrame(this.shotId ?? 0, index + 1);
      const anchor = this.frames[index - 1] ?? this.frames[0];
      const passes = this.buildSeedPasses(seed, anchor);
      const propOffsetMm = seed?.propOffsetMm ?? anchor?.propOffsetMm ?? 0;
      const merged: FrameEntry = {
        ...base,
        ...seed,
        passes,
        propOffsetMm,
        frameNo: index + 1,
        id: undefined,
      };
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
    /** 批量套用曝光参数：逐遍覆盖曝光三要素与快门角，张数 / 灯光 / 备注不动 */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      this.frames = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return {
          ...f,
          passes: f.passes.map((p) => ({
            ...p,
            exposureSec: batch.exposureSec,
            aperture: batch.aperture,
            iso: batch.iso,
            shutterAngle: batch.shutterAngle,
          })),
          updatedAt: Date.now(),
        };
      });
      await this.persist();
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量） */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], ...patch, updatedAt: Date.now() };
      this.frames = this.frames.map((f, i) => (i === idx ? next : f));
      if (typeof next.id === 'number') {
        const { id, ...rest } = next;
        await api.updateFrame(id, toPlain(rest));
      }
    },
    /** 整组遍次落库（增删 / 换序 / 单遍编辑共用），帧条带与明细合计随即重算 */
    async patchPasses(frameNo: number, passes: ExposurePass[]) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], passes: passes.map((p) => ({ ...p })), updatedAt: Date.now() };
      this.frames = this.frames.map((f, i) => (i === idx ? next : f));
      if (typeof next.id === 'number') {
        await api.updateFrame(next.id, toPlain({ passes: next.passes }));
      }
    },
    /** 修改某一遍的灯光 / 曝光时间 / 张数 / 备注等 */
    async updatePass(frameNo: number, uid: string, patch: Partial<ExposurePass>) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return;
      const passes = frame.passes.map((p) => (p.uid === uid ? { ...p, ...patch } : p));
      await this.patchPasses(frameNo, passes);
    },
    /** 追加一遍拍摄：默认复制当前最后一遍的参数，便于换灯后微调 */
    async addPass(frameNo: number, seed?: Partial<ExposurePass>): Promise<ExposurePass | undefined> {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return undefined;
      const last = frame.passes[frame.passes.length - 1];
      const pass = createEmptyPass(seed ?? last);
      await this.patchPasses(frameNo, [...frame.passes, pass]);
      return pass;
    },
    /**
     * 删除一遍：删到只剩一遍时拒绝删除，
     * 保留这遍原有参数（灯光 / 曝光 / 张数 / 备注均不动）。
     */
    async removePass(frameNo: number, uid: string) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame || frame.passes.length <= 1) return;
      await this.patchPasses(
        frameNo,
        frame.passes.filter((p) => p.uid !== uid),
      );
    },
    /** 遍次上下换序（from / to 为遍次在数组中的下标） */
    async movePass(frameNo: number, from: number, to: number) {
      const frame = this.frames.find((f) => f.frameNo === frameNo);
      if (!frame) return;
      if (from === to || from < 0 || to < 0 || from >= frame.passes.length || to >= frame.passes.length) return;
      const passes = frame.passes.slice();
      const [moved] = passes.splice(from, 1);
      passes.splice(to, 0, moved);
      await this.patchPasses(frameNo, passes);
    },
    /** 条带单帧颜色：按首遍曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      const first = frame.passes[0];
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: first?.exposureSec ?? 0.25 });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },
  },
});
