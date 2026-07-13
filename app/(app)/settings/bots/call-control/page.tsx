'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';

// Настройки бота «Контроль звонков»: тумблеры (вкл/dry-run/зеркало), конструктор
// правил эскалации (N пропущенных подряд <И|ИЛИ> M минут без перезвона → получатель
// по шаблону) и редактор шаблонов. Данные — /api/settings/bots/call-control/*.

type Recipient = 'manager' | 'rop' | 'department_director' | 'company_director' | 'fixed';

const RECIPIENT_LABELS: Record<Recipient, string> = {
  manager: 'Менеджеру',
  rop: 'РОПу',
  department_director: 'Директору департамента',
  company_director: 'Директору компании',
  fixed: 'Фиксированный Bitrix ID',
};

interface Rule {
  id: number;
  sort_order: number;
  name: string;
  missed_count_gte: number | null;
  minutes_without_callback: number | null;
  operator: 'and' | 'or';
  recipient: Recipient;
  fixed_bitrix_user_id: string | null;
  template_id: number | null;
  is_active: boolean;
}

interface Template { id: number; name: string; body: string }

interface Delivery {
  id: number; rule_name: string | null; recipient_kind: string; recipient_name: string | null;
  recipient_bitrix_user_id: string | null;
  message: string; dry_run: boolean; mirrored: boolean; error: string | null; sent_at: string;
  phone_normalized: string | null; missed_count: number | null;
}

interface BotStatus {
  enabled: boolean; dryRun: boolean; mirrorBitrixUserId: string;
  eventsLast24h: number; lastEventAt: string | null; openCases: number;
}

interface DeptRow {
  department_id: string;
  department_name: string;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  rop_override_id: string | null;
  rop_override_name: string | null;
  director_override_id: string | null;
  director_override_name: string | null;
}

interface Employee { id: string; name: string | null; department_name: string | null; short_login: string | null }

const PLACEHOLDERS = '{manager_name} {phone} {deal_url} {missed_count} {minutes} {case_id} {recipient_name}';

