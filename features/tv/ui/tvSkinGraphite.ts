// Оформление экрана телевизора «Графит» — по референсу владельца от 07.10
// (дашборд «Fitro»: почти чёрный фон, графитовые карточки без свечения, один яркий
// синий акцент, тонкие светлые рамки, цифры обычного, не жирного начертания).
//
// Устроено так же, как остальные оформления: второй блок стилей поверх стилей движка
// (features/tv/engine/page.ts), подключает его tvScreen.ts, сам движок не менялся.
// Перекрывается «краска» — цвета, шрифт, скругления, рамки. Сетку плиток считает
// скрипт движка, её не трогаем.
//
// ОГРАНИЧЕНИЯ ТЕ ЖЕ: браузеры телевизоров 2016–2019 (Chromium 38–63) — без
// CSS-переменных, grid и gap; градиенты и flex с -webkit-, перед градиентом — сплошной
// цвет на случай, если браузер градиент не поймёт.
//
// Чего из референса здесь НЕТ и быть не может без правки движка: столбчатой диаграммы,
// линейного графика, календаря. Разметку и данные экрана выдаёт движок, а в них только
// столбец плана, плитки и полосы. Перенесён визуальный язык, а не набор виджетов.
//
// ГЛАВНЫЙ ПРИЁМ РЕФЕРЕНСА — один синий элемент на сером экране (выделенный столбик,
// кнопка). Здесь это плитка лидера: она синяя целиком, всё внутри неё белое.
//
// ЦВЕТ = СМЫСЛ (как три счётчика в референсе):
//   синий      #2B5FEA  — лидер, полоса хода выполнения, столбец отдела при выполненном плане
//   зелёный    #86D95B  — факт, выполненный план менеджера, достигнутая цель
//   фиолетовый #A78BFA  — брони
// ПАЛИТРА (тёмная / светлая; у референса светлой нет — она выведена из тёмной):
//   фон       #0F0F11 / #EFEFF2      подложка экрана #17171A / #F8F8FA
//   карточка  #1F1F23 / #FFFFFF      вложенный блок  #2A2A30 / #EFEFF2
//   текст     #FFFFFF / #18181B      приглушённый    #9C9CA6 / #71717A

