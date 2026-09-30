import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../guard';
import { loadCallLogistMap, loadCallList } from '@/lib/realizations/data';
import { callAttribution, callDrillWhere, isCallMetric, maskPhone, isAnsweredCode, SHORT_CALL_SEC } from '@/lib/realizations/callMetrics';
import { logistDisplayName } from '@/features/reports/engine/realizationLogists';
import { REGIONS, type Region } from '@/lib/realizations/region';
import { mskYmd } from '@/lib/realizations/period';

// Дриллдаун группы «Звонки» сводки логистов (задача #8314): звонки строки за период.
// logist — id логистов 1С через запятую, region — код региона, без обоих — все логисты.
// metricId — колонка ячейки: список = население числа (callDrillWhere).
// Номер телефона — ПДн: наружу уходят только последние 4 цифры, записи и тексты — нет.
export const maxDuration = 60;

export interface CallDrillItem {
  id: string; startedAt: string; direction: 'inbound' | 'outbound' | string; phone: string | null;
  durationSec: number | null; answered: boolean; short: boolean; failedReason: string | null;
  transcription: string | null; logist: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const from = new Date(sp.get('from') ?? '');
  const to = new Date(sp.get('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  const logistIds = (sp.get('logist') ?? '').split(',').filter(Boolean);
  if (logistIds.some(x => !UUID.test(x))) return NextResponse.json({ error: 'Некорректный логист' }, { status: 400 });
  const region = sp.get('region');
  if (region && !REGIONS.includes(region as Region)) return NextResponse.json({ error: 'Некорректный регион' }, { status: 400 });
  const metricRaw = sp.get('metricId');
  const metricId = isCallMetric(metricRaw) ? metricRaw : null;
  try {
    const map = await loadCallLogistMap();
    const owners = callAttribution(map);
    const uids: string[] = [];
    const nameOf = new Map<string, string>();
    const shared = new Set<string>();
    for (const [uid, o] of owners) {
      const hit = logistIds.length ? logistIds.includes(o.logistId) : region ? o.region === region : true;
      if (!hit) continue;
      uids.push(uid);
      nameOf.set(uid, logistDisplayName(o.name));
      if (logistIds.length === 1) for (const n of o.shared) shared.add(logistDisplayName(n));
    }
    // Логист — «второй» на общей учётке Битрикса: его звонки показаны у владельца учётки.
    let sharedWith: string | null = null;
    if (!uids.length && logistIds.length === 1) {
      const bid = map.find(r => r.logistId === logistIds[0])?.bitrixId;
      const o = bid ? owners.get(bid) : undefined;
      if (o) sharedWith = logistDisplayName(o.name);
    }
    const rule = callDrillWhere(metricId);
    const rows = uids.length ? await loadCallList(mskYmd(from), mskYmd(to), uids, rule.where) : [];
    const items: CallDrillItem[] = rows.map(r => {
      const answered = isAnsweredCode(r.failed_code);
      const dur = r.duration_seconds === null ? null : Number(r.duration_seconds);
      return {
        id: r.id, startedAt: new Date(r.started_at).toISOString(), direction: r.direction, phone: maskPhone(r.phone),
        durationSec: dur, answered, short: answered && dur !== null && dur < SHORT_CALL_SEC,
        failedReason: answered ? null : r.failed_reason, transcription: r.transcription_status, logist: nameOf.get(r.bitrix_id) ?? null,
      };
    });
    return NextResponse.json({ items, truncated: items.length >= 2000, hasAccount: uids.length > 0, sharedWith, note: rule.note ?? null, shared: [...shared] });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    console.error('[realizations/calls]', msg);
    if (/permission denied/i.test(msg)) return NextResponse.json({ error: 'Нет доступа к звонкам в базе (va.calls_logist): роли приложения нужен GRANT SELECT' }, { status: 503 });
    return NextResponse.json({ error: 'Не удалось загрузить звонки' }, { status: 502 });
  }
}
