// 合作馆校勘片段的 XML 子集解析器。
// 仅支持契约声明的子集：p(含 xml:id)、app(含 xml:id)、lem/rdg(含 wit)、
// gap(含 reason/extent) 与 XML 五种基础实体；未声明的语法不会被解释为业务事实。

export class FragmentParseError extends Error {
  constructor(message, position) {
    super(position === undefined ? message : `${message}（位置 ${position}）`);
    this.name = 'FragmentParseError';
    this.position = position;
  }
}

const ENTITIES = {lt: '<', gt: '>', amp: '&', apos: "'", quot: '"'};

function decodeEntities(text, position) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z_][a-zA-Z0-9_.-]*);/g, (reference, name) => {
    if (name in ENTITIES) return ENTITIES[name];
    throw new FragmentParseError(`未声明的实体：&${name};`, position);
  });
}

function tokenize(xml) {
  const tokens = [];
  let index = 0;
  const pushText = raw => {
    if (raw === '') return;
    tokens.push({type: 'text', value: decodeEntities(raw, index), position: index});
  };
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      pushText(xml.slice(index));
      break;
    }
    pushText(xml.slice(index, open));
    if (xml.startsWith('<?', open)) {
      const close = xml.indexOf('?>', open + 2);
      if (close === -1) throw new FragmentParseError('XML 声明未闭合', open);
      tokens.push({type: 'declaration', value: xml.slice(open, close + 2), position: open});
      index = close + 2;
      continue;
    }
    const close = xml.indexOf('>', open + 1);
    if (close === -1) throw new FragmentParseError('标签未闭合', open);
    const raw = xml.slice(open + 1, close);
    if (raw.startsWith('!')) throw new FragmentParseError('不支持的 XML 结构（注释/CDATA/DOCTYPE）', open);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!name || /\s/.test(name)) throw new FragmentParseError('结束标签名称无效', open);
      tokens.push({type: 'close', name, position: open});
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const match = body.match(/^([^\s/>]+)([\s\S]*)$/);
      if (!match) throw new FragmentParseError('开始标签名称无效', open);
      const name = match[1];
      const attributes = parseAttributes(match[2], open);
      tokens.push({type: selfClosing ? 'self' : 'open', name, attributes, position: open});
    }
    index = close + 1;
  }
  return tokens;
}

function parseAttributes(source, basePosition) {
  const attributes = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index === source.length) break;
    const start = index;
    while (index < source.length && /[^\s=]/.test(source[index])) index += 1;
    const name = source.slice(start, index);
    if (!name) throw new FragmentParseError('属性名称无效', basePosition + index);
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== '=') throw new FragmentParseError(`属性 ${name} 缺少取值`, basePosition + index);
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") throw new FragmentParseError(`属性 ${name} 必须使用引号`, basePosition + index);
    index += 1;
    const valueStart = index;
    const valueEnd = source.indexOf(quote, index);
    if (valueEnd === -1) throw new FragmentParseError(`属性 ${name} 的取值未闭合`, basePosition + index);
    const value = decodeEntities(source.slice(valueStart, valueEnd), basePosition + valueStart);
    if (name in attributes) throw new FragmentParseError(`属性 ${name} 重复`, basePosition + start);
    attributes[name] = value;
    index = valueEnd + 1;
  }
  return attributes;
}

const ALLOWED = new Set(['p', 'app', 'lem', 'rdg', 'gap']);
const ALLOWED_ATTRIBUTES = {
  p: new Set(['xml:id']),
  app: new Set(['xml:id']),
  lem: new Set(['wit']),
  rdg: new Set(['wit']),
  gap: new Set(['reason', 'extent']),
};

function buildTree(tokens) {
  const root = {name: '#root', children: []};
  const stack = [root];
  let sawDeclaration = false;
  for (const token of tokens) {
    if (token.type === 'declaration') {
      if (stack.length !== 1 || sawDeclaration || root.children.length > 0) {
        throw new FragmentParseError('XML 声明只能出现在文档开头', token.position);
      }
      sawDeclaration = true;
      continue;
    }
    const current = stack[stack.length - 1];
    if (token.type === 'text') {
      current.children.push({name: '#text', value: token.value, position: token.position});
      continue;
    }
    if (token.type === 'close') {
      if (current.name === '#root' || current.name !== token.name) {
        throw new FragmentParseError(`结束标签 </${token.name}> 与开始标签不匹配`, token.position);
      }
      stack.pop();
      continue;
    }
    if (!ALLOWED.has(token.name)) throw new FragmentParseError(`不支持的元素：<${token.name}>`, token.position);
    for (const attribute of Object.keys(token.attributes)) {
      if (!ALLOWED_ATTRIBUTES[token.name].has(attribute)) {
        throw new FragmentParseError(`元素 <${token.name}> 不支持属性 ${attribute}`, token.position);
      }
    }
    const node = {name: token.name, attributes: token.attributes, children: [], position: token.position};
    current.children.push(node);
    if (token.type === 'open') stack.push(node);
  }
  if (stack.length !== 1) throw new FragmentParseError('存在未闭合的标签', stack[stack.length - 1].position);
  return root;
}

