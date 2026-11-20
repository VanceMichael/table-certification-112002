// 竞赛席/裁判业务端：从器材扫描台、裁判开打登记、校验仪领取记录
// 三路来源拉取记录，回答——
//   哪些台可交检录、哪些待实地复查（desk）；
//   暂停前实际使用过的组合及凭据现状（referee <场次>）；
//   换件/台号复用/迟到校验说明后的追清（trace）；
//   场次开打时构成的冻结存档（history <场次>）。
//
// 用法：
//   node app.mjs [--url http://127.0.0.1:4100] [--stage N] [--json]
//                desk | referee <场次> | trace | history <场次> | matches | report
// 需要先启动来源服务：npm start（默认 127.0.0.1:4100）。

import { pullAll, setStage } from './src/source-client.mjs';
import { buildStore } from './src/store.mjs';
import { deskBoard, matchHistory, refereeView, traceReport } from './src/views.mjs';

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:4100', stage: null, json: false, command: 'report', args: [] };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--url') options.url = rest.shift();
    else if (arg === '--stage') options.stage = Number(rest.shift());
    else if (arg === '--json') options.json = true;
    else if (!options.commandSet) {
      options.command = arg;
      options.commandSet = true;
    } else options.args.push(arg);
  }
  return options;
}

const lines = [];
const out = (text = '') => lines.push(text);

function renderClearance(clearance, indent) {
  if (!clearance) return;
  if (clearance.ok) {
    const used = clearance.items.map((i) => `${i.type} ${i.test}`).join('、');
    out(`${indent}${clearance.format}：可交检录（${used}）`);
  } else {
    out(`${indent}${clearance.format}：待实地复查`);
    if (clearance.reason) out(`${indent}  - ${clearance.reason}`);
    for (const item of clearance.items.filter((i) => !i.ok)) {
      out(`${indent}  - ${item.type}：${item.reason}`);
    }
  }
}

function renderDesk(board, stage) {
  out(`竞赛席台面看板（回放阶段 ${stage}，评估时点 ${board.now ?? '—'}）`);
  for (const row of board.tables) {
    if (!row.current) {
      out(`\n台 ${row.table}：无装配`);
      continue;
    }
    const c = row.current;
    out(`\n台 ${row.table}：当前装配 ${c.assembly}（台面 ${c.board} + 网架 ${c.net}，${c.mountedAt} 固定）——${row.verdict}`);
    for (const format of Object.keys(row.formats)) renderClearance(row.formats[format], '  ');
    for (const o of row.occupants) {
      out(`  占用：${o.match} ${o.state}（${o.at} 起，组合 ${o.assembly}）`);
      if (o.unmountedWhileOccupied) out(`    注意：该组合已于 ${o.unmountedWhileOccupied} 被器材组拆装`);
    }
    for (const r of row.reserves) out(`  预留：${r.match} 于 ${r.at} 预留待审（预留不产生开打授权）`);
    for (const l of row.transferLocks) {
      out(`  转台锁定：${l.match} 转台 ${l.stamp} 确认中（desk=${l.desk} referee=${l.referee}），${l.side}不得再分派`);
    }
  }
}

function renderReferee(view) {
  out(`裁判视图：场次 ${view.match}（赛制 ${view.format ?? '—'}，状态 ${view.status}）`);
  out('  时间线：');
  for (const t of view.timeline) {
    const c = t.components ? `台面 ${t.components.board} + 网架 ${t.components.net}` : '构成未知';
    out(`  - ${t.at} ${t.state}：${t.table} 组合 ${t.assembly}（${c}）`);
    if (t.startCheck) {
      out(`    开打核验：${t.startCheck.ok ? '凭据齐全' : '凭据不齐'}`);
      for (const item of t.startCheck.items.filter((i) => !i.ok)) out(`      缺 ${item.type}：${item.reason}`);
    }
  }
  if (view.prePause) {
    const p = view.prePause;
    const c = p.components ? `台面 ${p.components.board} + 网架 ${p.components.net}` : '构成未知';
    out(`  暂停前实际使用组合：${p.assembly}（${p.table}，${c}，${p.at} 开打）`);
    if (p.assemblyUnmountedAt) out(`    该组合已于 ${p.assemblyUnmountedAt} 被拆装，装配关系现场检查随之失效`);
    for (const cred of p.credentials) {
      if (!cred.thenOk) {
        out(`    ${cred.type}：开打时即缺（${cred.reason}）`);
      } else {
        out(`    ${cred.type}：${cred.test}（${cred.subject}，${cred.at} 测，${cred.expires} 到期）开打时有效；当前${cred.nowOk ? '仍有效' : `失效——${cred.nowReason}`}`);
      }
    }
  }
  for (const t of view.transfers) {
    out(`  转台 ${t.stamp}：desk=${t.desk} referee=${t.referee} ${t.complete ? '已两端确认' : '确认中，旧台新台均不得再分派'}`);
  }
  for (const r of view.reserves) out(`  预留：${r.at} 台 ${r.table}（预留不产生开打授权）`);
}

