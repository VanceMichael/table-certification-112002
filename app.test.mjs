import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { fetchSource, pullAll, setStage } from './src/source-client.mjs';
import { buildStore, clearanceAt, measureStatusAt } from './src/store.mjs';
import { deskBoard, matchHistory, refereeView, traceReport } from './src/views.mjs';

const close = (server) => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));

// ---------- 集成：沿四阶段回放核对竞赛席与裁判关心的结论 ----------

test('四阶段回放：可交检录/待复查、暂停前组合、追清与历史冻结', async (t) => {
  const { server, url } = await start();
  t.after(() => close(server));
  const at = async (stage) => {
    await setStage(url, stage);
    const pulled = await pullAll(url);
    assert.equal(pulled.stage, stage);
    return buildStore(pulled.sources);
  };

  // 阶段 1：T4=AS1(B3+N2)，三项校验齐全，S9 开打。
  let store = await at(1);
  let board = deskBoard(store);
  assert.equal(board.now, '09:50');
  assert.equal(board.tables.length, 1);
  assert.equal(board.tables[0].current.assembly, 'AS1');
  assert.deepEqual(board.tables[0].clearFor.sort(), ['公开', '分练']);
  let view = refereeView(store, 'S9');
  assert.equal(view.status, '已开始');
  assert.equal(view.timeline[0].startCheck.ok, true, '开打时凭据齐全');

  // 阶段 2：S9 暂停占用 AS1，器材组仍拆装并换上 N9（AS2 无任何校验）。
  store = await at(2);
  board = deskBoard(store);
  assert.equal(board.tables[0].current.assembly, 'AS2');
  assert.equal(board.tables[0].verdict, '待实地复查');
  assert.deepEqual(
    board.tables[0].formats['公开'].items.filter((i) => !i.ok).map((i) => i.type),
    ['网架', '装配高度'],
  );
  assert.equal(board.tables[0].occupants[0].unmountedWhileOccupied, '10:08', '暂停占用期间被拆装');
  view = refereeView(store, 'S9');
  assert.equal(view.status, '暂停');
  assert.deepEqual(view.prePause.components, { board: 'B3', net: 'N2' }, '暂停前组合不受换件影响');
  let trace = traceReport(store);
  assert.deepEqual(trace.problems.swaps[0].changedParts, ['网架']);
  assert.equal(trace.problems.unmountWhileOccupied[0].match, 'S9');

  // 阶段 3：AS2 补齐校验后公开可交检录；T8/AS3 缺项待复查；S10 预留不产生授权。
  store = await at(3);
  board = deskBoard(store);
  const t4 = board.tables.find((r) => r.table === 'T4');
  const t8 = board.tables.find((r) => r.table === 'T8');
  assert.equal(t4.formats['公开'].ok, true);
  assert.deepEqual(
    t8.formats['公开'].items.filter((i) => !i.ok).map((i) => i.type),
    ['台面线', '装配高度'],
  );
  assert.equal(t4.reserves[0].match, 'S10');
  assert.equal(refereeView(store, 'S10').status, '预留待审', '预留不等于开打授权');
  trace = traceReport(store);
  assert.equal(trace.assignable.length, 0, 'T4 被占用+预留、T8 凭据不齐，无可分配组合');

  // 阶段 4：迟到的 JG2 说明只作废 [10:00,10:30) 内的 Q5。
  store = await at(4);
  board = deskBoard(store);
  const t4s4 = board.tables.find((r) => r.table === 'T4');
  assert.equal(t4s4.formats['公开'].ok, false, 'AS2 失去装配高度凭据');
  assert.match(t4s4.formats['公开'].items.find((i) => i.type === '装配高度').reason, /JG2/);
  assert.equal(t4s4.formats['分练'].ok, true, '分练不要求装配高度，仍可交检录');
  assert.equal(measureStatusAt(store, store.measures.get('Q2'), store.now).ok, true, 'Q2 在召回区间外不受影响');
  trace = traceReport(store);
  assert.deepEqual(trace.problems.recalls[0].voided.map((v) => v.test), ['Q5']);
  const as2 = trace.affected.find((a) => a.assembly === 'AS2');
  assert.deepEqual(as2.reusableCredentials.map((m) => m.test).sort(), ['Q1', 'Q4'], '可复用部件凭据');
  assert.equal(trace.assignable.length, 0);
  assert.deepEqual(trace.toReferee.map((m) => m.match), ['S9'], '已开始记录交裁判处理');
  view = refereeView(store, 'S9');
  const cred = Object.fromEntries(view.prePause.credentials.map((c) => [c.type, c]));
  assert.equal(cred['台面线'].nowOk, true);
  assert.equal(cred['网架'].nowOk, true);
  assert.equal(cred['装配高度'].nowOk, false, '拆装使装配关系检查失效');
  const history = matchHistory(store, 'S9');
  assert.deepEqual(
    history.events.map((e) => e.components),
    [
      { board: 'B3', net: 'N2' },
      { board: 'B3', net: 'N2' },
    ],
    '历史构成冻结，不显示后来装上的 N9',
  );
});

