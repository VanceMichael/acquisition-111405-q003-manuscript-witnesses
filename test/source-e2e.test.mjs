import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

function startLocal(routes) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = routes[url.pathname];
    if (!route) {
      response.writeHead(404, {'content-type': 'text/plain'}).end('未声明');
      return;
    }
    if (route.status && route.status !== 200) {
      response.writeHead(route.status, {'content-type': 'text/plain'}).end('错误');
      return;
    }
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    response.writeHead(200, {'content-type': route.type ?? 'application/json'}).end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(done => { server.close(done); server.closeAllConnections(); })});
    });
  });
}

const goodVolume = {
  scope: 'A',
  witnesses: {w1: {kind: 'person'}},
  fragments: ['/frag/ok'],
};
const goodFragment = '<p xml:id="p1">山<app xml:id="a1"><rdg wit="#w1">川</rdg></app></p>';

test('端到端：卷失败时其他卷与已收片段保留，complete=false 且问题带位置', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: ['/vol/a', '/vol/b']}},
    '/vol/a': {body: goodVolume},
    '/vol/b': {status: 500},
    '/frag/ok': {type: 'text/plain; charset=utf-8', body: goodFragment},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].id, 'A/p1');
    assert.ok(result.issues.some(issue => issue.code === 'source-status-error' && issue.location.status === 500));
    assert.ok(result.evidenceCount >= 3, '实际接收的原文都计数');
    const persisted = await openArchive(directory);
    assert.equal(persisted.snapshot().records.length, 1);
    assert.equal(persisted.snapshot().issues.length, result.issues.length);
    assert.equal(persisted.snapshot().evidence.length, result.evidenceCount);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：片段 404 与不可解释的 XML 只影响对应片段', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: ['/vol/a']}},
    '/vol/a': {body: {scope: 'A', witnesses: {w1: {kind: 'person'}},
      fragments: ['/frag/ok', '/frag/missing', '/frag/bad']}},
    '/frag/ok': {type: 'text/plain', body: goodFragment},
    '/frag/bad': {type: 'text/plain', body: '<p xml:id="p2"><unknown/></p>'},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    assert.deepEqual(result.records.map(record => record.fragment), ['p1']);
    const codes = result.issues.map(issue => issue.code).sort();
    assert.ok(codes.includes('fragment-invalid'));
    assert.ok(codes.includes('source-status-error'));
    assert.ok(result.issues.every(issue => issue.location?.scope === 'A'));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：缺失见证定义使该读法未决，已解析见证保留且不顶替文字', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: ['/vol/a']}},
    '/vol/a': {body: {scope: 'A', witnesses: {
      w1: {kind: 'person'},
      g: {kind: 'group', members: ['w1', 'ghost']},
    }, fragments: ['/frag/ok']}},
    '/frag/ok': {type: 'text/plain',
      body: '<p xml:id="p1"><app xml:id="a1"><lem wit="#w1">川</lem><rdg wit="#g">河</rdg></app></p>'},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    const [lem, rdg] = result.records[0].readings;
    assert.equal(lem.unresolved, false);
    assert.deepEqual(lem.witnesses, ['A/w1']);
    assert.equal(rdg.unresolved, true);
    assert.equal(rdg.text, '河', '未决读法保留来源文字，不替换成 lem');
    assert.deepEqual(rdg.witnesses, ['A/w1']);
    assert.ok(result.issues.some(issue => issue.code === 'witness-definition-missing'
      && issue.location.app === 'a1' && issue.location.reading === 1));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：越界链接不发请求并记问题，同批安全片段仍落库', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: ['/vol/a']}},
    '/vol/a': {body: {scope: 'A', witnesses: {w1: {kind: 'person'}},
      fragments: ['/frag/ok', 'https://example.invalid/frag']}},
    '/frag/ok': {type: 'text/plain', body: goodFragment},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    const issue = result.issues.find(item => item.code === 'source-request-failed');
    assert.ok(issue, '越界作为可复核问题保留');
    assert.match(issue.message, /越界/);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：空的有效领取与错误状态区分，空卷集合声明为完整', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: []}},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.issues, []);
    assert.equal(result.complete, true);
    assert.equal(result.evidenceCount, 1, 'edition 原文仍作为证据保留');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：重复领取同内容不新增修订，问题与证据持久化可重新打开', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: ['/vol/a']}},
    '/vol/a': {body: {scope: 'A', witnesses: {}, fragments: ['/frag/ok']}},
    '/frag/ok': {type: 'text/plain',
      body: '<p xml:id="p1"><app xml:id="a1"><rdg wit="#w1">河</rdg></app></p>'},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    const archive = await openArchive(directory);
    const first = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    assert.equal(first.complete, false);
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const reopened = await openArchive(directory);
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.records.length, 1, '相同业务修订不重复入库');
    assert.equal(snapshot.records[0].id, 'A/p1');
    assert.equal(snapshot.evidence.length, first.evidenceCount, '相同原文内容寻址不重复');
    assert.ok(snapshot.issues.length >= first.issues.length);
    const evidence = snapshot.evidence[0];
    assert.equal((await reopened.raw(evidence.hash)).toString('utf8').includes('volumes'), true);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：edition 结构性失败直接报错，不伪造来源成功', async () => {
  const source = await startLocal({
    '/edition': {body: {volumes: '/vol/a'}},
  });
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  try {
    await assert.rejects(
      collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'}),
      /版本目录结构无效/
    );
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
