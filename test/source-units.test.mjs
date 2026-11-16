import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFragment, FragmentParseError} from '../src/xml.mjs';
import {buildCatalogs, resolveReference} from '../src/witnesses.mjs';

test('XML：五种基础实体在文本与属性中解码，其他实体拒绝', () => {
  const parsed = parseFragment(
    '<p xml:id="p&amp;1">a&lt;b&apos;c&gt;d&quot;e<gap reason="lost &amp; cut" extent="2"/></p>'
  );
  assert.equal(parsed.fragmentId, 'p&1');
  assert.deepEqual(parsed.runs, [
    {type: 'text', text: 'a<b\'c>d"e'},
    {type: 'gap', reason: 'lost & cut', extent: '2'},
  ]);
  assert.throws(
    () => parseFragment('<p xml:id="p1">&#160;</p>'),
    error => error instanceof FragmentParseError && /未声明的实体/.test(error.message)
  );
  assert.throws(
    () => parseFragment('<p xml:id="p1">&unknown;</p>'),
    error => error instanceof FragmentParseError && /未声明的实体/.test(error.message)
  );
});

test('XML：未声明的元素与属性不会被解释成业务事实', () => {
  assert.throws(() => parseFragment('<p xml:id="p1"><note>x</note></p>'), /不支持的元素/);
  assert.throws(() => parseFragment('<p xml:id="p1" type="main">x</p>'), /不支持属性/);
  assert.throws(() => parseFragment('<p xml:id="p1"><!-- c --></p>'), /不支持的 XML 结构/);
  assert.throws(() => parseFragment('<p xml:id="p1"><![CDATA[x]]></p>'), /不支持的 XML 结构/);
  assert.throws(() => parseFragment('<p xml:id="p1">x'), /未闭合/);
  assert.throws(() => parseFragment('<p xml:id="p1">x</rdg>'), /不匹配/);
  assert.throws(() => parseFragment('<p>x</p>'), /缺少属性 xml:id/);
  assert.throws(() => parseFragment(''), /片段内容为空/);
  assert.throws(() => parseFragment('<p xml:id="p1">x</p><p xml:id="p2">y</p>'), /根元素必须是单个 p/);
});

test('XML：gap 必须带 reason 与 extent，且不能有内容', () => {
  assert.throws(() => parseFragment('<p xml:id="p1"><gap reason="lost"/></p>'), /缺少属性 extent/);
  assert.throws(() => parseFragment('<p xml:id="p1"><gap extent="2"/></p>'), /缺少属性 reason/);
  assert.throws(() => parseFragment('<p xml:id="p1"><gap reason="lost" extent="2">x</gap></p>'), /必须为空元素/);
});

test('XML：wit 只接受空白分隔的 #id 引用', () => {
  assert.throws(
    () => parseFragment('<p xml:id="p1"><app xml:id="a1"><rdg wit="w1">x</rdg></app></p>'),
    /见证引用格式无效/
  );
  assert.throws(
    () => parseFragment('<p xml:id="p1"><app xml:id="a1"><rdg wit="https://x#w1">x</rdg></app></p>'),
    /见证引用格式无效/
  );
  const parsed = parseFragment(
    '<p xml:id="p1"><app xml:id="a1"><rdg wit="  #w1  #w2 ">x</rdg></app></p>'
  );
  assert.deepEqual(parsed.apps[0].readings[0].refs, ['w1', 'w2']);
});

test('XML：连续普通文本合并为一个 segment，顺序在 runs 中保留', () => {
  const parsed = parseFragment(
    '<p xml:id="p1">山<app xml:id="a1"><lem wit="#w1">川</lem></app>河<gap reason="lost" extent="1"/>海</p>'
  );
  assert.deepEqual(parsed.runs.map(run => run.type), ['text', 'app', 'text', 'gap', 'text']);
});

test('XML：空 app 被拒绝；空白片段不丢字符也不伪造异文', () => {
  const blank = parseFragment('<p xml:id="p1">   </p>');
  assert.deepEqual(blank.runs, [{type: 'text', text: '   '}]);
  assert.deepEqual(blank.apps, []);
  assert.throws(() => parseFragment('<p xml:id="p1"><app xml:id="a1"> </app></p>'), /至少要包含一个/);
});

test('XML：合法声明可接受，位置错误的声明被拒绝', () => {
  const parsed = parseFragment('<?xml version="1.0" encoding="UTF-8"?><p xml:id="p1">x</p>');
  assert.equal(parsed.fragmentId, 'p1');
  assert.throws(() => parseFragment('<p xml:id="p1"><?xml version="1.0"?></p>'), /不支持的 XML 结构|XML 声明/);
});

test('见证：相同局部 id 跨卷保留不同身份，组可跨卷嵌套', () => {
  const {catalogs} = buildCatalogs([
    {scope: 'A', payload: {witnesses: {
      w1: {kind: 'person'},
      g1: {kind: 'group', members: ['w1', {scope: 'B', id: 'g2'}]},
    }}},
    {scope: 'B', payload: {witnesses: {
      w1: {kind: 'person'},
      g2: {kind: 'group', members: ['w1']},
    }}},
  ]);
  const {witnesses, problems} = resolveReference({scope: 'A', id: 'g1'}, catalogs);
  assert.deepEqual(witnesses, ['A/w1', 'B/w1']);
  assert.deepEqual(problems, []);
});

test('见证：缺失定义、未知 scope、无效成员均产生问题且不伪造见证', () => {
  const {catalogs} = buildCatalogs([
    {scope: 'A', payload: {witnesses: {
      person1: {kind: 'person'},
      group: {kind: 'group', members: ['missing', {scope: 'Z', id: 'x'}, 42]},
    }}},
  ]);
  const {witnesses, problems} = resolveReference({scope: 'A', id: 'group'}, catalogs);
  assert.deepEqual(witnesses, []);
  assert.deepEqual(problems.map(problem => problem.code).sort(),
    ['invalid-group-member', 'witness-definition-missing', 'witness-scope-missing']);
});

test('见证：多层嵌套中的循环引用被检出，同路径上的有效成员仍保留', () => {
  const {catalogs} = buildCatalogs([
    {scope: 'A', payload: {witnesses: {
      p: {kind: 'person'},
      g1: {kind: 'group', members: ['p', 'g2']},
      g2: {kind: 'group', members: ['g1']},
    }}},
  ]);
  const {witnesses, problems} = resolveReference({scope: 'A', id: 'g1'}, catalogs);
  assert.deepEqual(witnesses, ['A/p']);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'witness-cycle');
  assert.deepEqual(problems[0].path, ['A/g1', 'A/g2', 'A/g1']);
});

test('见证：重复 scope 与不合法的目录结构进入问题清单', () => {
  const {issues} = buildCatalogs([
    {scope: 'A', payload: {witnesses: {w1: {kind: 'person'}}}},
    {scope: 'A', payload: {witnesses: {w1: {kind: 'person'}}}},
    {scope: 'B', payload: {witnesses: []}},
  ]);
  assert.ok(issues.some(issue => issue.code === 'duplicate-scope'));
  assert.ok(issues.some(issue => issue.code === 'invalid-witness-catalog'));
});
