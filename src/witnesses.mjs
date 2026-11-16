// 卷内见证目录与见证组解析。
// 见证按 scope 隔离：相同局部 id 在不同卷中是不同见证，绝不全局合并。
// group 可嵌套并通过 {scope,id} 引用其他卷的定义；缺失定义与循环引用
// 会被显式报告，由调用方把受影响的读法标记为未决。

// 汇总各卷的见证目录，返回按 scope 索引的目录与目录级问题。
export function buildCatalogs(volumes) {
  const catalogs = new Map();
  const issues = [];
  for (const volume of volumes) {
    const {scope} = volume;
    if (catalogs.has(scope)) {
      issues.push({
        code: 'duplicate-scope',
        message: `卷 scope 重复：${scope}`,
        location: {scope},
      });
      continue;
    }
    const catalog = new Map();
    const witnesses = volume.payload?.witnesses;
    if (witnesses && (typeof witnesses !== 'object' || Array.isArray(witnesses))) {
      issues.push({
        code: 'invalid-witness-catalog',
        message: `卷 ${scope} 的 witnesses 必须是按 id 索引的对象`,
        location: {scope},
      });
    } else if (witnesses) {
      for (const [id, definition] of Object.entries(witnesses)) {
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
          issues.push({
            code: 'invalid-witness-definition',
            message: `见证 ${scope}/${id} 的定义不是对象`,
            location: {scope, witness: id},
          });
          continue;
        }
        if (definition.kind === 'person') {
          catalog.set(id, {kind: 'person'});
        } else if (definition.kind === 'group') {
          if (!Array.isArray(definition.members)) {
            issues.push({
              code: 'invalid-group-members',
              message: `见证组 ${scope}/${id} 缺少 members 列表`,
              location: {scope, witness: id},
            });
          }
          catalog.set(id, {kind: 'group', members: Array.isArray(definition.members) ? definition.members : []});
        } else {
          issues.push({
            code: 'unknown-witness-kind',
            message: `见证 ${scope}/${id} 的 kind 不受支持：${String(definition.kind)}`,
            location: {scope, witness: id},
          });
        }
      }
    }
    catalogs.set(scope, catalog);
  }
  return {catalogs, issues};
}

function memberKey(member, ownerScope, position) {
  if (typeof member === 'string') return {scope: ownerScope, id: member};
  if (member && typeof member === 'object' && !Array.isArray(member) &&
    typeof member.scope === 'string' && member.scope &&
    typeof member.id === 'string' && member.id) {
    return {scope: member.scope, id: member.id};
  }
  const error = new Error(`见证组成员引用无效：${JSON.stringify(member)}`);
  error.position = position;
  throw error;
}

// 解析一个见证引用（来自 wit="#id"，默认属于本卷 scope）。
// 返回 {witnesses: 已解析的完整 scope/id 键（字典序、去重）, problems: 未决问题}。
export function resolveReference({scope, id}, catalogs) {
  const witnesses = new Set();
  const problems = [];
  const walk = (reference, path) => {
    const key = `${reference.scope}/${reference.id}`;
    const nextPath = [...path, key];
    if (path.includes(key)) {
      problems.push({
        code: 'witness-cycle',
        message: `见证组存在循环引用：${nextPath.join(' -> ')}`,
        reference,
        path: nextPath,
      });
      return;
    }
    const catalog = catalogs.get(reference.scope);
    if (!catalog) {
      problems.push({
        code: 'witness-scope-missing',
        message: `引用了未接收卷的见证：${key}`,
        reference,
        path: nextPath,
      });
      return;
    }
    const definition = catalog.get(reference.id);
    if (!definition) {
      problems.push({
        code: 'witness-definition-missing',
        message: `见证定义缺失：${key}`,
        reference,
        path: nextPath,
      });
      return;
    }
    if (definition.kind === 'person') {
      witnesses.add(key);
      return;
    }
    definition.members.forEach((member, index) => {
      let target;
      try {
        target = memberKey(member, reference.scope);
      } catch (error) {
        problems.push({
          code: 'invalid-group-member',
          message: error.message,
          reference,
          path: nextPath,
          memberIndex: index,
        });
        return;
      }
      walk(target, nextPath);
    });
  };
  walk({scope, id}, []);
  return {witnesses: [...witnesses].sort(), problems};
}
