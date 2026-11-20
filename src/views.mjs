// 视图层：把现场状态整理成竞赛席、裁判各自需要的结论。
// 所有函数返回结构化数据，展示（文本/JSON）由调用方决定。

import {
  clearanceAt,
  cmpTime,
  matchOccupancy,
  matchStatus,
  measureStatusAt,
  transferComplete,
} from './store.mjs';

function componentsOf(store, assemblyId) {
  const asm = store.assemblies.get(assemblyId);
  return asm ? { board: asm.board, net: asm.net } : null;
}

// 每台球的当前绑定、占用、预留、转台锁定。
function tableRows(store) {
  const tables = new Map();
  for (const asm of store.assemblies.values()) {
    if (!tables.has(asm.table)) tables.set(asm.table, []);
    tables.get(asm.table).push(asm);
  }
  const rows = [];
  for (const [table, bindings] of [...tables.entries()].sort(([a], [b]) => cmpKey(a, b))) {
    bindings.sort((a, b) => cmpTime(a.mountedAt, b.mountedAt));
    const current = bindings.filter((asm) => asm.unmountedAt == null).at(-1) ?? null;

    const occupants = [];
    for (const match of store.matches.values()) {
      const occ = matchOccupancy(match);
      if (!occ) continue;
      const onThisTable = occ.table === table || bindings.some((asm) => asm.id === occ.assembly);
      if (!onThisTable) continue;
      const asm = store.assemblies.get(occ.assembly);
      occupants.push({
        match: match.id,
        state: occ.state,
        assembly: occ.assembly,
        at: occ.at,
        // 暂停占用期间组合被器材组拆装：换件纠纷的核心事实。
        unmountedWhileOccupied:
          asm?.unmountedAt != null && cmpTime(asm.unmountedAt, occ.at) > 0 ? asm.unmountedAt : null,
      });
    }

    const reserves = [];
    for (const match of store.matches.values()) {
      for (const r of match.reserves) {
        if (r.table === table) reserves.push({ match: match.id, at: r.at, format: match.format });
      }
    }

    // 转台确认中：旧台未释放不能给另一场，新台也不能被当成空闲再分派。
    const transferLocks = [];
    for (const t of store.transfers.values()) {
      if (transferComplete(t)) continue;
      const held = store.matches.get(t.match);
      const occ = held ? matchOccupancy(held) : null;
      const oldSide = occ && (occ.table === table || bindings.some((asm) => asm.id === occ.assembly));
      const newSide = t.table === table || (t.assembly && bindings.some((asm) => asm.id === t.assembly));
      if (oldSide || newSide) {
        transferLocks.push({ match: t.match, stamp: t.stamp, desk: t.desk, referee: t.referee, side: oldSide ? '旧台' : '新台' });
      }
    }

    rows.push({ table, bindings, current, occupants, reserves, transferLocks });
  }
  return rows;
}

const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 竞赛席看板：哪些台可交检录、哪些待实地复查。
export function deskBoard(store) {
  const tables = tableRows(store).map((row) => {
    const formats = {};
    if (row.current) {
      for (const format of store.formats.keys()) {
        formats[format] = clearanceAt(store, row.current, format, store.now);
      }
    }
    const clearFor = Object.values(formats).filter((c) => c.ok).map((c) => c.format);
    const verdict = !row.current
      ? '无装配'
      : clearFor.length > 0
        ? '可交检录'
        : '待实地复查';
    return {
      table: row.table,
      current: row.current
        ? { assembly: row.current.id, board: row.current.board, net: row.current.net, mountedAt: row.current.mountedAt }
        : null,
      formats,
      clearFor,
      verdict,
      occupants: row.occupants,
      reserves: row.reserves,
      transferLocks: row.transferLocks,
    };
  });
  return { now: store.now, tables };
}