function requireAttribute(node, name) {
  const value = node.attributes[name];
  if (typeof value !== 'string' || value === '') {
    throw new FragmentParseError(`元素 <${node.name}> 缺少属性 ${name}`, node.position);
  }
  return value;
}

// 读取 wit 属性中的见证引用；仅接受 #id 形式，返回局部 id 列表。
function parseWit(node) {
  const raw = node.attributes.wit;
  if (raw === undefined) return [];
  const ids = [];
  for (const reference of raw.split(/\s+/)) {
    if (reference === '') continue;
    if (!reference.startsWith('#') || reference.length < 2 || reference.slice(1).includes('#')) {
      throw new FragmentParseError(`见证引用格式无效：${reference}`, node.position);
    }
    ids.push(reference.slice(1));
  }
  return ids;
}

function project(node) {
  const content = {text: '', gaps: [], apps: []};
  for (const child of node.children) {
    if (child.name === '#text') {
      content.text += child.value;
    } else if (child.name === 'gap') {
      if (child.children.length) throw new FragmentParseError('gap 必须为空元素', child.position);
      content.gaps.push({
        reason: requireAttribute(child, 'reason'),
        extent: requireAttribute(child, 'extent'),
      });
    } else if (child.name === 'app') {
      content.apps.push(projectApp(child));
    } else {
      throw new FragmentParseError(`元素 <${node.name}> 内不允许 <${child.name}>`, child.position);
    }
  }
  return content;
}

function projectApp(node) {
  const readings = [];
  for (const child of node.children) {
    if (child.name === '#text') {
      if (child.value.trim() !== '') throw new FragmentParseError('app 内的文本只能是空白', child.position);
      continue;
    }
    if (child.name !== 'lem' && child.name !== 'rdg') {
      throw new FragmentParseError(`app 内不允许元素 <${child.name}>`, child.position);
    }
    if (child.children.some(grand => grand.name !== '#text')) {
      throw new FragmentParseError(`元素 <${child.name}> 只能包含文本`, child.position);
    }
    readings.push({
      kind: child.name,
      text: child.children.map(grand => grand.value).join(''),
      refs: parseWit(child),
    });
  }
  if (readings.length === 0) throw new FragmentParseError('app 至少要包含一个 lem 或 rdg', node.position);
  return {id: requireAttribute(node, 'xml:id'), position: node.position, readings};
}

// 解析单个片段，返回 {fragmentId, runs, apps}：
// runs 按正文顺序记录普通文本与 gap；apps 保留异文位置与读法引用。
export function parseFragment(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') throw new FragmentParseError('片段内容为空');
  const root = buildTree(tokenize(xml));
  for (const child of root.children) {
    if (child.name === '#text' && child.value.trim() !== '') {
      throw new FragmentParseError('片段根元素外不允许文本');
    }
  }
  const elements = root.children.filter(child => child.name !== '#text');
  if (elements.length !== 1 || elements[0].name !== 'p') {
    throw new FragmentParseError('片段根元素必须是单个 p');
  }
  const paragraph = elements[0];
  const fragmentId = requireAttribute(paragraph, 'xml:id');
  const content = project(paragraph);
  const runs = [];
  let plain = '';
  const flush = () => {
    if (plain !== '') {
      runs.push({type: 'text', text: plain});
      plain = '';
    }
  };
  for (const child of paragraph.children) {
    if (child.name === '#text') {
      plain += child.value;
    } else if (child.name === 'gap') {
      flush();
      runs.push({type: 'gap', reason: requireAttribute(child, 'reason'), extent: requireAttribute(child, 'extent')});
    } else if (child.name === 'app') {
      flush();
      runs.push({type: 'app', id: requireAttribute(child, 'xml:id')});
    }
  }
  flush();
  return {fragmentId, runs, apps: content.apps};
}
