/** 单遍拍摄张数（定格动画常用 1/2/3 张） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/**
 * 拍摄遍次：一个画面常分两遍拍摄（先拍背景、换灯后再拍前景），
 * 每遍单独记录灯光、曝光时间、拍摄张数与备注。
 */
export interface ExposurePass {
  /** 遍次在帧内的稳定标识（换序 / 增删时不随序号变化） */
  uid: string;
  /** 本遍灯光配置 */
  lighting: string;
  /** 本遍曝光时间（秒） */
  exposureSec: number;
  /** 本遍拍摄张数 */
  shotCount: ShotCount;
  /** 本遍备注 */
  note: string;
  /** 光圈 f 值（沿用旧曝光参数，便于逐遍细调） */
  aperture: number;
  /** 感光度 */
  iso: number;
  /** 快门角度（度） */
  shutterAngle: number;
}

/** 遍次表单草稿（ExposureForm 绑定用，不含 uid） */
export type PassDraft = Omit<ExposurePass, 'uid'>;

let passSeq = 0;

/** 生成帧内唯一的遍次 id */
export function createPassUid(): string {
  passSeq += 1;
  return `pass-${Date.now().toString(36)}-${passSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 新建一遍的默认参数（灯光 / 曝光 / 张数 / 备注） */
export function createEmptyPass(seed: Partial<ExposurePass> = {}): ExposurePass {
  return {
    uid: createPassUid(),
    lighting: seed.lighting ?? '主灯 + 柔光箱',
    exposureSec: seed.exposureSec ?? 0.25,
    shotCount: seed.shotCount ?? 2,
    note: seed.note ?? '',
    aperture: seed.aperture ?? 5.6,
    iso: seed.iso ?? 200,
    shutterAngle: seed.shutterAngle ?? 180,
  };
}

/** 一帧的合计拍摄张数 = 各遍张数之和 */
export function totalShotCount(passes: Pick<ExposurePass, 'shotCount'>[] | undefined | null): number {
  if (!Array.isArray(passes) || !passes.length) return 0;
  return passes.reduce((sum, p) => sum + (Number(p.shotCount) || 0), 0);
}

/** 帧条目：一帧的拍摄遍次、道具位移与实拍记录 */
export interface FrameEntry {
  id?: number;
  /** 帧序号，从 1 开始，随排序重排 */
  frameNo: number;
  /** 所属镜头 id */
  shotId: number;
  /** 拍摄遍次（有序，数组顺序即拍摄先后） */
  passes: ExposurePass[];
  /** 道具位移量（mm） */
  propOffsetMm: number;
  updatedAt: number;

  /* ---- 旧版单套曝光字段：仅用于读取 v3 及更早数据，写入一律走 passes ---- */
  /** @deprecated 使用 passes[0].shotCount 与 totalShotCount */
  shotCount?: ShotCount;
  /** @deprecated 使用 passes[*].exposureSec */
  exposureSec?: number;
  /** @deprecated 使用 passes[*].aperture */
  aperture?: number;
  /** @deprecated 使用 passes[*].iso */
  iso?: number;
  /** @deprecated 使用 passes[*].shutterAngle */
  shutterAngle?: number;
  /** @deprecated 使用 passes[*].lighting */
  lighting?: string;
  /** @deprecated 使用 passes[*].note */
  note?: string;
}

/**
 * 读取归一化：旧库里的帧没有 passes，按原单套曝光参数补成一遍，
 * 保证旧镜头已存的一遍参数照常打开。返回新对象，不改入参。
 */
export function normalizeFrame(frame: FrameEntry): FrameEntry {
  if (Array.isArray(frame.passes) && frame.passes.length > 0) return frame;
  const legacy: Partial<ExposurePass> = {
    shotCount: frame.shotCount,
    exposureSec: frame.exposureSec,
    aperture: frame.aperture,
    iso: frame.iso,
    shutterAngle: frame.shutterAngle,
    lighting: frame.lighting,
    note: frame.note,
  };
  return { ...frame, passes: [createEmptyPass(legacy)] };
}

/** 取帧的遍次数组（旧数据缺字段时即时补一遍，不落库） */
export function framePasses(frame: FrameEntry): ExposurePass[] {
  return normalizeFrame(frame).passes;
}

export const createEmptyFrame = (shotId: number, frameNo: number): FrameEntry => ({
  frameNo,
  shotId,
  passes: [createEmptyPass()],
  propOffsetMm: 0,
  updatedAt: Date.now(),
});

/** 由遍次表单草稿生成一个帧条目（新建镜头 / 插入帧使用） */
export function createFrameFromDraft(
  shotId: number,
  frameNo: number,
  draft: Partial<PassDraft>,
  propOffsetMm = 0,
): FrameEntry {
  return {
    frameNo,
    shotId,
    passes: [createEmptyPass(draft)],
    propOffsetMm,
    updatedAt: Date.now(),
  };
}

/** 批量曝光设置（供 /frames 编排台使用），逐遍套用曝光三要素 */
export interface BatchExposure {
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
}
