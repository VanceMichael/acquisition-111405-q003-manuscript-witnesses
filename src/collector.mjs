import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {collectSource} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  const transport = createTransport(baseUrl);
  if (mode === 'legacy') {
    const response = await transport.request('/legacy');
    if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
    const records = [normalizeLegacy(response.json())];
    await archive.commit({records, exchanges: transport.exchanges});
    return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
  }
  if (mode !== 'source') throw new Error(`不支持的来源模式：${mode}`);
  const {records, issues} = await collectSource(transport);
  // 未决资料同样落库进入待核对清单；原文证据与问题一并归档。
  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete: issues.length === 0, issues, evidenceCount: transport.exchanges.length};
}