// 裁判视图：场次时间线 + 暂停前实际使用过的组合及其凭据现状。
export function refereeView(store, matchId) {
  const match = store.matches.get(matchId);
  if (!match) return null;
  const status = matchStatus(match);

  const timeline = match.uses.map((use) => {
    const asm = store.assemblies.get(use.assembly);
    const entry = {
      at: use.at,
      state: use.state,
      assembly: use.assembly,
      table: use.table,
      // 构成取自装配固定记录，器材回仓、换件都不会改写历史。
      components: asm ? { board: asm.board, net: asm.net } : null,
    };
    if (use.state === '已开始' || use.state === '继续') {
      // 开打核验：这一拍当时是否具备赛制要求的全部认可证据。
      entry.startCheck = asm && match.format ? clearanceAt(store, asm, match.format, use.at) : null;
    }
    return entry;
  });

  // 暂停前实际使用过的组合：最近一次暂停之前的最后一拍已开始/继续。
  let prePause = null;
  if (status === '暂停') {
    const lastPause = match.uses.map((u) => u.state).lastIndexOf('暂停');
    const start = match.uses.slice(0, lastPause).reverse().find((u) => u.state === '已开始' || u.state === '继续');
    if (start) {
      const asm = store.assemblies.get(start.assembly);
      const then = asm && match.format ? clearanceAt(store, asm, match.format, start.at) : null;
      prePause = {
        at: start.at,
        assembly: start.assembly,
        table: start.table,
        components: asm ? { board: asm.board, net: asm.net } : null,
        assemblyUnmountedAt: asm?.unmountedAt ?? null,
        credentials: (then?.items ?? []).map((item) => {
          if (!item.ok) return { type: item.type, thenOk: false, reason: item.reason };
          const measure = store.measures.get(item.test);
          const now = measureStatusAt(store, measure, store.now);
          return {
            type: item.type,
            test: item.test,
            subject: item.subject,
            at: item.at,
            jig: item.jig,
            expires: item.expires,
            thenOk: true,
            nowOk: now.ok,
            nowReason: now.reason,
          };
        }),
      };
    }
  }

  const transfers = [...store.transfers.values()]
    .filter((t) => t.match === matchId)
    .map((t) => ({ ...t, complete: transferComplete(t) }));

  return { match: matchId, format: match.format, status, timeline, prePause, transfers, reserves: match.reserves };
}

// 场次历史：开打时的球台构成随记录冻结，供完赛存档与异议复核。
export function matchHistory(store, matchId) {
  const match = store.matches.get(matchId);
  if (!match) return null;
  return {
    match: matchId,
    format: match.format,
    status: matchStatus(match),
    events: match.uses.map((use) => ({
      at: use.at,
      state: use.state,
      assembly: use.assembly,
      table: use.table,
      components: componentsOf(store, use.assembly),
    })),
    reserves: match.reserves,
  };
}

