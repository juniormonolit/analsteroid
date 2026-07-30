import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

// Веса рейтинга переехали в конструктор карточек (задача владельца 30.07: «веса
// рейтинга не синхронизируются с тем, что выбрано в карточках… и должны быть в 2
// вариантах: для карточки менеджера и для карточки РОПа»).
//
// Прежний экран правил таблицу scoring_weights — singleton с 6 ФИКСИРОВАННЫМИ
// колонками по именам legacy-осей. Как только админ выбирал осью паутины метрику
// каталога (а с 10.07 это можно), её вес было негде задать: движок молча
// подставлял 5. Плюс набор весов был ОДИН на оба шаблона. Теперь вес — поле самой
// оси в card_templates (миграция 107), поэтому он синхронизирован с выбором по
// построению и у каждого шаблона свой. Второго экрана быть не должно — иначе два
// источника правды; страница оставлена указателем, чтобы старые ссылки/закладки
// супер-админов не вели в пустоту.
export default function ScoringWeightsMovedPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)]">Веса скоринга</h1>
      <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
        <p className="text-sm text-[var(--color-text)]">
          Веса переехали в «Шаблоны карточек» — теперь вес задаётся прямо на строке оси
          паутины, отдельно для карточки менеджера и карточки отдела (РОП).
        </p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Так вес и набор осей не могут разойтись: раньше веса жили в отдельной таблице
          по шести фиксированным осям, и любая метрика из каталога получала вес 5 без
          возможности его изменить.
        </p>
        <Link
          href="/settings/card-templates"
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:opacity-90 transition-opacity"
        >
          Открыть шаблоны карточек
          <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  );
}