test('客户端跟随 next 翻页拉齐全部记录', async (t) => {
  const { server, url } = await start();
  t.after(() => close(server));
  await setStage(url, 4);
  const all = await fetchSource(url, 'inspection', fetch, 2);
  assert.equal(all.length, 6);
  assert.equal(new Set(all.map((r) => r.record)).size, 6);
});

// ---------- 单元：边界与授权链规则 ----------

let seq = 0;
const rec = (kind, payload) => ({ record: `t-${++seq}`, kind, payload });
const src = (over = {}) => ({ equipment: [], inspection: [], referee: [], ...over });

test('迟到校验说明：blockRange 左闭右开，且不波及其他夹具', () => {
  const store = buildStore(src({
    inspection: [
      rec('measure', { test: 'M1', subject: 'B1', type: '台面线', at: '09:59', jig: 'JX', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M2', subject: 'B1', type: '台面线', at: '10:00', jig: 'JX', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M3', subject: 'B1', type: '台面线', at: '10:29', jig: 'JX', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M4', subject: 'B1', type: '台面线', at: '10:30', jig: 'JX', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M5', subject: 'B1', type: '台面线', at: '10:15', jig: 'JY', result: '通过', expires: '18:00' }),
      rec('recall', { jig: 'JX', blockRange: ['10:00', '10:30'], reason: '区间失效' }),
    ],
  }));
  const ok = (id, t) => measureStatusAt(store, store.measures.get(id), t).ok;
  assert.equal(ok('M1', '11:00'), true, '区间起点之前有效');
  assert.equal(ok('M2', '11:00'), false, '左闭：起点作废');
  assert.equal(ok('M3', '11:00'), false);
  assert.equal(ok('M4', '11:00'), true, '右开：终点有效');
  assert.equal(ok('M5', '11:00'), true, '其他夹具的结果不自动撤掉');
});

test('凭据有效期：到期时刻起失效', () => {
  const store = buildStore(src({
    inspection: [rec('measure', { test: 'M1', subject: 'B1', type: '台面线', at: '08:00', jig: 'J1', result: '通过', expires: '12:00' })],
  }));
  const m = store.measures.get('M1');
  assert.equal(measureStatusAt(store, m, '11:59').ok, true);
  assert.equal(measureStatusAt(store, m, '12:00').ok, false);
});

