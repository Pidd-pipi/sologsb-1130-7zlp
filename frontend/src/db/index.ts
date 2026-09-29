/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 帧条目由单套曝光改为有序拍摄遍次 passes，旧帧按原参数回填为一遍
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { ExposurePass, FrameEntry } from '../types/frame';
import { createPassUid } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/**
 * v4 升级用：把旧版单套曝光字段迁成一遍拍摄遍次。
 * 旧镜头里已存的那一遍参数（灯光 / 曝光时间 / 张数 / 备注等）原样保留。
 */
export function migrateLegacyPasses(row: Record<string, unknown>): ExposurePass[] {
  const legacy = Array.isArray(row.passes) ? (row.passes as ExposurePass[]) : [];
  if (legacy.length) return legacy;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  return [
    {
      uid: createPassUid(),
      lighting: str(row.lighting, '主灯 + 柔光箱'),
      exposureSec: num(row.exposureSec, 0.25),
      shotCount: (num(row.shotCount, 2) as ExposurePass['shotCount']) || 2,
      note: str(row.note, ''),
      aperture: num(row.aperture, 5.6),
      iso: num(row.iso, 200),
      shutterAngle: num(row.shutterAngle, 180),
    },
  ];
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v4：旧帧的单套曝光参数迁成有序的拍摄遍次（至少一遍，原参数保留）
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!Array.isArray(row.passes) || row.passes.length === 0) {
              row.passes = migrateLegacyPasses(row);
            }
          });
      });
  }
}

export const db = new StopMotionDb();