export const TV_SKIN_GRAPHITE_CSS = String.raw`
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-400.woff2) format("woff2");font-weight:400;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-500.woff2) format("woff2");font-weight:500;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-700.woff2) format("woff2");font-weight:700;font-style:normal}
body{font-family:MontserratTV,Montserrat,"Segoe UI",Roboto,Arial,sans-serif;background:#0F0F11;color:#FFFFFF}
body.th-light{background:#EFEFF2;color:#18181B}
.muted{color:#9C9CA6}.th-light .muted{color:#71717A}

/* ── Подложка под всем экраном с тонкой светлой рамкой — как главный контейнер
   референса. Псевдоэлемент: разметку движка не меняем. */
.stage:before{content:"";position:absolute;left:.9vw;right:.9vw;top:.7vw;bottom:.5vw;background:#17171A;border:1px solid #3A3A42;border-radius:1.7vw}
.th-light .stage:before{background:#F8F8FA;border-color:#DCDCE2}

/* ── Панель отдела: графитовая карточка без рамки. Подписи — обычным регистром и
   начертанием, как в референсе (движок ставит капс и жирность через стили). */
.side{background:#1F1F23;border-color:#1F1F23;border-radius:1vw}
.th-light .side{background:#FFFFFF;border-color:#FFFFFF}
.dept{font-weight:500;letter-spacing:0}
.dept .muted{font-weight:400}

/* Столбец «% плана дня» — как столбики в референсе: пока план не выполнен, заливка
   серая; выполнен — столбец становится синим (выделенный столбик). В светлой теме
   заливка бледная, а цифра тёмная: тёмная цифра на насыщенном синем не читалась бы. */
.col .track{background:#2A2A30;border-color:#2A2A30;border-radius:.8vw}
.th-light .col .track{background:#EFEFF2;border-color:#EFEFF2}
.col .fill{background:#45454D;border-top:.22vw solid #9C9CA6;border-radius:0}
.col .fill.ok{background:#2456E6;background:-webkit-linear-gradient(top,#2E63F0,#1B43BA);background:linear-gradient(to bottom,#2E63F0,#1B43BA);border-top-color:#7EA2FF}
.col .fill.ok.over{border-radius:0}
.th-light .col .fill{background:#D4D4DA;border-top-color:#9C9CA6}
.th-light .col .fill.ok{background:#A9C0FF;border-top-color:#2456E6}
.col .pct{color:#FFFFFF;font-weight:500;text-shadow:none}
.th-light .col .pct{color:#18181B;text-shadow:none}
.col .cap{color:#FFFFFF;text-transform:none;letter-spacing:0;font-weight:400;font-size:1.1vw}
.th-light .col .cap{color:#18181B}
.col .mark{border-top-color:#9C9CA6}.col .mark span{color:#9C9CA6}

/* Цифры под столбцом: факт и достигнутая цель — зелёные, брони — фиолетовые */
.sst .l{color:#9C9CA6;text-transform:none;letter-spacing:0;font-weight:400;font-size:1vw}
.th-light .sst .l{color:#71717A}
.sst .v{font-weight:500}
.sst .v.fact{color:#86D95B}.th-light .sst .v.fact{color:#2E8B3A}
.sst .v.book{color:#A78BFA}.th-light .sst .v.book{color:#7C3AED}
.sst .v.warn{color:#FFFFFF}.th-light .sst .v.warn{color:#18181B}
.sst .v small{color:#9C9CA6}.th-light .sst .v small{color:#71717A}

/* ── Плитки менеджеров и карточки филиалов: графитовые, без рамок и теней */
.tile{background:#1F1F23;border-color:#1F1F23;border-radius:.9em}
.th-light .tile{background:#FFFFFF;border-color:#FFFFFF}
.tile.card{border-color:#1F1F23}.th-light .tile.card{border-color:#FFFFFF}
/* Лидер — единственный синий элемент экрана, в обеих темах одинаковый */
.tile.top,.th-light .tile.top{background:#2456E6;background:-webkit-linear-gradient(top left,#2E63F0,#1B43BA);background:linear-gradient(135deg,#2E63F0,#1B43BA);border-color:#2E63F0}
/* Фокус пульта — белая рамка, как у активных «таблеток» референса */
.tile.focus{-webkit-box-shadow:0 0 0 .25vw #FFFFFF;box-shadow:0 0 0 .25vw #FFFFFF}
.th-light .tile.focus{-webkit-box-shadow:0 0 0 .25vw #18181B;box-shadow:0 0 0 .25vw #18181B}

/* Аватар без фото — серый кружок с белыми инициалами. Движок красит его инлайн-стилем
   по имени, поэтому !important. */
.ava{background:#34343A !important;color:#FFFFFF;font-weight:500}
.th-light .ava{background:#E4E4E8 !important;color:#18181B}
.ava.dep{background:#2A2A30 !important;border-radius:.55em}
.th-light .ava.dep{background:#EFEFF2 !important}
.name{font-weight:500}

/* Место: 1 — белый кружок, 2 — контур, 3 — серый кружок (как три вида «таблеток»
   в референсе), дальше — просто цифра */
.rank{color:#9C9CA6;font-weight:500}.th-light .rank{color:#71717A}
.tile[data-i="0"] .rank,.tile[data-i="1"] .rank,.tile[data-i="2"] .rank{width:1.9em;min-width:1.9em;height:1.9em;line-height:1.9em;border-radius:1em;text-align:center}
.tile[data-i="0"] .rank{background:#FFFFFF;color:#18181B}
.tile[data-i="1"] .rank{color:#FFFFFF;-webkit-box-shadow:inset 0 0 0 .1em #FFFFFF;box-shadow:inset 0 0 0 .1em #FFFFFF}
.tile[data-i="2"] .rank{background:#34343A;color:#FFFFFF}
.th-light .tile[data-i="0"] .rank{background:#18181B;color:#FFFFFF}
.th-light .tile[data-i="1"] .rank{color:#18181B;-webkit-box-shadow:inset 0 0 0 .1em #18181B;box-shadow:inset 0 0 0 .1em #18181B}
.th-light .tile[data-i="2"] .rank{background:#E4E4E8;color:#18181B}

/* Цифры плитки — белые, среднего начертания. Процент ниже плана приглушён.
   Полоса: ход выполнения — синяя, план выполнен — зелёная. */
.hero .v{color:#FFFFFF;font-weight:500}.th-light .hero .v{color:#18181B}
.hero .v small{color:#9C9CA6;font-weight:400}.th-light .hero .v small{color:#71717A}
.hero .p{color:#FFFFFF;font-weight:500}.th-light .hero .p{color:#18181B}
.hero .p.warn{color:#9C9CA6}.th-light .hero .p.warn{color:#71717A}
.bar{background:#34343A}.th-light .bar{background:#E4E4E8}
.bar i{background:#86D95B}.th-light .bar i{background:#4CB648}
.bar.warn i{background:#2B5FEA}.th-light .bar.warn i{background:#2456E6}
.sub{color:#9C9CA6}.th-light .sub{color:#71717A}
.sub b{color:#FFFFFF;font-weight:500}.th-light .sub b{color:#18181B}
.sub b.book{color:#A78BFA}.th-light .sub b.book{color:#7C3AED}
.pb{border-top-color:#303036}.th-light .pb{border-top-color:#E4E4E8}
/* «ПРОДАЖИ» и «БРОНИ» движок пишет капсом прямо в тексте — приводим к обычному регистру */
.pb .l{color:#9C9CA6;text-transform:lowercase;letter-spacing:0;font-weight:400;font-size:.9em}
.pb .l:first-letter{text-transform:uppercase}
.th-light .pb .l{color:#71717A}
.pb .n{color:#FFFFFF;font-weight:500}.th-light .pb .n{color:#18181B}
.pb .n.ok{color:#86D95B}.th-light .pb .n.ok{color:#2E8B3A}
.pb .n small{color:#9C9CA6;font-weight:400}.th-light .pb .n small{color:#71717A}
.pb .n.book{color:#A78BFA}.th-light .pb .n.book{color:#7C3AED}
.pb .n.book.ok{color:#86D95B}.th-light .pb .n.book.ok{color:#2E8B3A}

/* Внутри синей плитки лидера всё белое или светлое — в обеих темах. Цвет-смысл
   сохранён оттенком: выполнено — светло-зелёный, брони — светло-фиолетовый. */
.tile.top .name,.th-light .tile.top .name,.tile.top .hero .v,.th-light .tile.top .hero .v,.tile.top .hero .p,.th-light .tile.top .hero .p,.tile.top .sub b,.th-light .tile.top .sub b,.tile.top .pb .n,.th-light .tile.top .pb .n{color:#FFFFFF}
.tile.top .hero .v small,.th-light .tile.top .hero .v small,.tile.top .sub,.th-light .tile.top .sub,.tile.top .pb .l,.th-light .tile.top .pb .l,.tile.top .pb .n small,.th-light .tile.top .pb .n small,.tile.top .hero .p.warn,.th-light .tile.top .hero .p.warn{color:#C9D6FA}
.tile.top .sub b.book,.th-light .tile.top .sub b.book,.tile.top .pb .n.book,.th-light .tile.top .pb .n.book{color:#E3D7FF}
.tile.top .pb .n.ok,.th-light .tile.top .pb .n.ok,.tile.top .pb .n.book.ok,.th-light .tile.top .pb .n.book.ok{color:#C8F5B0}
.tile.top .bar,.th-light .tile.top .bar{background:#1A3C9E}
.tile.top .bar i,.th-light .tile.top .bar i{background:#FFFFFF}
.tile.top .bar.warn i,.th-light .tile.top .bar.warn i{background:#A9C0FF}
.tile.top .pb,.th-light .tile.top .pb{border-top-color:#5A82F2}
.tile.top .ava,.th-light .tile.top .ava{background:#5A82F2 !important;color:#FFFFFF}
.tile.top .rank,.th-light .tile.top .rank{background:#FFFFFF;color:#1B43BA;-webkit-box-shadow:none;box-shadow:none}

/* ── Низ экрана: голова Монолитика на серой плитке, точки-страницы, бегущая строка */
.ftr{color:#9C9CA6}.th-light .ftr{color:#71717A}
.ftr b{color:#FFFFFF;font-weight:500}.th-light .ftr b{color:#18181B}
.ftr>div:first-child:before{content:"";display:inline-block;vertical-align:middle;width:2.9vw;height:1.8vw;margin-right:.7vw;border-radius:.5vw;background:#2A2A30 url(/tv/assets/monolitik-head.png) no-repeat center;-webkit-background-size:2.3vw auto;background-size:2.3vw auto}
.th-light .ftr>div:first-child:before{background-color:#E4E4E8}
.dots span{background:#34343A}.th-light .dots span{background:#D4D4DA}
.dots span.on{background:#2B5FEA}.th-light .dots span.on{background:#2456E6}
.ticker{background:#1F1F23;border-color:#1F1F23;border-radius:1.3vw}
.th-light .ticker{background:#FFFFFF;border-color:#FFFFFF}
.ticker span{font-weight:400}
.ticker span b{color:#7EA2FF;font-weight:500}.th-light .ticker span b{color:#2456E6}

/* ── Плашка паузы: синяя кнопка и контурная «таблетка» — как в референсе */
.pill{color:#FFFFFF;font-weight:400}.th-light .pill{color:#18181B}
.pill .ico{color:#9C9CA6}.th-light .pill .ico{color:#71717A}
.pill .pbtn,.th-light .pill .pbtn{border-color:#2E63F0;background:#2456E6;background:-webkit-linear-gradient(left,#2E63F0,#1B43BA);background:linear-gradient(to right,#2E63F0,#1B43BA);color:#FFFFFF;border-radius:.6vw;font-weight:500}
.pill .pbtn.go{background:transparent;color:#FFFFFF;border-color:#FFFFFF;border-radius:2vw}
.th-light .pill .pbtn.go{background:transparent;color:#18181B;border-color:#18181B;border-radius:2vw}

/* ── Служебные состояния и объявления */
.empty{color:#9C9CA6}.th-light .empty{color:#71717A}
.off{color:#FFFFFF;background:#2A2A30}
.banner{background:#2456E6;background:-webkit-linear-gradient(left,#2E63F0,#1B43BA);background:linear-gradient(to right,#2E63F0,#1B43BA);color:#FFFFFF;border-radius:.9vw;font-weight:500;-webkit-box-shadow:0 .6vw 2vw rgba(0,0,0,.45);box-shadow:0 .6vw 2vw rgba(0,0,0,.45)}
.full{background:#0F0F11}.th-light .full{background:#EFEFF2}
.full .t{font-weight:500}
.full .s{color:#9C9CA6}.th-light .full .s{color:#71717A}

/* ── Экран привязки (движок рисует его всегда в тёмной теме): робот, название, код на
   графитовой карточке с тонкой рамкой */
.pair{padding-top:6vh}
.pair .logo{color:#FFFFFF;letter-spacing:.04em;font-weight:500}
.pair .logo:before{content:"";display:block;width:10.1vw;height:9vw;margin:0 auto 1vw;background:url(/tv/assets/monolitik-robot.png) no-repeat center;-webkit-background-size:contain;background-size:contain}
.pair .logo:after{content:"аналитика";display:block;font-size:.62em;font-weight:400;letter-spacing:0;color:#9C9CA6;margin-top:.15vw}
.pair .h{color:#9C9CA6;margin-top:3vh}
.pair .code{display:inline-block;font-family:inherit;font-size:11vw;font-weight:500;letter-spacing:.14em;color:#FFFFFF;background:#1F1F23;border:1px solid #3A3A42;border-radius:1.6vw;padding:1.4vw 2.2vw 1.4vw 3.7vw}
.pair .hint{color:#9C9CA6;margin-top:3vh}
.pair .hint b{color:#FFFFFF;font-weight:500}
.pair .url{color:#9C9CA6}

/* ── Поздравление с продажей / выполненным планом. Заголовок — синяя «таблетка»,
   сумма белая. Конфетти — пять акцентных цветов референса (движок красит его
   инлайн-стилем, поэтому !important). */
.cele{background:rgba(15,15,17,.95)}
.th-light .cele{background:rgba(239,239,242,.96)}
/* «Вспышка»: в пике фон остаётся плотным. У светлой темы свои ключевые кадры —
   у движка они общие, тёмные. */
@-webkit-keyframes flash{0%,100%{background:rgba(15,15,17,.95)}50%{background:rgba(27,67,186,.96)}}
@keyframes flash{0%,100%{background:rgba(15,15,17,.95)}50%{background:rgba(27,67,186,.96)}}
@-webkit-keyframes flashl{0%,100%{background:rgba(239,239,242,.96)}50%{background:rgba(169,192,255,.97)}}
@keyframes flashl{0%,100%{background:rgba(239,239,242,.96)}50%{background:rgba(169,192,255,.97)}}
.th-light .cele.flash{-webkit-animation-name:flashl;animation-name:flashl}
.cele .k,.th-light .cele .k{display:inline-block;color:#FFFFFF;font-size:2.2vw;font-weight:500;letter-spacing:.12em;background:#2456E6;background:-webkit-linear-gradient(left,#2E63F0,#1B43BA);background:linear-gradient(to right,#2E63F0,#1B43BA);border-radius:3vw;padding:.7vw 2.2vw .7vw 2.5vw}
.cele .ava{margin-top:1.4vw}
.cele .who{font-weight:500}
.cele .amt{color:#FFFFFF;font-weight:500}.th-light .cele .amt{color:#18181B}
.cele .d{color:#9C9CA6}.th-light .cele .d{color:#71717A}
.cf{background:#2B5FEA !important}
.cf:nth-child(5n){background:#A78BFA !important}
.cf:nth-child(5n+1){background:#F97316 !important}
.cf:nth-child(5n+2){background:#86D95B !important}
.cf:nth-child(5n+3){background:#F5C542 !important}
.toast{background:#2A2A30;border-color:#3A3A42;color:#FFFFFF;border-radius:.9vw}
.th-light .toast{background:#FFFFFF;border-color:#DCDCE2;color:#18181B}
.toast b{color:#86D95B;font-weight:500}.th-light .toast b{color:#2E8B3A}
`;