function renderTrace(report) {
  out(`问题追清（评估时点 ${report.now ?? '—'}）`);
  const { swaps, tableReuse, componentReuse, recalls, unmountWhileOccupied } = report.problems;
  if (swaps.length > 0) {
    out('  换件/恢复：');
    for (const s of swaps) {
      out(`  - 台 ${s.table}：${s.from} → ${s.to}（${s.at}）${s.restoredOriginal ? '原部件装回，装配关系仍需重新核验' : `更换${s.changedParts.join('、')}`}`);
    }
  }
  if (tableReuse.length > 0) out(`  台号复用：${tableReuse.map((t) => `${t.table}（${t.assemblies.join('→')}）`).join('；')}`);
  if (componentReuse.length > 0) out(`  部件复用：${componentReuse.map((c) => `${c.part} 见于 ${c.assemblies.join('、')}`).join('；')}`);
  for (const r of recalls) {
    out(`  迟到校验说明：夹具 ${r.jig} [${r.start}, ${r.end}) ${r.reason}，作废 ${r.voided.map((v) => v.test).join('、') || '无'}`);
  }
  for (const u of unmountWhileOccupied) {
    out(`  占用中拆装：${u.match} ${u.state}占用 ${u.assembly}，${u.unmountedAt} 被拆装`);
  }
  out('  受影响组合与可复用凭据：');
  for (const a of report.affected) {
    const state = a.unmountedAt ? `已于 ${a.unmountedAt} 拆装` : '在装';
    out(`  - ${a.assembly}（台 ${a.table}，台面 ${a.components.board} + 网架 ${a.components.net}，${state}）`);
    out(`    可复用部件凭据：${a.reusableCredentials.map((m) => `${m.test}（${m.subject} ${m.type}，${m.expires} 前有效）`).join('、') || '无'}`);
    for (const check of a.assemblyChecks) {
      out(`    装配校验 ${check.test}（${check.type} ${check.at}）：${check.status.ok ? '有效' : `失效——${check.status.reason}`}`);
    }
    for (const format of Object.keys(a.formats)) renderClearance(a.formats[format], '    ');
  }
  out(`  可分配新组合：${report.assignable.length === 0 ? '无' : ''}`);
  for (const a of report.assignable) {
    out(`  - 台 ${a.table} ${a.assembly}（台面 ${a.components.board} + 网架 ${a.components.net}）可交检录：${a.clearFor.join('、')}`);
  }
  for (const b of report.blocked) {
    out(`  - 台 ${b.table} ${b.assembly} 暂不可分派：${[...b.why, ...Object.values(b.formats).filter((f) => !f.ok).map((f) => `${f.format} 待复查`)].join('；')}`);
  }
  out('  应交裁判处理的已开始记录：');
  for (const m of report.toReferee) {
    const c = m.components ? `台面 ${m.components.board} + 网架 ${m.components.net}` : '构成未知';
    out(`  - ${m.match}（${m.state}，${m.table} 组合 ${m.assembly}，${c}）：${m.note}`);
  }
}

function renderHistory(history) {
  out(`场次 ${history.match} 历史（赛制 ${history.format ?? '—'}，状态 ${history.status}）——开打时构成已冻结`);
  for (const e of history.events) {
    const c = e.components ? `台面 ${e.components.board} + 网架 ${e.components.net}` : '构成未知';
    out(`  - ${e.at} ${e.state}：${e.table} 组合 ${e.assembly}（${c}）`);
  }
  for (const r of history.reserves) out(`  - ${r.at} 预留：台 ${r.table}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.stage != null) await setStage(options.url, options.stage);
  const pulled = await pullAll(options.url);
  const store = buildStore(pulled.sources);

  const payload = {};
  if (options.command === 'desk' || options.command === 'report') payload.desk = deskBoard(store);
  if (options.command === 'trace' || options.command === 'report') payload.trace = traceReport(store);
  if (options.command === 'matches') {
    payload.matches = [...store.matches.keys()].map((id) => refereeView(store, id)).map((v) => ({ match: v.match, format: v.format, status: v.status }));
  }
  if (options.command === 'referee') payload.referee = refereeView(store, options.args[0]);
  if (options.command === 'history') payload.history = matchHistory(store, options.args[0]);

  if (options.json) {
    console.log(JSON.stringify({ stage: pulled.stage, ...payload }, null, 2));
    return;
  }
  if (payload.desk) {
    renderDesk(payload.desk, pulled.stage);
    out('');
  }
  if (payload.trace) renderTrace(payload.trace);
  if (payload.matches) {
    out('场次一览：');
    for (const m of payload.matches) out(`  - ${m.match}（赛制 ${m.format ?? '—'}，状态 ${m.status}）`);
  }
  if (payload.referee) renderReferee(payload.referee);
  else if (options.command === 'referee') out(`未见场次 ${options.args[0]} 的记录`);
  if (payload.history) renderHistory(payload.history);
  else if (options.command === 'history') out(`未见场次 ${options.args[0]} 的记录`);
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exitCode = 1;
});