// 问题追清：换件、台号复用、迟到校验说明发生后，
// 从受影响的具体部件追清可复用凭据、可分配组合、应交裁判处理的已开始记录。
export function traceReport(store) {
  // 换件与台号复用：同一球台号码的相邻两次固定。
  const swaps = [];
  const tableReuse = [];
  const byTable = new Map();
  for (const asm of store.assemblies.values()) {
    if (!byTable.has(asm.table)) byTable.set(asm.table, []);
    byTable.get(asm.table).push(asm);
  }
  for (const [table, bindings] of byTable) {
    bindings.sort((a, b) => cmpTime(a.mountedAt, b.mountedAt));
    if (bindings.length > 1) tableReuse.push({ table, assemblies: bindings.map((a) => a.id) });
    for (let i = 1; i < bindings.length; i += 1) {
      const from = bindings[i - 1];
      const to = bindings[i];
      const changedParts = [];
      if (from.board !== to.board) changedParts.push('台面');
      if (from.net !== to.net) changedParts.push('网架');
      swaps.push({
        table,
        from: from.id,
        to: to.id,
        at: to.mountedAt,
        changedParts,
        // 部件原样装回：临时恢复原件，部件凭据可沿用，装配关系仍需重新核验。
        restoredOriginal: changedParts.length === 0,
      });
    }
  }

  // 部件复用：同一实物出现在多套装配里。
  const partAssemblies = new Map();
  for (const asm of store.assemblies.values()) {
    for (const part of [asm.board, asm.net]) {
      if (!partAssemblies.has(part)) partAssemblies.set(part, new Set());
      partAssemblies.get(part).add(asm.id);
    }
  }
  const componentReuse = [...partAssemblies.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([part, set]) => ({ part, assemblies: [...set].sort() }));

  // 迟到的仪器校验说明及其作废的证据（blockRange 左闭右开，只及该夹具此时段）。
  const recalls = store.recalls.map((recall) => ({
    ...recall,
    voided: [...store.measures.values()]
      .filter((m) => m.jig === recall.jig && cmpTime(recall.start, m.at) <= 0 && cmpTime(m.at, recall.end) < 0)
      .map((m) => ({ test: m.test, subject: m.subject, type: m.type, at: m.at })),
  }));

  // 暂停占用期间被拆装的组合。
  const unmountWhileOccupied = [];
  for (const match of store.matches.values()) {
    const occ = matchOccupancy(match);
    if (!occ) continue;
    const asm = store.assemblies.get(occ.assembly);
    if (asm?.unmountedAt != null && cmpTime(asm.unmountedAt, occ.at) > 0) {
      unmountWhileOccupied.push({
        match: match.id,
        state: occ.state,
        assembly: occ.assembly,
        table: occ.table,
        unmountedAt: asm.unmountedAt,
      });
    }
  }

  // 受影响装配：换件/台号复用/部件复用涉及的装配 + 被迟到说明作废证据落在其上的装配 + 占用中被拆装的装配。
  const affectedIds = new Set();
  for (const s of swaps) {
    affectedIds.add(s.from);
    affectedIds.add(s.to);
  }
  for (const c of componentReuse) {
    for (const id of c.assemblies) affectedIds.add(id);
  }
  for (const recall of recalls) {
    for (const v of recall.voided) {
      const measure = store.measures.get(v.test);
      for (const asm of store.assemblies.values()) {
        if (asm.id === measure.subject || asm.board === measure.subject || asm.net === measure.subject) {
          affectedIds.add(asm.id);
        }
      }
    }
  }
  for (const u of unmountWhileOccupied) affectedIds.add(u.assembly);

  // 从受影响部件追清：本场还有哪些可复用凭据。
  const affected = [...affectedIds].sort().flatMap((id) => {
    const asm = store.assemblies.get(id);
    if (!asm) return [];
    const parts = [asm.board, asm.net];
    const reusableCredentials = [...store.measures.values()]
      .filter((m) => parts.includes(m.subject) && measureStatusAt(store, m, store.now).ok)
      .sort((a, b) => cmpTime(a.at, b.at))
      .map((m) => ({ test: m.test, subject: m.subject, type: m.type, at: m.at, jig: m.jig, expires: m.expires }));
    const assemblyChecks = [...store.measures.values()]
      .filter((m) => m.subject === asm.id)
      .sort((a, b) => cmpTime(a.at, b.at))
      .map((m) => ({ test: m.test, type: m.type, at: m.at, status: measureStatusAt(store, m, store.now) }));
    const formats = {};
    for (const format of store.formats.keys()) {
      formats[format] = clearanceAt(store, asm, format, store.now);
    }
    return [{
      assembly: id,
      table: asm.table,
      components: { board: asm.board, net: asm.net },
      mountedAt: asm.mountedAt,
      unmountedAt: asm.unmountedAt,
      reusableCredentials,
      assemblyChecks,
      formats,
    }];
  });

  // 哪个新组合可以分派：当前在装、凭据齐全、未被占用/预留/转台锁定。
  const rows = tableRows(store);
  const assignable = [];
  const blocked = [];
  for (const row of rows) {
    if (!row.current) continue;
    const formats = {};
    for (const format of store.formats.keys()) {
      formats[format] = clearanceAt(store, row.current, format, store.now);
    }
    const clearFor = Object.values(formats).filter((c) => c.ok).map((c) => c.format);
    const why = [];
    if (row.occupants.length > 0) {
      why.push(...row.occupants.map((o) => `${o.match} ${o.state}占用${o.assembly ? ` ${o.assembly}` : ''}`));
    }
    if (row.reserves.length > 0) {
      why.push(...row.reserves.map((r) => `${r.match} 于 ${r.at} 预留（预留不产生开打授权）`));
    }
    if (row.transferLocks.length > 0) {
      why.push(...row.transferLocks.map((l) => `转台 ${l.stamp} 确认中（desk=${l.desk} referee=${l.referee}）`));
    }
    const entry = {
      table: row.table,
      assembly: row.current.id,
      components: { board: row.current.board, net: row.current.net },
      clearFor,
      formats,
    };
    if (clearFor.length > 0 && why.length === 0) assignable.push(entry);
    else blocked.push({ ...entry, why });
  }

  // 哪一次已开始记录应交裁判处理：仍占用组合的场次。
  const toReferee = [];
  for (const match of store.matches.values()) {
    const occ = matchOccupancy(match);
    if (!occ) continue;
    const asm = store.assemblies.get(occ.assembly);
    const notes = [];
    if (asm?.unmountedAt != null) notes.push(`组合 ${occ.assembly} 已于 ${asm.unmountedAt} 被拆装，恢复或转台须裁判定夺`);
    const pending = [...store.transfers.values()].filter((t) => t.match === match.id && !transferComplete(t));
    if (pending.length > 0) notes.push(`转台 ${pending.map((t) => t.stamp).join('、')} 尚未两端确认`);
    toReferee.push({
      match: match.id,
      state: occ.state,
      assembly: occ.assembly,
      table: occ.table,
      components: asm ? { board: asm.board, net: asm.net } : null,
      note: notes.join('；') || '占用中',
    });
  }

  return {
    now: store.now,
    problems: { swaps, tableReuse, componentReuse, recalls, unmountWhileOccupied },
    affected,
    assignable,
    blocked,
    toReferee,
  };
}