export default function CallControlBotPage() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const reload = useCallback(async () => {
    const [s, r, t, d, dep] = await Promise.all([
      fetch('/api/settings/bots/call-control').then(x => x.json()),
      fetch('/api/settings/bots/call-control/rules').then(x => x.json()),
      fetch('/api/settings/bots/call-control/templates').then(x => x.json()),
      fetch('/api/settings/bots/call-control/deliveries').then(x => x.json()),
      fetch('/api/settings/bots/call-control/departments').then(x => x.json()),
    ]);
    setStatus(s);
    setRules(Array.isArray(r.rules) ? r.rules : []);
    setTemplates(Array.isArray(t.templates) ? t.templates : []);
    setDeliveries(Array.isArray(d.deliveries) ? d.deliveries : []);
    setDepartments(Array.isArray(dep.departments) ? dep.departments : []);
  }, []);

  useEffect(() => { reload().catch(() => flash('error', 'Не удалось загрузить настройки')); }, [reload]);

  async function saveSettings(patch: Partial<Pick<BotStatus, 'enabled' | 'dryRun' | 'mirrorBitrixUserId'>>) {
    const res = await fetch('/api/settings/bots/call-control', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) { flash('error', data.error ?? 'Ошибка сохранения'); return; }
    setStatus(s => (s ? { ...s, ...patch } : s));
    flash('success', 'Сохранено');
  }

  async function patchRule(id: number, patch: Record<string, unknown>) {
    const res = await fetch(`/api/settings/bots/call-control/rules/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) { flash('error', data.error ?? 'Ошибка'); return; }
    await reload();
  }

  async function addRule() {
    const res = await fetch('/api/settings/bots/call-control/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Новое правило', missedCountGte: 1, minutesWithoutCallback: 30, templateId: templates[0]?.id ?? null }),
    });
    if (!res.ok) { flash('error', 'Не удалось создать правило'); return; }
    await reload();
  }

  async function deleteRule(id: number) {
    if (!confirm('Удалить правило?')) return;
    await fetch(`/api/settings/bots/call-control/rules/${id}`, { method: 'DELETE' });
    await reload();
  }

  async function saveTemplate(t: Template) {
    const res = await fetch(`/api/settings/bots/call-control/templates/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, body: t.body }),
    });
    const data = await res.json();
    if (!res.ok) { flash('error', data.error ?? 'Ошибка'); return; }
    flash('success', 'Шаблон сохранён');
  }

  async function addTemplate() {
    const res = await fetch('/api/settings/bots/call-control/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Новый шаблон', body: 'Текст с плейсхолдерами: {manager_name}, {phone}…' }),
    });
    if (!res.ok) { flash('error', 'Не удалось создать шаблон'); return; }
    await reload();
  }

  async function deleteTemplate(id: number) {
    if (!confirm('Удалить шаблон? Правила, где он выбран, останутся без шаблона.')) return;
    await fetch(`/api/settings/bots/call-control/templates/${id}`, { method: 'DELETE' });
    await reload();
  }

  async function setOverride(departmentId: string, role: 'rop' | 'department_director', bitrixUserId: string | null) {
    const res = await fetch('/api/settings/bots/call-control/departments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentId, role, bitrixUserId }),
    });
    const data = await res.json();
    if (!res.ok) { flash('error', data.error ?? 'Ошибка'); return; }
    flash('success', bitrixUserId ? 'Получатель назначен вручную' : 'Сброшено на оргструктуру');
    await reload();
  }

  const inputCls = 'border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-bg-surface)] text-[var(--color-text)] text-base sm:text-sm';

  return (
    <div className="p-3 sm:p-6 max-w-5xl flex flex-col gap-8">
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Бот «Контроль звонков»</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Пропущенные входящие с эскалацией. События приходят с исходящего вебхука
          Bitrix (телефония), правила и шаблоны — ниже, всё редактируемое.
        </p>
      </div>

      {/* Статус приёма + тумблеры */}
      {status && (
        <section className="border border-[var(--color-border)] rounded-lg p-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--color-text-muted)]">
            <span>Событий за 24ч: <b className="text-[var(--color-text)]">{status.eventsLast24h}</b></span>
            <span>Последнее: <b className="text-[var(--color-text)]">{status.lastEventAt ? new Date(status.lastEventAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'не было'}</b></span>
            <span>Открытых кейсов: <b className="text-[var(--color-text)]">{status.openCases}</b></span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
              <input type="checkbox" checked={status.enabled} onChange={e => saveSettings({ enabled: e.target.checked })} />
              Бот включён
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer">
              <input type="checkbox" checked={status.dryRun} onChange={e => saveSettings({ dryRun: e.target.checked })} />
              Dry run — получателям НЕ шлём (обкатка)
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              Зеркало-дубль (Bitrix ID):
              <input
                className={`${inputCls} w-24`}
                defaultValue={status.mirrorBitrixUserId}
                onBlur={e => { if (e.target.value !== status.mirrorBitrixUserId) saveSettings({ mirrorBitrixUserId: e.target.value }); }}
                placeholder="пусто = выкл"
              />
            </label>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Зеркало-дубль шлётся ВСЕГДА, пока заполнен ID — и в dry run (с пометкой), и в
            боевом режиме. Боевой режим с дублем себе = снять dry run и оставить зеркало.
          </p>
        </section>
      )}

      {/* Правила эскалации */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Правила эскалации</h2>
          <button onClick={addRule} className="flex items-center gap-1 text-sm text-[var(--color-accent)] hover:underline tap-target">
            <Plus size={14} /> Добавить
          </button>
        </div>
        <div className="scroll-x border border-[var(--color-border)] rounded-lg">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                <th className="px-3 py-2 font-medium">Вкл</th>
                <th className="px-3 py-2 font-medium">Название</th>
                <th className="px-3 py-2 font-medium">Пропущенных ≥</th>
                <th className="px-3 py-2 font-medium">Оператор</th>
                <th className="px-3 py-2 font-medium">Минут без перезвона ≥</th>
                <th className="px-3 py-2 font-medium">Получатель</th>
                <th className="px-3 py-2 font-medium">Шаблон</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-[var(--color-border)] last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={rule.is_active} onChange={e => patchRule(rule.id, { isActive: e.target.checked })} />
                  </td>
                  <td className="px-3 py-2">
                    <input className={`${inputCls} w-full min-w-40`} defaultValue={rule.name}
                      onBlur={e => { if (e.target.value !== rule.name) patchRule(rule.id, { name: e.target.value }); }} />
                  </td>
                  <td className="px-3 py-2">
                    <input className={`${inputCls} w-16`} inputMode="numeric" defaultValue={rule.missed_count_gte ?? ''}
                      placeholder="—"
                      onBlur={e => {
                        const v = e.target.value.trim();
                        patchRule(rule.id, { missedCountGte: v === '' ? null : parseInt(v, 10) });
                      }} />
                  </td>
                  <td className="px-3 py-2">
                    <select className={inputCls} value={rule.operator} onChange={e => patchRule(rule.id, { operator: e.target.value })}>
                      <option value="and">И</option>
                      <option value="or">ИЛИ</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input className={`${inputCls} w-16`} inputMode="numeric" defaultValue={rule.minutes_without_callback ?? ''}
                      placeholder="—"
                      onBlur={e => {
                        const v = e.target.value.trim();
                        patchRule(rule.id, { minutesWithoutCallback: v === '' ? null : parseInt(v, 10) });
                      }} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <select className={inputCls} value={rule.recipient} onChange={e => patchRule(rule.id, { recipient: e.target.value })}>
                        {(Object.keys(RECIPIENT_LABELS) as Recipient[]).map(k => (
                          <option key={k} value={k}>{RECIPIENT_LABELS[k]}</option>
                        ))}
                      </select>
                      {rule.recipient === 'fixed' && (
                        <input className={`${inputCls} w-24`} inputMode="numeric" defaultValue={rule.fixed_bitrix_user_id ?? ''}
                          placeholder="Bitrix ID"
                          onBlur={e => patchRule(rule.id, { fixedBitrixUserId: e.target.value.trim() || null })} />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select className={inputCls} value={rule.template_id ?? ''}
                      onChange={e => patchRule(rule.id, { templateId: e.target.value === '' ? null : parseInt(e.target.value, 10) })}>
                      <option value="">— нет —</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => deleteRule(rule.id)} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-error)]" aria-label="Удалить правило">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Правил нет — добавьте первое.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Пустой порог («—») — условие не участвует. Оператор «И» требует все заданные
          условия, «ИЛИ» — любое. Правило по кейсу срабатывает один раз.
        </p>
      </section>

      {/* Получатели по отделам */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Получатели по отделам</h2>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">
          Кому уходят эскалации уровней «РОПу» и «Директору департамента» для менеджеров
          каждого отдела. По умолчанию — по оргструктуре («авто»), клик по ячейке —
          назначить любого сотрудника вручную в обход оргструктуры.
        </p>
        <div className="scroll-x border border-[var(--color-border)] rounded-lg">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                <th className="px-3 py-2 font-medium">Отдел</th>
                <th className="px-3 py-2 font-medium">РОП</th>
                <th className="px-3 py-2 font-medium">Директор департамента</th>
              </tr>
            </thead>
            <tbody>
              {departments.map(d => (
                <tr key={d.department_id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="px-3 py-2 text-[var(--color-text)]">{d.department_name}</td>
                  <td className="px-3 py-2">
                    <RecipientCell
                      autoName={d.rop_name} autoId={d.rop_bitrix_user_id}
                      overrideName={d.rop_override_name} overrideId={d.rop_override_id}
                      onPick={id => setOverride(d.department_id, 'rop', id)}
                      inputCls={inputCls}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <RecipientCell
                      autoName={d.department_director_name} autoId={d.department_director_bitrix_user_id}
                      overrideName={d.director_override_name} overrideId={d.director_override_id}
                      onPick={id => setOverride(d.department_id, 'department_director', id)}
                      inputCls={inputCls}
                    />
                  </td>
                </tr>
              ))}
              {departments.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Оргструктура пуста (на dev-стенде это норма).</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Шаблоны */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Шаблоны сообщений</h2>
          <button onClick={addTemplate} className="flex items-center gap-1 text-sm text-[var(--color-accent)] hover:underline tap-target">
            <Plus size={14} /> Добавить
          </button>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2">Плейсхолдеры: <code className="text-[11px]">{PLACEHOLDERS}</code></p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {templates.map(t => (
            <TemplateCard key={t.id} template={t} inputCls={inputCls} onSave={saveTemplate} onDelete={deleteTemplate} />
          ))}
        </div>
      </section>

      {/* Последние доставки */}
      <section>
        <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Последние уведомления</h2>
        {deliveries.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Пока пусто.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {deliveries.map(d => (
              <div key={d.id} className="border border-[var(--color-border)] rounded-lg p-3 text-xs">
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--color-text-muted)] mb-1">
                  <span>{new Date(d.sent_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</span>
                  <span>→ {d.recipient_name ?? d.recipient_bitrix_user_id ?? '—'} ({d.recipient_kind})</span>
                  <span>{d.rule_name}</span>
                  {d.phone_normalized && <span>{d.phone_normalized} · пропущено {d.missed_count}</span>}
                  {d.dry_run && <span className="text-amber-600 font-medium">dry run</span>}
                  {d.error && <span className="text-[var(--color-error)]">{d.error}</span>}
                </div>
                <pre className="whitespace-pre-wrap text-[var(--color-text)] font-sans">{d.message}</pre>
              </div>
            ))}
          </div>
        )}
      </section>

      {message && (
        <p className={`fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg z-50 ${
          message.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

// Ячейка получателя: эффективное значение (ручное ИЛИ оргструктура) + бейдж
// «вручную»/«авто». Клик — поповер с поиском по всем сотрудникам и сбросом на авто.
function RecipientCell({ autoName, autoId, overrideName, overrideId, onPick, inputCls }: {
  autoName: string | null;
  autoId: string | null;
  overrideName: string | null;
  overrideId: string | null;
  onPick: (bitrixUserId: string | null) => void;
  inputCls: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Employee[]>([]);

  const isOverride = overrideId != null;
  const effectiveName = isOverride ? (overrideName ?? overrideId) : (autoName ?? autoId);

  useEffect(() => {
    if (!open || q.trim().length < 2) { setResults([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/settings/bots/call-control/employees?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal })
        .then(r => r.json())
        .then(d => setResults(Array.isArray(d.employees) ? d.employees : []))
        .catch(() => {});
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  return (
    <Popover
      open={open}
      onOpenChange={o => { setOpen(o); if (!o) { setQ(''); setResults([]); } }}
      className="w-[300px] p-2"
      trigger={
        <button className="tap-target flex items-center gap-1.5 text-left hover:underline decoration-dotted underline-offset-2">
          <span className={effectiveName ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}>
            {effectiveName ?? 'не назначен'}
          </span>
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${
            isOverride
              ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] font-medium'
              : 'bg-[var(--color-border)] text-[var(--color-text-muted)]'
          }`}>
            {isOverride ? 'вручную' : 'авто'}
          </span>
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          className={`${inputCls} w-full`}
          placeholder="Поиск: имя, Bitrix ID, #логин…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="max-h-56 overflow-y-auto flex flex-col">
          {results.map(emp => (
            <button
              key={emp.id}
              onClick={() => { onPick(emp.id); setOpen(false); }}
              className="text-left px-2 py-1.5 rounded hover:bg-[var(--color-bg-hover)] text-sm text-[var(--color-text)]"
            >
              {emp.name ?? emp.id}
              <span className="block text-[11px] text-[var(--color-text-muted)]">
                {[emp.short_login, emp.department_name].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
          {q.trim().length >= 2 && results.length === 0 && (
            <span className="px-2 py-1.5 text-xs text-[var(--color-text-muted)]">Не найдено</span>
          )}
        </div>
        {isOverride && (
          <button
            onClick={() => { onPick(null); setOpen(false); }}
            className="self-start text-xs text-[var(--color-accent)] hover:underline px-2 py-1"
          >
            Сбросить на авто ({autoName ?? autoId ?? 'по оргструктуре'})
          </button>
        )}
      </div>
    </Popover>
  );
}

function TemplateCard({ template, inputCls, onSave, onDelete }: {
  template: Template;
  inputCls: string;
  onSave: (t: Template) => void;
  onDelete: (id: number) => void;
}) {
  const [name, setName] = useState(template.name);
  const [body, setBody] = useState(template.body);
  const dirty = name !== template.name || body !== template.body;

  return (
    <div className="border border-[var(--color-border)] rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input className={`${inputCls} flex-1 font-medium`} value={name} onChange={e => setName(e.target.value)} />
        <button onClick={() => onDelete(template.id)} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-error)]" aria-label="Удалить шаблон">
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        className={`${inputCls} w-full h-40 resize-y font-mono text-xs`}
        value={body}
        onChange={e => setBody(e.target.value)}
      />
      <button
        disabled={!dirty}
        onClick={() => onSave({ id: template.id, name, body })}
        className="self-end px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-40"
      >
        Сохранить
      </button>
    </div>
  );
}