test('拆装取消装配关系检查；恢复原件可沿用部件凭据但须重核装配', () => {
  const store = buildStore(src({
    equipment: [
      rec('mount', { table: 'T1', board: 'B1', net: 'N1', assembly: 'A1', start: '08:00' }),
      rec('unmount', { table: 'T1', assembly: 'A1', stop: '09:00' }),
      rec('mount', { table: 'T1', board: 'B1', net: 'N1', assembly: 'A2', start: '09:10' }),
    ],
    inspection: [
      rec('measure', { test: 'M1', subject: 'B1', type: '台面线', at: '08:10', jig: 'J1', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M2', subject: 'N1', type: '网架', at: '08:10', jig: 'J1', result: '通过', expires: '18:00' }),
      rec('measure', { test: 'M3', subject: 'A1', type: '装配高度', at: '08:20', jig: 'J1', result: '通过', expires: '18:00' }),
    ],
    referee: [rec('needs', { format: '公开', required: ['台面线', '网架', '装配高度'] })],
  }));
  assert.equal(clearanceAt(store, store.assemblies.get('A1'), '公开', '08:30').ok, true, '历史上 A1 曾齐备');
  const a2 = clearanceAt(store, store.assemblies.get('A2'), '公开', '09:30');
  assert.equal(a2.ok, false, 'A1 的装配高度凭据不转移给 A2');
  assert.deepEqual(a2.items.filter((i) => !i.ok).map((i) => i.type), ['装配高度']);
  assert.equal(a2.items.find((i) => i.type === '台面线').ok, true, '部件凭据沿用');
  assert.equal(a2.items.find((i) => i.type === '网架').ok, true, '部件凭据沿用');
  assert.equal(clearanceAt(store, store.assemblies.get('A1'), '公开', '09:30').ok, false, '已拆装组合不能交检录');
});

test('转台：两端对相同 stamp 确认前，旧台新台都不得再分派', () => {
  const equipment = [
    rec('mount', { table: 'T1', board: 'B1', net: 'N1', assembly: 'A1', start: '08:00' }),
    rec('mount', { table: 'T2', board: 'B2', net: 'N2', assembly: 'A2', start: '08:00' }),
  ];
  const inspection = [
    rec('measure', { test: 'M1', subject: 'B1', type: '台面线', at: '08:10', jig: 'J1', result: '通过', expires: '18:00' }),
    rec('measure', { test: 'M2', subject: 'B2', type: '台面线', at: '08:10', jig: 'J1', result: '通过', expires: '18:00' }),
  ];
  const referee = [
    rec('needs', { format: '分练', required: ['台面线'] }),
    rec('use', { match: 'S1', format: '分练', assembly: 'A1', table: 'T1', state: '已开始', at: '08:30' }),
    rec('use', { match: 'S1', format: '分练', assembly: 'A1', table: 'T1', state: '暂停', at: '08:50' }),
  ];
  // 仅 desk 确认：两台都锁定。
  let store = buildStore(src({
    equipment, inspection,
    referee: [...referee, rec('transfer', { match: 'S1', stamp: 'X1', desk: true, assembly: 'A2', table: 'T2', at: '09:00' })],
  }));
  let board = deskBoard(store);
  assert.equal(board.tables.find((r) => r.table === 'T1').transferLocks.length, 1, '旧台未释放不能给另一场');
  assert.equal(board.tables.find((r) => r.table === 'T2').transferLocks.length, 1, '新台不能被当成空闲再分派');
  assert.equal(traceReport(store).assignable.length, 0);
  // 仅 referee 确认同样锁定。
  store = buildStore(src({
    equipment, inspection,
    referee: [...referee, rec('transfer', { match: 'S1', stamp: 'X1', referee: true, assembly: 'A2', table: 'T2', at: '09:00' })],
  }));
  assert.equal(deskBoard(store).tables.find((r) => r.table === 'T2').transferLocks.length, 1);
  // 两端对相同 stamp 确认后解锁，新台凭据齐全即可分派。
  store = buildStore(src({
    equipment, inspection,
    referee: [
      ...referee,
      rec('transfer', { match: 'S1', stamp: 'X1', desk: true, assembly: 'A2', table: 'T2', at: '09:00' }),
      rec('transfer', { match: 'S1', stamp: 'X1', referee: true, at: '09:01' }),
    ],
  }));
  board = deskBoard(store);
  assert.equal(board.tables.every((r) => r.transferLocks.length === 0), true);
  const trace = traceReport(store);
  assert.deepEqual(trace.assignable.map((a) => a.assembly), ['A2'], '新组合有可用依据才可继续');
});

test('器材组交还回执入账，授权链可查', () => {
  const store = buildStore(src({
    equipment: [
      rec('mount', { table: 'T1', board: 'B1', net: 'N1', assembly: 'A1', start: '08:00' }),
      rec('handover', { assembly: 'A1', at: '08:20' }),
    ],
  }));
  assert.equal(store.assemblies.get('A1').handovers.length, 1);
});

test('完成的比赛保留开打时构成，器材回仓不改写历史', () => {
  const store = buildStore(src({
    equipment: [
      rec('mount', { table: 'T1', board: 'B1', net: 'N1', assembly: 'A1', start: '08:00' }),
      rec('unmount', { table: 'T1', assembly: 'A1', stop: '10:00' }),
      rec('mount', { table: 'T1', board: 'B1', net: 'N9', assembly: 'A2', start: '10:05' }),
    ],
    referee: [
      rec('use', { match: 'S1', format: '公开', assembly: 'A1', table: 'T1', state: '已开始', at: '08:30' }),
      rec('use', { match: 'S1', format: '公开', assembly: 'A1', table: 'T1', state: '已结束', at: '09:30' }),
    ],
  }));
  const history = matchHistory(store, 'S1');
  assert.equal(history.status, '已释放');
  assert.deepEqual(history.events[0].components, { board: 'B1', net: 'N1' }, '仍显示开打时的 N1 而非后来的 N9');
  assert.equal(traceReport(store).toReferee.length, 0, '已结束的场次不再占用');
});
