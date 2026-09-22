/* eslint-disable no-console */
/**
 * 端到端冒烟脚本：直接以 :memory: 启动服务，
 * 覆盖 fresh / SWR / expired / 单飞 / 幂等 / 304 / Vary / 重置等路径。
 * 用法：npm run smoke
 */
import { buildServer } from '../src/index';
import { FastifyInstance } from 'fastify';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

async function call(
  app: FastifyInstance,
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const res = await app.inject({ method, url, payload: body as any, headers });
  return { status: res.statusCode, json: res.json() };
}

async function main(): Promise<void> {
  const app = buildServer(':memory:');

  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const minute = 60_000;

  console.log('\n[1] 预置与 fresh 命中');
  let r = await call(app, 'POST', '/admin/entries', {
    method: 'GET',
    url: 'https://origin.test/a?b=2&a=1',
    status: 200,
    responseHeaders: { 'cache-control': 'max-age=60', etag: '"v1"' },
    body: 'hello',
    storedAt: T0,
  });
  check('预置返回 201', r.status === 201, r);
  const key = r.json.cacheKeyDetails.cacheKey;
  check('键材料包含方法/URL/Vary', r.json.cacheKeyDetails.keyMaterial.startsWith('METHOD:GET\nURL:https://origin.test/a?a=1&b=2'));

  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/a?a=1&b=2', // query 顺序不同
    virtualTime: T0 + 30 * 1000,
  });
  check('query 乱序仍命中', r.json.state === 'fresh' && r.json.action === 'served', {
    state: r.json.state,
    action: r.json.action,
  });
  check('返回旧响应体与 Age=30', r.json.response.body === 'hello' && r.json.response.headers.age === '30');
  check('fresh 时无令牌', r.json.token === null);

  console.log('\n[2] SWR 窗口：陈旧服务 + 领队令牌');
  r = await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/swr',
    responseHeaders: { 'cache-control': 'max-age=60, stale-while-revalidate=30' },
    body: 'swr-body',
    storedAt: T0,
  });
  check('预置 SWR 条目 201', r.status === 201);
  const swr1 = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/swr',
    virtualTime: T0 + 70 * 1000,
  });
  check('70s 时处于 stale-while-revalidate', swr1.json.state === 'stale-while-revalidate', swr1.json.state);
  check('旧响应被服务且 servedStale=true', swr1.json.response.body === 'swr-body' && swr1.json.servedStale === true);
  check('行动为 served-stale-and-revalidate', swr1.json.action === 'served-stale-and-revalidate');
  check('领队拿到 token', !!swr1.json.token?.leader && !!swr1.json.token.token);
  check('带 Warning 110', swr1.json.response.headers.warning?.startsWith('110'));

  console.log('\n[3] 并发单飞：同键只签发一个令牌，后来者等待');
  const burst = await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      call(app, 'POST', '/cache/request', {
        url: 'https://origin.test/miss',
        virtualTime: T0 + i * minute,
        requestId: `burst-${i}`,
      })
    )
  );
  const leaders = burst.filter((b) => b.json.token?.leader === true);
  const waiters = burst.filter((b) => b.json.action === 'waiting');
  check('5 个并发 miss 只有 1 个领队', leaders.length === 1, leaders.map((l) => l.json.action));
  check('其余 4 个为 waiting', waiters.length === 4);
  check('等待者无 response、不重复回源', waiters.every((w) => w.json.response === null));
  const leaderToken = leaders[0].json.token.token;
  check('等待者都看到同一个令牌', waiters.every((w) => w.json.token.token === leaderToken));

  console.log('\n[4] 令牌校验与幂等提交');
  r = await call(app, 'POST', '/cache/revalidate', {
    token: 'not-a-real-token',
    status: 200,
    headers: { 'cache-control': 'max-age=60' },
    body: 'new',
    originTime: T0 + 5 * minute,
  });
  check('伪造令牌 404', r.status === 404);

  const payload = {
    token: leaderToken,
    status: 200,
    headers: { 'cache-control': 'max-age=60', etag: '"v2"' },
    body: 'new-body',
    originTime: T0 + 5 * minute,
  };
  r = await call(app, 'POST', '/cache/revalidate', payload);
  check('合法提交成功', r.status === 200 && r.json.outcome === 'updated');
  r = await call(app, 'POST', '/cache/revalidate', payload);
  check('相同内容重放 => 幂等', r.status === 200 && r.json.idempotentReplay === true);
  r = await call(app, 'POST', '/cache/revalidate', { ...payload, body: 'different' });
  check('不同内容 => 409', r.status === 409);

  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/miss',
    virtualTime: T0 + 5 * minute + 10 * 1000,
  });
  check('提交后再次判定为 fresh 新响应', r.json.state === 'fresh' && r.json.response.body === 'new-body');

  console.log('\n[5] 过期 + must-revalidate：同步等待，SWR 被禁');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/must',
    responseHeaders: { 'cache-control': 'max-age=60, stale-while-revalidate=300, must-revalidate' },
    body: 'strict',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/must',
    virtualTime: T0 + 90 * 1000,
  });
  check('must-revalidate 下过期 => expired/must-revalidate', r.json.state === 'expired');
  check('不服务陈旧响应', r.json.response === null && r.json.servedStale === false);
  check('行动 must-revalidate', r.json.action === 'must-revalidate');
  await call(app, 'POST', '/cache/tokens/' + r.json.token.token + '/release');

  console.log('\n[6] no-cache + 请求 max-stale 仍强制回源');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/nocache',
    responseHeaders: { 'cache-control': 'no-cache', etag: '"x"' },
    body: 'nc',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/nocache',
    virtualTime: T0 + 999 * minute,
    headers: { 'cache-control': 'max-stale=9999' },
  });
  check('no-cache 优先于 max-stale，需回源', r.json.state === 'expired' && r.json.action === 'must-revalidate');
  const ncToken = r.json.token.token;
  check('令牌携带 If-None-Match', r.json.token.conditionalRequest['if-none-match'] === '"x"');

  console.log('\n[7] 304 回源：合并头、沿用 body 与状态码');
  r = await call(app, 'POST', '/cache/revalidate', {
    token: ncToken,
    status: 304,
    headers: { 'cache-control': 'max-age=120', etag: '"x2"' },
    originTime: T0 + 999 * minute,
  });
  check('304 合并成功', r.status === 200 && r.json.outcome === 'not_modified_merged');
  check('body 沿用旧响应', r.json.entry.body === 'nc');
  check('新头覆盖旧头', r.json.entry.responseHeaders['cache-control'] === 'max-age=120');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/nocache',
    virtualTime: T0 + 999 * minute + 30 * 1000,
  });
  check('合并后 fresh', r.json.state === 'fresh');

  console.log('\n[8] Vary：同一 URL 按请求头区分缓存');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/v',
    requestHeaders: { 'accept-encoding': 'gzip' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding' },
    body: 'gzipped',
    storedAt: T0,
  });
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/v',
    requestHeaders: { 'accept-encoding': 'br' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding' },
    body: 'brotli',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    method: 'HEAD',
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('HEAD 复用 GET 变体存储，命中且抑制 body', r.json.state === 'fresh' && r.json.response.body === null && r.json.response.bodySuppressedForHead === true);
  check('HEAD 轨迹含方法映射说明', r.json.trail.some((t: any) => t.step === 'method-mapping'));
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('gzip 变体命中', r.json.response.body === 'gzipped');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('br 变体命中', r.json.response.body === 'brotli');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'zstd' },
    virtualTime: T0,
  });
  check('未知变体 miss', r.json.state === 'miss');
  check('轨迹含 Vary 选择值', r.json.trail.some((t: any) => t.step === 'key'));

  console.log('\n[9] 请求侧指令：min-fresh / max-stale / only-if-cached / no-store');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/mf',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'mf',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/mf',
    headers: { 'cache-control': 'min-fresh=40' },
    virtualTime: T0 + 30 * 1000,
  });
  check('剩余 30s 不满足 min-fresh=40 => 必须回源', r.json.state === 'expired' && r.json.action === 'must-revalidate');
  const tok = r.json.token.token;
  await call(app, 'POST', '/cache/tokens/' + tok + '/release');

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/ms',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'ms',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/ms',
    headers: { 'cache-control': 'max-stale=600' },
    virtualTime: T0 + 120 * 1000,
  });
  check('max-stale 容忍陈旧直接服务、不回源', r.json.state === 'stale' && r.json.token === null && r.json.servedStale === true);

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/oic',
    responseHeaders: { 'cache-control': 'max-age=1' },
    body: 'oic',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/oic-missing',
    headers: { 'cache-control': 'only-if-cached' },
    virtualTime: T0,
  });
  check('only-if-cached 未命中 => gateway-timeout 语义', r.json.state === 'gateway-timeout');
  check('不签发令牌', r.json.token === null);
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/oic',
    headers: { 'cache-control': 'only-if-cached' },
    virtualTime: T0 + 999 * minute,
  });
  check('only-if-cached 对陈旧副本也直接返回不回源', r.json.state === 'stale' && r.json.token === null);

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/ns',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'ns',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/ns',
    headers: { 'cache-control': 'no-store' },
    virtualTime: T0,
  });
  check('no-store => bypass', r.json.state === 'bypass');

  console.log('\n[10] 寿命来源：Expires 与启发式');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/exp',
    responseHeaders: { expires: 'Thu, 01 Jan 2026 00:01:00 GMT' },
    body: 'e',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/exp', virtualTime: T0 + 59 * 1000 });
  check('Expires 59s 内 fresh', r.json.state === 'fresh');

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/heur',
    responseHeaders: { 'last-modified': '2025-12-31T22:40:00Z' },
    body: 'h',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/heur', virtualTime: T0 + 7 * 60 * 1000 });
  check('启发式 10%×80min=8min，7min 时 fresh', r.json.state === 'fresh', r.json.numbers);
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/heur', virtualTime: T0 + 9 * 60 * 1000 });
  check('9min 时 expired', r.json.state === 'expired');

  console.log('\n[11] X-Virtual-Time 头与解释轨迹');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/hdr',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'hdr',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/hdr' }, {
    'x-virtual-time': new Date(T0).toISOString(),
  });
  check('支持 X-Virtual-Time 头', r.status === 200 && r.json.state === 'fresh');
  check('轨迹覆盖 normalize/key/lookup/age/lifetime/freshness', [
    'normalize', 'key', 'lookup', 'age', 'lifetime', 'freshness',
  ].every((s) => r.json.trail.some((t: any) => t.step === s)));

  console.log('\n[12] 决策日志与统计');
  r = await call(app, 'GET', '/cache/stats');
  check('stats 有 entries 计数', r.json.entries > 0 && r.json.decisions > 0);
  r = await call(app, 'GET', '/cache/decisions?limit=3');
  check('decision_logs 可取最近 3 条', r.json.decisions.length === 3);

  console.log('\n[13] 重置端点');
  r = await call(app, 'POST', '/admin/reset');
  check('reset 200 且计数归零', r.status === 200 && r.json.stats.entries === 0 && r.json.stats.pendingTokens === 0);
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/a', virtualTime: T0 });
  check('重置后旧键 miss', r.json.state === 'miss');

  console.log('\n[14] 参数校验');
  r = await call(app, 'POST', '/cache/request', { url: 'not-a-url', virtualTime: T0 });
  check('坏 URL => 400', r.status === 400);
  r = await call(app, 'POST', '/cache/request', { url: 'https://x.test/' });
  check('缺虚拟时间 => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/entries', {
    url: 'https://x.test/',
    storedAt: T0,
    responseHeaders: { vary: '*' },
  });
  check('Vary: * 预置被拒', r.status === 400);

  console.log('\n[15] 条件失效：dryRun 预览（不改动数据）');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'gzip' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding', etag: '"g1"' },
    body: 'gzip-body',
    storedAt: T0,
  });
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'br' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding', etag: '"b1"' },
    body: 'br-body',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    dryRun: true,
    reason: 'deploy-1234',
  });
  check('dryRun 返回 200 且带 dryRun 标志与 recordId', r.status === 200 && r.json.dryRun === true && typeof r.json.recordId === 'number');
  check('dryRun 结果为 preview', r.json.outcome === 'preview');
  check('affected 精确指向 gzip 变体且 disposition=would-delete',
    r.json.affected.length === 1 && r.json.affected[0].disposition === 'would-delete' &&
    r.json.affected[0].etag === '"g1"' && r.json.affected[0].cacheKey !== undefined);
  check('br 变体出现在 skipped 且原因 variant-not-selected',
    r.json.skipped.length === 1 && r.json.skipped[0].reason === 'variant-not-selected' &&
    r.json.skipped[0].etag === '"b1"');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('dryRun 后 gzip 变体仍然命中', r.json.state === 'fresh' && r.json.response.body === 'gzip-body');

  console.log('\n[16] 条件失效：ETag 守卫');
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'gzip' },
    expectedEtag: '"stale-etag"',
  });
  check('ETag 不符 => noop 且跳过原因 etag-mismatch',
    r.json.outcome === 'noop' && r.json.counts.deletedEntries === 0 &&
    r.json.skipped.some((s: any) => s.reason === 'etag-mismatch'));
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('ETag 不符时条目未被删除', r.json.state === 'fresh');
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'gzip' },
    etag: 'g1', // 裸 ETag 自动补引号
  });
  check('ETag 相符 => invalidated，删除 1 条', r.json.outcome === 'invalidated' && r.json.counts.deletedEntries === 1);
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('gzip 变体已删除 => miss', r.json.state === 'miss');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('br 兄弟变体不受影响，仍命中', r.json.state === 'fresh' && r.json.response.body === 'br-body');

  console.log('\n[17] 条件失效：释放该键 pending 回源令牌');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0 + 999 * minute,
  });
  check('br 变体过期，领队拿到 pending 令牌', r.json.token?.leader === true);
  const invPendingToken = r.json.token.token;

  // 正式执行前先 dryRun：应预览 would-delete / would-release 但不动任何数据
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'br' },
    dryRun: true,
  });
  check('dryRun 显示 would-delete 与 would-release，实际不动数据',
    r.json.outcome === 'preview' &&
    r.json.affected[0].disposition === 'would-delete' &&
    r.json.releasedTokens.some((t: any) => t.disposition === 'would-release' && t.token === invPendingToken) &&
    r.json.counts.deletedEntries === 0 && r.json.counts.releasedTokens === 0);
  r = await call(app, 'GET', '/cache/tokens?limit=5');
  check('dryRun 后 pending 令牌仍然存在',
    r.json.tokens.some((t: any) => t.token === invPendingToken && t.status === 'pending'));
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0 + 999 * minute,
  });
  check('dryRun 后再来请求仍是加入者（令牌未被释放）', r.json.token?.leader === false &&
    r.json.token.token === invPendingToken);

  // 正式执行：删除 br 变体并在同一事务内释放 pending 令牌
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'br' },
    reason: 'purge-brotli-variant',
  });
  check('正式失效删除 br 变体并释放 1 个 pending 令牌',
    r.json.outcome === 'invalidated' && r.json.counts.deletedEntries === 1 &&
    r.json.counts.releasedTokens === 1 &&
    r.json.releasedTokens[0].token === invPendingToken &&
    r.json.releasedTokens[0].disposition === 'released');
  r = await call(app, 'GET', '/cache/tokens?all=1&limit=20');
  check('被释放的令牌状态为 released',
    r.json.tokens.some((t: any) => t.token === invPendingToken && t.status === 'released'));
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0 + 999 * minute,
  });
  check('条目已删、令牌已释放 => miss 并签发全新令牌（领队）',
    r.json.state === 'miss' && r.json.token?.leader === true &&
    r.json.token.token !== invPendingToken);

  console.log('\n[18] 条件失效：HEAD 映射、未知 URL 与参数校验');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/head-inv',
    responseHeaders: { 'cache-control': 'max-age=60', etag: '"h1"' },
    body: 'head-body',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/admin/invalidate', {
    method: 'HEAD',
    url: 'https://origin.test/head-inv',
  });
  check('HEAD 按 GET 键失效，target.keyMethod=GET', r.json.outcome === 'invalidated' &&
    r.json.target.keyMethod === 'GET' && r.json.counts.deletedEntries === 1);
  r = await call(app, 'POST', '/cache/request', {
    method: 'HEAD',
    url: 'https://origin.test/head-inv',
    virtualTime: T0,
  });
  check('HEAD 失效后 miss', r.json.state === 'miss');

  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/no-such-resource',
  });
  check('未知 URL => 200 noop，affected/skipped 均为空',
    r.status === 200 && r.json.outcome === 'noop' &&
    r.json.affected.length === 0 && r.json.skipped.length === 0);

  r = await call(app, 'POST', '/admin/invalidate', { requestHeaders: {} });
  check('缺 url => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    dryRun: 'yes',
  });
  check('dryRun 非布尔 => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/invalidate', { url: 'ftp://origin.test/x' });
  check('非 http(s) URL => 400', r.status === 400);

  console.log('\n[19] 条件失效审计记录');
  r = await call(app, 'GET', '/admin/invalidations?limit=100');
  const records = r.json.invalidations;
  check('审计记录可取（含正式与 dryRun）',
    records.length >= 7 &&
    records.some((x: any) => x.dryRun === true && x.outcome === 'preview') &&
    records.some((x: any) => x.dryRun === false && x.outcome === 'invalidated') &&
    records.some((x: any) => x.outcome === 'noop'));
  const inv = records.find((x: any) => x.outcome === 'invalidated' && x.releasedTokenCount === 1);
  check('审计记录可追溯：含请求头/受影响键/释放令牌/reason',
    inv && inv.normalizedUrl === 'https://origin.test/inv' &&
    inv.requestHeaders['accept-encoding'] === 'br' &&
    inv.affected.length === 1 && inv.affected[0].etag === '"b1"' &&
    inv.reason === 'purge-brotli-variant' &&
    inv.releasedTokens[0] === invPendingToken);
  r = await call(app, 'POST', '/admin/reset');
  check('reset 清空失效记录', r.status === 200);
  r = await call(app, 'GET', '/admin/invalidations');
  check('reset 后审计记录为空', r.json.invalidations.length === 0);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await app.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
