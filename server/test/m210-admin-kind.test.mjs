// 2.1.0 管理端：用户列表不再被 100 条和 AI 账号挤掉，并能按真人 / AI 分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../index.mjs';
import {looksLow, localNicknames} from '../nicknames.mjs';

let srv, base, adminTok, seq = 0;
test.before(async () => {
  srv = createApp({adminUsername: 'ops_kind', adminPassword: 'OpsKindPass1'});
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + srv.address().port;
  const login = await call('POST', '/api/admin/auth/login', {username: 'ops_kind', password: 'OpsKindPass1'});
  adminTok = login.j.token;
});
test.after(() => srv.close());

const call = async (m, p, body, tok) => {
  const r = await fetch(base + p, {method: m, headers: {'Content-Type': 'application/json', ...(tok ? {Authorization: 'Bearer ' + tok} : {})}, body: body ? JSON.stringify(body) : undefined});
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = null; }
  return {s: r.status, j, text};
};

test('本地网名不像编号机器人', () => {
  const names = localNicknames(40, () => 0.2);
  assert.equal(names.length, 40);
  for (const n of names) {
    assert.equal(looksLow(n), false, n);
    assert.ok([...n].length >= 2 && [...n].length <= 12, n);
  }
  assert.equal(looksLow('AI_bot_12'), true);
  assert.equal(looksLow('用户10086'), true);
  assert.equal(looksLow('晚风收信'), false);
});

test('旧的 limit=100 不再截断，真人不会被后创建的 AI 挤出列表', async () => {
  for (let i = 0; i < 3; i++) {
    const u = 'real' + (++seq);
    const r = await call('POST', '/api/auth/register', {agree: true, username: u, email: u + '@x.test', password: 'Passw0rd123'});
    assert.equal(r.s, 200, r.text);
  }
  const made = await call('POST', '/api/admin/ai-users', {count: 6, names: ['巷口的灯', '半糖不熬夜', '云边小卖部', '月亮邮递员', '未读的夏天', '橘子海']}, adminTok);
  assert.equal(made.s, 200, made.text);
  assert.equal(made.j.count, 6);
  for (const u of made.j.users) {
    assert.equal(u.kind, 'ai');
    assert.equal(u.isAi, true);
    assert.equal(looksLow(u.displayName), false, u.displayName);
  }

  const all = await call('GET', '/api/admin/users?limit=100', null, adminTok);
  assert.equal(all.s, 200, all.text);
  assert.equal(all.j.truncated, false);
  assert.equal(all.j.limit, null);
  assert.ok(all.j.users.length >= 9);
  assert.equal(all.j.counts.human >= 3, true);
  assert.equal(all.j.counts.ai, 6);
  const firstAi = all.j.users.findIndex(u => u.kind === 'ai');
  const lastHuman = all.j.users.reduce((n, u, i) => u.kind === 'human' ? i : n, -1);
  assert.ok(lastHuman < firstAi, '真人应整体排在 AI 前面');

  const humans = await call('GET', '/api/admin/users?kind=human', null, adminTok);
  assert.ok(humans.j.users.every(u => u.kind === 'human'));
  assert.equal(humans.j.counts.ai, 6);
  const bots = await call('GET', '/api/admin/users?kind=ai', null, adminTok);
  assert.equal(bots.j.users.length, 6);
  assert.ok(bots.j.users.every(u => u.isAi));

  const page = await call('GET', '/api/admin/users?limit=2', null, adminTok);
  assert.equal(page.j.users.length, 2);
  assert.equal(page.j.truncated, true);
  assert.ok(page.j.nextCursor);
});

test('可以把账号改成 AI，并给很假的名字换成网名', async () => {
  const u = 'bot' + (++seq);
  const r = await call('POST', '/api/auth/register', {agree: true, username: u, email: u + '@x.test', password: 'Passw0rd123'});
  assert.equal(r.s, 200, r.text);
  const id = r.j.user.id;
  const marked = await call('POST', '/api/admin/users/' + id + '/kind', {kind: 'ai'}, adminTok);
  assert.equal(marked.s, 200, marked.text);
  assert.equal(marked.j.user.kind, 'ai');
  const renamed = await call('POST', '/api/admin/ai-users/rename', {ids: [id]}, adminTok);
  assert.equal(renamed.s, 200, renamed.text);
  assert.equal(renamed.j.count, 1);
  assert.equal(looksLow(renamed.j.users[0].displayName), false);
  const back = await call('POST', '/api/admin/users/' + id + '/kind', {kind: 'robot'}, adminTok);
  assert.equal(back.s, 400);
  assert.equal(back.j.error.code, 'BAD_KIND');
});
