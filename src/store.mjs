// 领域状态：把器材扫描台（equipment）、裁判开打登记（referee）、
// 校验仪领取记录（inspection）三路来源记录归并成可查询的现场状态。
//
// 设计要点：
// - 来源记录不可变，派生结论一律在查询时按评估时点重算；
// - 装配号（assembly）是一次现场固定的产物，拆装后再装会生成新装配号，
//   因此完成的/暂停的比赛天然保留开打时的球台构成，不会被后来的回仓改写；
// - 部件级校验（台面、网架）跟着实物走，临时恢复原件可沿用尚有效的部件凭据；
//   装配关系校验（如装配高度）只认明确装配号，拆装即失效。

const TIME = /^(\d{1,2}):(\d{2})$/;

export function toMinutes(text) {
  const match = TIME.exec(text ?? '');
  if (!match) throw new Error(`本馆当地时间格式无效：${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

// 时间一律按本馆当地 "HH:MM" 比较；返回负数/零/正数。
export function cmpTime(a, b) {
  return toMinutes(a) - toMinutes(b);
}

const laterOf = (a, b) => (a == null ? b : cmpTime(a, b) >= 0 ? a : b);

// 占用组合的场次状态：已开始/暂停/继续都视为仍占用；结束类状态才释放。
export const OCCUPYING_STATES = new Set(['已开始', '暂停', '继续']);
export const RELEASING_STATES = new Set(['已结束', '已完成', '结束', '完成', '释放', '取消']);

function matchBucket(store, id) {
  if (!store.matches.has(id)) {
    store.matches.set(id, { id, format: null, uses: [], reserves: [] });
  }
  return store.matches.get(id);
}

// 由一路或多路来源记录构建现场状态。sources 形如
// { equipment: [...], inspection: [...], referee: [...] }，
// 每个元素是来源返回的 { record, kind, payload }。
export function buildStore(sources) {
  const store = {
    now: null,
    assemblies: new Map(), // 装配号 -> {id, table, board, net, mountedAt, unmountedAt, handovers[]}
    measures: new Map(), // 校验编号 -> {test, subject, type, at, jig, result, expires}
    recalls: [], // 迟到的仪器校验说明 {jig, start, end, reason}
    formats: new Map(), // 赛制 -> 所需认可证据项目
    matches: new Map(), // 场次 -> {id, format, uses[], reserves[]}
    transfers: new Map(), // `${match}#${stamp}` -> {match, stamp, desk, referee, assembly, table}
    unknownKinds: [], // 未识别的记录类型，保留以便审计
  };
  const touch = (t) => {
    if (t != null) store.now = laterOf(store.now, t);
  };

  for (const entry of sources.equipment ?? []) {
    const p = entry.payload ?? {};
    if (entry.kind === 'mount') {
      // 现场固定后生成装配号；同一球台号码临时绑定这一套组合。
      store.assemblies.set(p.assembly, {
        id: p.assembly,
        table: p.table,
        board: p.board,
        net: p.net,
        mountedAt: p.start,
        unmountedAt: null,
        handovers: [],
      });
      touch(p.start);
    } else if (entry.kind === 'unmount') {
      const asm = store.assemblies.get(p.assembly);
      if (asm) asm.unmountedAt = p.stop;
      else store.unknownKinds.push({ ...entry, note: '拆装记录指向未知装配' });
      touch(p.stop);
    } else if (entry.kind === 'handover') {
      // 器材组确认一套装配已交还：授权链的器材组一端。
      const asm = store.assemblies.get(p.assembly);
      if (asm) asm.handovers.push({ at: p.at ?? null, record: entry.record });
      else store.unknownKinds.push({ ...entry, note: '交还记录指向未知装配' });
      touch(p.at);
    } else {
      store.unknownKinds.push(entry);
    }
  }

  for (const entry of sources.inspection ?? []) {
    const p = entry.payload ?? {};
    if (entry.kind === 'measure') {
      // 校验覆盖对象以 subject 为准：部件实物号或明确的装配号。
      store.measures.set(p.test, {
        test: p.test,
        subject: p.subject,
        type: p.type,
        at: p.at,
        jig: p.jig,
        result: p.result,
        expires: p.expires,
      });
      touch(p.at);
    } else if (entry.kind === 'recall') {
      // 迟到的仪器校验说明：只影响该夹具在 blockRange（左闭右开）内取得的证据。
      const [start, end] = p.blockRange ?? [];
      store.recalls.push({ jig: p.jig, start, end, reason: p.reason ?? '' });
    } else {
      store.unknownKinds.push(entry);
    }
  }

  for (const entry of sources.referee ?? []) {
    const p = entry.payload ?? {};
    if (entry.kind === 'needs') {
      // 赛制表：该赛事授权要求 required 所列全部认可证据。
      store.formats.set(p.format, [...(p.required ?? [])]);
    } else if (entry.kind === 'use') {
      // 裁判端实际使用现场组合的记录（已开始/暂停/继续/结束……）。
      const m = matchBucket(store, p.match);
      m.format = p.format ?? m.format;
      m.uses.push({ state: p.state, at: p.at, assembly: p.assembly, table: p.table, record: entry.record });
      touch(p.at);
    } else if (entry.kind === 'reserve') {
      // 值台预留：只占用竞赛时段，不产生开打授权。
      const m = matchBucket(store, p.match);
      m.format = p.format ?? m.format;
      m.reserves.push({ at: p.at, table: p.table, record: entry.record });
      touch(p.at);
    } else if (entry.kind === 'transfer') {
      // 转台：stamp 标明同一次转台，desk 与 referee 是两处独立确认，
      // 两端对相同 stamp 都确认后，目标装配才可给该暂停场次继续使用。
      const key = `${p.match}#${p.stamp}`;
      const t = store.transfers.get(key) ?? {
        match: p.match,
        stamp: p.stamp,
        desk: false,
        referee: false,
        assembly: null,
        table: null,
        records: [],
      };
      if (p.desk) t.desk = true;
      if (p.referee) t.referee = true;
      t.assembly = p.assembly ?? t.assembly;
      t.table = p.table ?? t.table;
      t.records.push(entry.record);
      store.transfers.set(key, t);
      touch(p.at);
    } else {
      store.unknownKinds.push(entry);
    }
  }

  return store;
}

