// Прогон ИИ-анализа звонков по заказчикам из консоли (паритет с прототипом 22.10, отладка промпта).
//   node --env-file=.env.local --experimental-strip-types --import ./scripts/ts-resolve-register.mjs \
//     scripts/ai-analysis-run.ts <out-dir> c204214 k36958 …
// --effort low|high|max: глубина «размышлений» модели (low — в разы дешевле).
// --dry <reports-dir>: без запроса к модели — сбор, обезличивание и проверка цитат по готовым отчётам
//   (<reports-dir>/<ref>.md), денег не тратит.
// Локально БД sa — через туннель владельца: SA_PG_HOST=127.0.0.1 SA_PG_PORT=15432.
import fs from 'node:fs';
import path from 'node:path';
import type { ClientRef } from '../features/client-module/engine/types.ts';
import { collectClientData } from '../features/ai-analysis/engine/collect.ts';
import { userContent } from '../features/ai-analysis/engine/prompt.ts';
import { analyzeClient, splitSections } from '../features/ai-analysis/engine/analyze.ts';
import { verifyQuotes } from '../features/ai-analysis/engine/verify.ts';
import { DEFAULT_REASONING_EFFORT } from '../features/ai-analysis/engine/llm.ts';

const args = process.argv.slice(2);
const dryIdx = args.indexOf('--dry');
const dryDir = dryIdx >= 0 ? args.splice(dryIdx, 2)[1] : null;
const effIdx = args.indexOf('--effort');
const effort = effIdx >= 0 ? args.splice(effIdx, 2)[1] as 'low' | 'high' | 'max' : undefined;
const [outDir, ...refs] = args;
if (!outDir || !refs.length) { console.error('usage: ai-analysis-run.ts [--dry <reports-dir>] <out-dir> <ref>…'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

for (const ref of refs as ClientRef[]) {
  const t0 = Date.now();
  try {
    if (dryDir) {
      const data = await collectClientData(ref);
      const { text, maskHits } = userContent(data);
      fs.writeFileSync(path.join(outDir, `${ref}.input.md`), text);
      const report = fs.readFileSync(path.join(dryDir, `${ref}.md`), 'utf8');
      const quotes = verifyQuotes(report, data.calls, data.deals);
      const ok = quotes.filter(q => q.found).length, refs = quotes.filter(q => q.kind === 'reference').length;
      console.log(`${ref}: сделок ${data.deals.length}, звонков ${data.callsTotal} (в анализе ${data.calls.length}, отрезано ${data.callsTrimmed}), ${text.length} симв., ПДн ${JSON.stringify(maskHits)}, разделов ${Object.keys(splitSections(report)).length}, цитат ${ok}/${quotes.length - refs} найдено (+${refs} справочных), ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      for (const f of data.facts) console.log(`   факт: ${f}`);
      for (const q of quotes.filter(x => !x.found && x.kind === 'call')) console.log(`   ⚠ ${q.score} «${q.quote.slice(0, 80)}»`);
      continue;
    }
    const r = await analyzeClient(ref, { reasoningEffort: effort, onProgress: p => process.stdout.write(`\r${ref}: ${p.phase}${'reasoningChars' in p ? ` ${p.reasoningChars}` : ''}   `) });
    fs.writeFileSync(path.join(outDir, `${ref}.md`), `<!-- ${r.llm.model} | ${r.promptVersion} | effort=${effort ?? DEFAULT_REASONING_EFFORT} | ${r.llm.seconds}s | ${r.llm.costRub} ₽ | ${JSON.stringify(r.llm.usage)} -->\n${r.llm.content}`);
    const ok = r.quotes.filter(q => q.found).length;
    console.log(`\n${ref}: ${r.llm.seconds} с, ${r.llm.costRub} ₽, разделов ${Object.keys(r.sections).length}, цитат ${ok}/${r.quotes.length}, ПДн ${JSON.stringify(r.maskHits)}`);
  } catch (e) {
    console.log(`${ref}: ОШИБКА ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(0);
