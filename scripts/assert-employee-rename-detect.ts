// Юнит-проверка чистой логики детекта переименований (задача 2654):
// planRenameOps из features/employees/engine/registry.ts. БД не трогается вообще
// (sa.employees не мутируется по определению — проверяется только планировщик).
// Запуск: node --experimental-strip-types scripts/assert-employee-rename-detect.ts

import { planRenameOps } from '../features/employees/engine/tenure.ts';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL ${name}`); }
}

// 1. Первый запуск: истории нет — сеем без событий.
{
  const ops = planRenameOps(
    new Map([['1848', 'Андрей Бибиков'], ['1849', 'Никита Шаманский']]),
    new Map(),
    new Map(),
  );
  check('seed: 2 операции', ops.length === 2);
  check('seed: все kind=seed', ops.every(o => o.kind === 'seed'));
}

// 2. Идемпотентность: имена совпадают — 0 операций.
{
  const ops = planRenameOps(
    new Map([['1848', 'Андрей Бибиков']]),
    new Map([['1848', 'Андрей Бибиков']]),
    new Map(),
  );
  check('no-op: 0 операций', ops.length === 0);
}

// 3. Нормализация: лишние пробелы не считаются переименованием.
{
  const ops = planRenameOps(
    new Map([['1848', '  Андрей   Бибиков ']]),
    new Map([['1848', 'Андрей Бибиков']]),
    new Map(),
  );
  check('normalize: пробелы не событие', ops.length === 0);
}

// 4. Реальное переименование слота (человек сменился на логине).
{
  const ops = planRenameOps(
    new Map([['1851', 'Иван Новенький']]),
    new Map([['1851', 'Роман Зайцев']]),
    new Map([['1851', 'Кто-то Прошлый']]),
  );
  check('rename: 1 операция', ops.length === 1 && ops[0].kind === 'rename');
  check('rename: old/new верные', ops[0].prevName === 'Роман Зайцев' && ops[0].name === 'Иван Новенький');
}

// 5. Анти-пинг-понг: возврат к только что закрытому имени (расхождение форматов
// между синком employees и org-sync) — пропускаем, событие не фабрикуем.
{
  const ops = planRenameOps(
    new Map([['1852', 'Пётр Иванов']]),
    new Map([['1852', 'Petr Ivanov']]),
    new Map([['1852', 'Пётр Иванов']]),
  );
  check('anti-flip: skip-flip', ops.length === 1 && ops[0].kind === 'skip-flip');
}

// 6. Пустые имена не сеем.
{
  const ops = planRenameOps(new Map([['1853', '   ']]), new Map(), new Map());
  check('empty: 0 операций', ops.length === 0);
}

// 7. Повторный прогон после применения rename (open уже = новое имя) — 0 операций.
{
  const ops = planRenameOps(
    new Map([['1851', 'Иван Новенький']]),
    new Map([['1851', 'Иван Новенький']]),
    new Map([['1851', 'Роман Зайцев']]),
  );
  check('idempotent after rename: 0 операций', ops.length === 0);
}

// 8. Логин под org-sync: расхождение employees.full_name (логин) с ФИО из истории —
// НЕ событие (урок прода 31.07: 105 ложных переименований, откачены).
{
  const ops = planRenameOps(
    new Map([['5', 'askulikov']]),
    new Map([['5', 'Александр Куликов']]),
    new Map(),
    new Set(['5']),
  );
  check('org-managed: 0 операций', ops.length === 0);
}

// 9. Логин под org-sync, но истории ещё нет — seed допустим (истории неоткуда взяться).
{
  const ops = planRenameOps(
    new Map([['77', 'Новый Сотрудник']]),
    new Map(),
    new Map(),
    new Set(['77']),
  );
  check('org-managed seed: 1 seed', ops.length === 1 && ops[0].kind === 'seed');
}

if (failures > 0) { console.error(`\n${failures} проверок упало`); process.exit(1); }
console.log('\nВсе проверки прошли');