// 单条校验在评估时点 t 是否有效。返回 { ok, reason }。
export function measureStatusAt(store, measure, t) {
  if (measure.result !== '通过') return { ok: false, reason: `校验结果为「${measure.result}」` };
  if (cmpTime(measure.at, t) > 0) return { ok: false, reason: `测量时间 ${measure.at} 晚于评估时点 ${t}` };
  if (cmpTime(t, measure.expires) >= 0) return { ok: false, reason: `凭据已于 ${measure.expires} 过期` };
  for (const recall of store.recalls) {
    // blockRange 左闭右开；只撤该夹具此时段内的证据，不波及其他仪器。
    if (recall.jig === measure.jig && cmpTime(recall.start, measure.at) <= 0 && cmpTime(measure.at, recall.end) < 0) {
      return {
        ok: false,
        reason: `夹具 ${measure.jig} 在 [${recall.start}, ${recall.end}) 区间校验失效（${recall.reason}）`,
        recall,
      };
    }
  }
  const asm = store.assemblies.get(measure.subject);
  if (asm) {
    // 针对装配号的记录才证明装配关系；拆装会取消原先关于装配关系的现场检查。
    if (cmpTime(measure.at, asm.mountedAt) < 0) {
      return { ok: false, reason: `装配 ${measure.subject} 于 ${asm.mountedAt} 才固定，测量早于装配` };
    }
    if (asm.unmountedAt != null && cmpTime(t, asm.unmountedAt) >= 0) {
      return { ok: false, reason: `装配 ${measure.subject} 已于 ${asm.unmountedAt} 拆装，装配关系现场检查失效` };
    }
  }
  return { ok: true, reason: null };
}

// 一条校验是否被某条迟到说明作废（用于追清报告，与评估时点无关）。
export function voidedByRecall(store, measure) {
  return store.recalls.find(
    (recall) =>
      recall.jig === measure.jig && cmpTime(recall.start, measure.at) <= 0 && cmpTime(measure.at, recall.end) < 0,
  ) ?? null;
}

// 一套装配在评估时点 t 对某赛制的核验结论。
// 每个要求项目必须落在同一套组合的台面、网架或装配号上：
// 两项各自有效的部件校验不能替代对同一装配组合的核验。
export function clearanceAt(store, asm, format, t) {
  const required = store.formats.get(format);
  if (!required) return { format, ok: false, items: [], reason: `赛制 ${format} 未见认可证据要求` };
  if (asm.unmountedAt != null && cmpTime(t, asm.unmountedAt) >= 0) {
    // 组合已拆装：不能交检录；部件凭据仍在，临时恢复原件时可沿用，
    // 但恢复后是新的装配号，装配关系项目须重新核验。
    return { format, ok: false, items: [], reason: `装配 ${asm.id} 已于 ${asm.unmountedAt} 拆装，组合当前不存在` };
  }
  const items = required.map((type) => {
    const candidates = [...store.measures.values()]
      .filter((m) => m.type === type && (m.subject === asm.board || m.subject === asm.net || m.subject === asm.id))
      .sort((a, b) => cmpTime(a.at, b.at));
    const valid = candidates.filter((m) => measureStatusAt(store, m, t).ok);
    if (valid.length > 0) {
      const used = valid.at(-1);
      return { type, ok: true, test: used.test, subject: used.subject, at: used.at, jig: used.jig, expires: used.expires };
    }
    let reason = '缺少落在本组合（台面/网架/装配号）上的该项校验';
    if (candidates.length > 0) {
      const latest = candidates.at(-1);
      reason = `${latest.test}（${latest.subject}，${latest.at}）：${measureStatusAt(store, latest, t).reason}`;
    }
    return { type, ok: false, reason };
  });
  return { format, ok: items.every((item) => item.ok), items };
}

// 场次当前状态：以最后一条使用记录为准；只有预留则为「预留待审」。
export function matchStatus(match) {
  const last = match.uses.at(-1);
  if (last) {
    if (OCCUPYING_STATES.has(last.state)) return last.state;
    if (RELEASING_STATES.has(last.state)) return '已释放';
    return last.state;
  }
  return match.reserves.length > 0 ? '预留待审' : '未见记录';
}

// 场次当前占用的组合（若有）：最后一条占用态使用记录指向的装配。
export function matchOccupancy(match) {
  const last = match.uses.at(-1);
  if (last && OCCUPYING_STATES.has(last.state)) return last;
  return null;
}

// 球台当前绑定的装配（最新一条未拆装的固定记录）。
export function currentAssemblyOf(store, table) {
  const bound = [...store.assemblies.values()]
    .filter((asm) => asm.table === table)
    .sort((a, b) => cmpTime(a.mountedAt, b.mountedAt));
  return bound.filter((asm) => asm.unmountedAt == null).at(-1) ?? null;
}

// 转台是否成立：两端对相同 stamp 都确认。
export function transferComplete(transfer) {
  return transfer.desk && transfer.referee;
}
