/** 单遍拍摄张数（定格动画常用 1/2/3 张） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/**
 * 拍摄遍次：定格动画同一画面常分两遍拍（先拍背景、换灯后再拍前景），
 * 每遍各自记录灯光、曝光时间、拍摄张数与备注。
 */
export interface ExposurePass {
  /** 帧内稳定标识，仅用于增删与上下换序的 key */
  key: string;
  /** 灯光配置 */
  lighting: string;
  /** 该遍曝光时间（秒） */
  exposureSec: number;
  /** 该遍拍摄张数 */
  shotCount: number;
  /** 备注 */
  note: string;
}

/** 帧条目：一帧的拍摄遍次、其余曝光参数、道具位移与实拍记录 */
export interface FrameEntry {
  id?: number;
  /** 帧序号，从 1 开始，随排序重排 */
  frameNo: number;
  /** 所属镜头 id */
  shotId: number;
  /** 拍摄合计张数 = 各遍次张数之和（随遍次增删/改数即时重算的快照） */
  shotCount: number;
  /** 曝光时间（秒）：首遍快照，便于旧逻辑与条带着色直接读取 */
  exposureSec: number;
  /** 光圈 f 值（帧级，各遍共用） */
  aperture: number;
  /** 感光度（帧级，各遍共用） */
  iso: number;
  /** 快门角度（度，帧级） */
  shutterAngle: number;
  /** 灯光配置：首遍快照 */
  lighting: string;
  /** 道具位移量（mm） */
  propOffsetMm: number;
  /** 备注：首遍快照 */
  note: string;
  /** 拍摄遍次（至少 1 遍），顺序即拍摄顺序 */
  passes: ExposurePass[];
  updatedAt: number;
}

let passSeq = 0;

/** 生成帧内唯一的遍次 key */
export function nextPassKey(): string {
  passSeq += 1;
  return `pass-${Date.now().toString(36)}-${passSeq.toString(36)}`;
}

/** 单遍张数限制在 1 ~ 99 的整数 */
export function clampShotCount(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(99, n);
}

/** 构造一遍拍摄参数；seed 里没有 key 时签发新 key（跨帧复制遍次不会撞 key） */
export function createEmptyPass(seed?: Partial<ExposurePass>): ExposurePass {
  return {
    key: seed?.key ? seed.key : nextPassKey(),
    lighting: typeof seed?.lighting === 'string' && seed.lighting ? seed.lighting : '主灯 + 柔光箱',
    exposureSec: typeof seed?.exposureSec === 'number' && seed.exposureSec > 0 ? seed.exposureSec : 0.25,
    shotCount: clampShotCount(seed?.shotCount ?? 2),
    note: typeof seed?.note === 'string' ? seed.note : '',
  };
}

/** 一帧各遍次张数合计 */
export function passesTotal(passes: readonly ExposurePass[] | null | undefined): number {
  if (!Array.isArray(passes) || !passes.length) return 0;
  return passes.reduce((sum, p) => sum + clampShotCount(p.shotCount), 0);
}

/** 由旧帧的扁平字段生成唯一一遍（兼容 v3 及更早数据） */
export function passFromFrame(frame: {
  lighting?: unknown;
  exposureSec?: unknown;
  shotCount?: unknown;
  note?: unknown;
}): ExposurePass {
  return createEmptyPass({
    key: `legacy-${nextPassKey()}`,
    lighting: typeof frame.lighting === 'string' ? frame.lighting : '主灯 + 柔光箱',
    exposureSec: typeof frame.exposureSec === 'number' ? frame.exposureSec : 0.25,
    shotCount: clampShotCount(frame.shotCount ?? 2),
    note: typeof frame.note === 'string' ? frame.note : '',
  });
}

function normalizePasses(raw: unknown): ExposurePass[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) =>
      createEmptyPass({
        key: typeof p.key === 'string' ? p.key : undefined,
        lighting: typeof p.lighting === 'string' ? p.lighting : undefined,
        exposureSec: typeof p.exposureSec === 'number' ? p.exposureSec : undefined,
        shotCount: typeof p.shotCount === 'number' ? p.shotCount : undefined,
        note: typeof p.note === 'string' ? p.note : undefined,
      }),
    );
}

/**
 * 以遍次数组为唯一事实来源，回写帧级合计张数与首遍快照字段
 * （shotCount / exposureSec / lighting / note 始终派生自 passes）。
 */
export function withPassSnapshots<T extends FrameEntry>(frame: T): T {
  const passes = normalizePasses(frame.passes);
  const safe = passes.length ? passes : [createEmptyPass()];
  const first = safe[0];
  return {
    ...frame,
    passes: safe,
    shotCount: passesTotal(safe),
    exposureSec: first.exposureSec,
    lighting: first.lighting,
    note: first.note,
  };
}

/** 读入一行帧数据：补齐缺失的遍次（旧镜头数据迁移到至少一遍）并校正合计 */
export function normalizeFrame(frame: FrameEntry): FrameEntry {
  const passes = normalizePasses(frame.passes);
  return withPassSnapshots({ ...frame, passes: passes.length ? passes : [passFromFrame(frame)] });
}

const PASS_OWNED_KEYS = ['shotCount', 'exposureSec', 'lighting', 'note'] as const;

/**
 * 应用一帧的局部改动：
 * - shotCount / exposureSec / lighting / note 属于遍次字段，写入首遍后重算合计；
 * - passes 整体替换时逐遍规范化并签发缺失 key；
 * - 其余字段（光圈 / ISO / 快门角 / 位移等）直接落在帧上。
 */
export function applyFramePatch(frame: FrameEntry, patch: Partial<FrameEntry>): FrameEntry {
  const next: FrameEntry = { ...frame };
  if (Array.isArray(patch.passes)) {
    next.passes = normalizePasses(patch.passes);
  }
  const touched = PASS_OWNED_KEYS.filter((k) => k in patch);
  if (touched.length) {
    const passes = normalizePasses(next.passes);
    const safe = passes.length ? passes : [passFromFrame(next)];
    const first = { ...safe[0] };
    for (const key of touched) {
      (first as unknown as Record<string, unknown>)[key] = patch[key];
    }
    first.shotCount = clampShotCount(first.shotCount);
    if (!(first.exposureSec > 0)) first.exposureSec = 0.25;
    if (typeof first.lighting !== 'string') first.lighting = '';
    if (typeof first.note !== 'string') first.note = '';
    safe[0] = first;
    next.passes = safe;
  }
  for (const key of Object.keys(patch) as (keyof FrameEntry)[]) {
    if (key === 'passes' || (PASS_OWNED_KEYS as readonly string[]).includes(key)) continue;
    (next as unknown as Record<string, unknown>)[key] = patch[key];
  }
  return withPassSnapshots(next);
}

export const createEmptyFrame = (shotId: number, frameNo: number): FrameEntry =>
  withPassSnapshots({
    frameNo,
    shotId,
    shotCount: 2,
    exposureSec: 0.25,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '主灯 + 柔光箱',
    propOffsetMm: 0,
    note: '',
    passes: [createEmptyPass({ lighting: '主灯 + 柔光箱', exposureSec: 0.25, shotCount: 2 })],
    updatedAt: Date.now(),
  });

/** 批量曝光设置（供 /frames 编排台使用），作用于帧级参数与首遍曝光时间 */
export interface BatchExposure {
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
}
