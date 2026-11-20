// 来源客户端：从演练来源服务分页拉取三路记录。
// 只使用 Node.js 自带的全局 fetch；offset 从零开始，next 为 null 表示末页。

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`GET ${url} 返回 ${response.status}`);
  return response.json();
}

export async function fetchOverview(baseUrl, fetchImpl = fetch) {
  return getJson(new URL('/', baseUrl), fetchImpl);
}

export async function fetchSource(baseUrl, name, fetchImpl = fetch, limit = 100) {
  const records = [];
  let offset = 0;
  while (offset !== null) {
    const url = new URL(`/source/${name}`, baseUrl);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    const page = await getJson(url, fetchImpl);
    records.push(...page.records);
    offset = page.next;
  }
  return records;
}

// 拉取当前回放阶段下三路来源的全部可查记录。
export async function pullAll(baseUrl, fetchImpl = fetch) {
  const overview = await fetchOverview(baseUrl, fetchImpl);
  const sources = {};
  for (const name of overview.sources) {
    sources[name] = await fetchSource(baseUrl, name, fetchImpl);
  }
  return { stage: overview.stage, stages: overview.stages, sources };
}

// 控制员切换回放阶段（演示用；正式运行由控制员操作来源服务）。
export async function setStage(baseUrl, stage, fetchImpl = fetch) {
  const url = new URL('/control', baseUrl);
  url.searchParams.set('stage', String(stage));
  const response = await fetchImpl(url, { method: 'POST' });
  if (!response.ok) throw new Error(`切换回放阶段 ${stage} 失败：${response.status}`);
  return response.json();
}
