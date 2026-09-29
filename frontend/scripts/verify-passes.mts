/**
 * 遍次功能端到端逻辑验证（不走浏览器，用 fake-indexeddb 跑真实 Dexie）：
 * 1. 先以 v3 结构写入旧镜头 + 旧帧（无 passes，单套曝光字段）
 * 2. 打开 v4 db，验证升级迁移把旧帧回填成一遍、原参数保留
 * 3. 用 frameStore 增/改/删遍次、上下换序，验证合计张数与落库
 * 4. 模拟切换镜头 / 重新打开页面（重新 loadForShot），验证顺序与合计持久化
 * 5. 删除到只剩一遍，验证最后一遍参数保留且无法再删
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { setActivePinia, createPinia } from 'pinia';

import { db, DB_NAME, StopMotionDb } from '../src/db/index';
import * as api from '../src/db/api';
import { useFrameStore } from '../src/stores/frameStore';
import { totalShotCount } from '../src/types/frame';
import type { Shot } from '../src/types/shot';
import type { FrameEntry } from '../src/types/frame';

async function resetDb() {
  db.close();
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });
}

/** 用 v3 结构直接建库并写入旧数据（绕过 v4 的 db 定义） */
async function seedV3() {
  const v3 = new Dexie(DB_NAME);
  v3.version(1).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
  });
  v3.version(2).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
  });
  v3.version(3).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
    takes: '++id, shotId, date, shotCode',
  });
  await v3.open();
  const shotId = await (v3.table('shots') as unknown as { add: (s: Partial<Shot>) => Promise<number> }).add({
    code: 'S01',
    sceneName: '旧镜头',
    fps: 24,
    durationSec: 2,
    startFrame: 1,
    endFrame: 48,
    status: '未开机',
    owner: '',
    progressPercent: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  await (v3.table('frames') as unknown as { add: (f: Partial<FrameEntry>) => Promise<number> }).add({
    frameNo: 1,
    shotId,
    shotCount: 3,
    exposureSec: 0.5,
    aperture: 8,
    iso: 400,
    shutterAngle: 144,
    lighting: '单侧逆光（旧）',
    propOffsetMm: 5,
    note: '旧备注',
    updatedAt: 2,
  });
  v3.close();
  return shotId;
}

async function run() {
  await resetDb();
  const oldShotId = await seedV3();

  // 重新用 v4 定义打开 → 触发 v3→v4 升级
  const reopened = new StopMotionDb();
  const legacy = await reopened.frames.where('shotId').equals(oldShotId).toArray();
  assert.equal(legacy.length, 1, '旧镜头应有 1 帧');
  assert.ok(Array.isArray(legacy[0].passes) && legacy[0].passes.length === 1, 'v4 升级后旧帧应有 1 遍');
  const migratedPass = legacy[0].passes[0];
  assert.equal(migratedPass.shotCount, 3, '旧帧那一遍张数应保留');
  assert.equal(migratedPass.exposureSec, 0.5, '旧帧那一遍曝光时间应保留');
  assert.equal(migratedPass.lighting, '单侧逆光（旧）', '旧帧那一遍灯光应保留');
  assert.equal(migratedPass.note, '旧备注', '旧帧那一遍备注应保留');
  assert.equal(migratedPass.aperture, 8);
  assert.equal(migratedPass.iso, 400);
  assert.equal(migratedPass.shutterAngle, 144);
  assert.ok(typeof migratedPass.uid === 'string' && migratedPass.uid.length > 0, '迁移生成 uid');
  assert.equal(totalShotCount(legacy[0].passes), 3, '旧帧合计 3 张');
  reopened.close();

  // ---- store 行为验证（api 层读取归一化）----
  await api.initDb();
  setActivePinia(createPinia());
  const store = useFrameStore();
  await store.loadForShot(oldShotId);
  assert.equal(store.frames.length, 1);
  assert.equal(store.totalShots, 3, 'store 合计 3 张');

  const frameNo = 1;
  const originalUid = store.frames[0].passes[0].uid;
  const originalLighting = store.frames[0].passes[0].lighting;

  // 增加一遍（默认复制上一遍）
  const second = await store.addPass(frameNo);
  assert.ok(second, '应返回新遍');
  assert.equal(store.frames[0].passes.length, 2, '应有 2 遍');
  assert.equal(totalShotCount(store.frames[0].passes), 6, '复制后合计 3+3=6 张');
  assert.equal(store.frames[0].passes[1].lighting, originalLighting, '新遍默认复制最后一遍灯光');

  // 改第二遍：换灯拍前景、曝光 1s、1 张、带备注
  await store.updatePass(frameNo, second!.uid, {
    lighting: '前景聚光灯',
    exposureSec: 1,
    shotCount: 1,
    note: '换灯拍前景',
  });
  assert.equal(totalShotCount(store.frames[0].passes), 4, '改张数后合计应立即为 3+1=4');
  assert.equal(store.totalShots, 4, '条带合计（store getter）应同步为 4');

  // 再加一遍，张数 2
  const third = await store.addPass(frameNo);
  await store.updatePass(frameNo, third!.uid, { shotCount: 2 });
  assert.equal(totalShotCount(store.frames[0].passes), 6, '三遍合计 3+1+2=6');

  // 上下换序：把第三遍移到最前
  const orderBefore = store.frames[0].passes.map((p) => p.uid);
  await store.movePass(frameNo, 2, 0);
  const orderAfter = store.frames[0].passes.map((p) => p.uid);
  assert.deepEqual(orderAfter, [orderBefore[2], orderBefore[0], orderBefore[1]], '遍次顺序应为 3,1,2');
  assert.equal(totalShotCount(store.frames[0].passes), 6, '换序不影响合计 6');

  // 边界：越界换序应被忽略
  await store.movePass(frameNo, 0, 5);
  assert.deepEqual(store.frames[0].passes.map((p) => p.uid), orderAfter, '越界换序被忽略');

  // ---- 模拟关掉页面再回来 / 切换镜头：重新 load ----
  const store2 = useFrameStore();
  await store2.loadForShot(oldShotId);
  const reloaded = store2.frames[0];
  assert.deepEqual(
    reloaded.passes.map((p) => p.uid),
    [orderBefore[2], orderBefore[0], orderBefore[1]],
    '重新打开后遍次顺序保持 3,1,2',
  );
  assert.equal(totalShotCount(reloaded.passes), 6, '重新打开后合计仍为 6');
  assert.equal(reloaded.passes[0].shotCount, 2, '换到最前的是原第三遍（2 张）');
  assert.equal(reloaded.passes[1].note, '旧备注', '原第一遍参数保留');
  assert.equal(reloaded.passes[2].note, '换灯拍前景', '原第二遍参数保留');
  assert.equal(reloaded.frameNo, 1, '所在帧仍为第 1 帧');

  // ---- 删到只剩一遍：3 遍可删到 1 遍，第 4 次删除（删最后一遍）必须被拦截 ----
  await store2.removePass(frameNo, reloaded.passes[0].uid);
  assert.equal(store2.frames[0].passes.length, 2, '删掉一遍后剩 2 遍');
  await store2.removePass(frameNo, store2.frames[0].passes[1].uid);
  assert.equal(store2.frames[0].passes.length, 1, '再删一遍后剩 1 遍');
  const survivorBefore = { ...store2.frames[0].passes[0] };
  const survivorUid = survivorBefore.uid;
  await store2.removePass(frameNo, survivorUid); // 试图删最后一遍 → 必须拦截
  assert.equal(store2.frames[0].passes.length, 1, '最后一遍不能删，仍剩 1 遍');
  const survivorAfter = store2.frames[0].passes[0];
  assert.equal(survivorAfter.uid, survivorBefore.uid, '保留的是原有那一遍');
  assert.equal(survivorAfter.lighting, survivorBefore.lighting, '最后一遍灯光参数保留');
  assert.equal(survivorAfter.exposureSec, survivorBefore.exposureSec, '最后一遍曝光参数保留');
  assert.equal(survivorAfter.shotCount, survivorBefore.shotCount, '最后一遍张数保留');
  assert.equal(survivorAfter.note, survivorBefore.note, '最后一遍备注保留');
  assert.equal(totalShotCount(store2.frames[0].passes), survivorBefore.shotCount, '只剩一遍时合计=该遍张数');

  // ---- 全新镜头：插入帧 + 显式 passes 种子 ----
  const newShotId = await api.addShot({
    code: 'S02',
    sceneName: '新镜头',
    fps: 12,
    durationSec: 1,
    startFrame: 1,
    endFrame: 12,
    status: '拍摄中',
    owner: '',
    progressPercent: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  setActivePinia(createPinia());
  const store3 = useFrameStore();
  await store3.loadForShot(newShotId);
  await store3.insertAt(0);
  assert.equal(store3.frames.length, 1);
  assert.equal(store3.frames[0].passes.length, 1, '新帧默认 1 遍');
  assert.equal(totalShotCount(store3.frames[0].passes), 2, '默认遍 2 张');

  // 旧版标量种子（模拟 ExposureForm 草稿）应生成对应第一遍
  await store3.insertAt(1, { shotCount: 1, exposureSec: 0.125, lighting: '背景灯', note: '草稿备注' } as Partial<FrameEntry>);
  const inserted = store3.frames[1];
  assert.equal(inserted.passes.length, 1);
  assert.equal(inserted.passes[0].shotCount, 1);
  assert.equal(inserted.passes[0].exposureSec, 0.125);
  assert.equal(inserted.passes[0].lighting, '背景灯');
  assert.equal(inserted.passes[0].note, '草稿备注');
  assert.equal(store3.totalShots, 3, '两帧合计 2+1=3 张');

  // 落库的行不应再含旧标量字段
  const raw = await (db as unknown as Dexie).table('frames').where('frameNo').equals(2).toArray();
  assert.equal(raw.length, 1);
  assert.equal(raw[0].shotCount, undefined, '落库行不含旧 shotCount 标量');
  assert.ok(Array.isArray(raw[0].passes), '落库行含 passes');

  console.log('✅ 全部遍次场景验证通过');
}

run().catch((e) => {
  console.error('❌ 验证失败', e);
  process.exit(1);
});
