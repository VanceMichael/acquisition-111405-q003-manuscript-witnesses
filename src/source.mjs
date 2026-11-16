// 合作馆校勘来源（source 模式）的领取与解释流程。
// 顺序：/edition -> 各卷 -> 各片段；只沿来源声明的相对链接访问，
// 越界由 transport 拦截。任一后续步骤失败只记录带来源位置的问题，
// 已安全接收的部分照常落库，不把未决读法替换成任何文字。

import {parseFragment, FragmentParseError} from './xml.mjs';
import {buildCatalogs, resolveReference} from './witnesses.mjs';

async function readJson(transport, path, issues, location) {
  let response;
  try {
    response = await transport.request(path);
  } catch (error) {
    issues.push({
      code: 'source-request-failed',
      message: `来源请求失败：${path}（${error.message}）`,
      location: {...location, url: path},
    });
    return null;
  }
  if (!response.ok) {
    issues.push({
      code: 'source-status-error',
      message: `来源返回错误状态 ${response.status}：${path}`,
      location: {...location, url: path, status: response.status},
    });
    return null;
  }
  try {
    return response.json();
  } catch (error) {
    issues.push({
      code: 'source-payload-invalid',
      message: `来源响应不是有效 JSON：${path}（${error.message}）`,
      location: {...location, url: path},
    });
    return null;
  }
}

function asLinkList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是链接数组`);
  const links = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item) throw new Error(`${label} 中存在无效链接`);
    if (!links.includes(item)) links.push(item);
  }
  return links;
}

export async function collectSource(transport) {
  const issues = [];
  const records = [];

  // 第一步：版本目录。它是全部后续步骤的依据，结构无效时没有可独立保留的部分。
  const editionResponse = await transport.request('/edition');
  if (!editionResponse.ok) throw new Error(`校勘版本目录领取失败：${editionResponse.status}`);
  let edition;
  try {
    edition = editionResponse.json();
  } catch (error) {
    throw new Error(`校勘版本目录不是有效 JSON：${error.message}`);
  }
  if (!edition || typeof edition !== 'object' || Array.isArray(edition)) {
    throw new Error('校勘版本目录结构无效');
  }
  let volumeLinks;
  try {
    volumeLinks = asLinkList(edition.volumes, 'volumes');
  } catch (error) {
    throw new Error(`校勘版本目录结构无效：${error.message}`);
  }

  // 第二步：逐卷领取。单卷失败不影响其他卷。
  const volumes = [];
  for (const link of volumeLinks) {
    const payload = await readJson(transport, link, issues, {step: 'volume'});
    if (payload === null) continue;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.scope !== 'string' || !payload.scope.trim()) {
      issues.push({
        code: 'volume-invalid',
        message: `卷响应缺少有效 scope：${link}`,
        location: {step: 'volume', url: link},
      });
      continue;
    }
    let fragmentLinks;
    try {
      fragmentLinks = asLinkList(payload.fragments ?? [], 'fragments');
    } catch (error) {
      issues.push({
        code: 'volume-invalid',
        message: `卷 ${payload.scope} 的 fragments 无效：${error.message}`,
        location: {step: 'volume', scope: payload.scope, url: link},
      });
      continue;
    }
    if (volumes.some(volume => volume.scope === payload.scope)) {
      issues.push({
        code: 'duplicate-scope',
        message: `卷 scope 重复：${payload.scope}`,
        location: {step: 'volume', scope: payload.scope, url: link},
      });
      continue;
    }
    volumes.push({scope: payload.scope, payload, fragmentLinks, url: link});
  }

  const {catalogs, issues: catalogIssues} = buildCatalogs(volumes);
  issues.push(...catalogIssues);

  // 第三步：逐片段领取并解释。片段失败只影响该片段。
  for (const volume of volumes) {
    for (const link of volume.fragmentLinks) {
      let response;
      try {
        response = await transport.request(link);
      } catch (error) {
        issues.push({
          code: 'source-request-failed',
          message: `片段请求失败：${link}（${error.message}）`,
          location: {step: 'fragment', scope: volume.scope, url: link},
        });
        continue;
      }
      if (!response.ok) {
        issues.push({
          code: 'source-status-error',
          message: `片段领取失败，状态 ${response.status}：${link}`,
          location: {step: 'fragment', scope: volume.scope, url: link, status: response.status},
        });
        continue;
      }
      let parsed;
      try {
        parsed = parseFragment(response.text());
      } catch (error) {
        const issue = {
          code: 'fragment-invalid',
          message: `片段无法按校勘 XML 子集解释：${error.message}`,
          location: {step: 'fragment', scope: volume.scope, url: link},
        };
        if (error instanceof FragmentParseError && error.position !== undefined) {
          issue.location.position = error.position;
        }
        issues.push(issue);
        continue;
      }
      records.push(buildRecord(volume.scope, link, parsed, catalogs, issues));
    }
  }

  return {records, issues, evidenceCount: transport.exchanges.length};
}

function buildRecord(scope, url, parsed, catalogs, issues) {
  const segments = [];
  const gaps = [];
  const readings = [];
  const appsById = new Map(parsed.apps.map(app => [app.id, app]));

  for (const run of parsed.runs) {
    if (run.type === 'text') {
      segments.push({text: run.text});
    } else if (run.type === 'gap') {
      // reason/extent 保持来源字符串，不补造对应字符。
      gaps.push({reason: run.reason, extent: run.extent});
    } else if (run.type === 'app') {
      const app = appsById.get(run.id);
      for (const [readingIndex, reading] of app.readings.entries()) {
        const location = {scope, fragment: parsed.fragmentId, app: app.id, reading: readingIndex};
        const witnesses = new Set();
        let unresolved = false;
        for (const refId of reading.refs) {
          const {witnesses: resolved, problems} =
            resolveReference({scope, id: refId}, catalogs);
          for (const witness of resolved) witnesses.add(witness);
          if (problems.length) {
            unresolved = true;
            for (const problem of problems) {
              issues.push({
                ...problem,
                location: {...location, witnessRef: refId, url},
              });
            }
          }
        }
        const entry = {
          app: app.id,
          kind: reading.kind,
          text: reading.text,
          witnesses: [...witnesses].sort(),
          unresolved,
        };
        readings.push(entry);
      }
    }
  }

  return {
    id: `${scope}/${parsed.fragmentId}`,
    kind: 'source-fragment',
    scope,
    fragment: parsed.fragmentId,
    source: url,
    segments,
    gaps,
    readings,
  };
}
