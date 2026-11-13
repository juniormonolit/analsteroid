-- 264: уточнения РОПа к главному промпту ИИ-анализа (собрание 12.11, п.3; владелец 13.11: «любой роп и старше мог
--      куда-то вписать уточнения к главному промту, который применится при запуске анализа»). Главный промпт по-прежнему
--      правят только админы (/settings/ai-analysis); уточнения — к одному запуску, видны в отчёте.
-- БД: system (monolitika). Идемпотентна. Откат: ALTER TABLE ai_analyses DROP COLUMN extra_instructions;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS extra_instructions text;
COMMENT ON COLUMN ai_analyses.extra_instructions IS 'Уточнения запустившего к главному промпту (дописываются в конец системного промпта этого запуска).';
