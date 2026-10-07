// Оформление экрана телевизора — «Дизайн Куликова» (визуальный язык monolit.shop).
// Эталон палитры и шрифта — docs/design/monolitika-redesign-monolitshop-20261006/
// 00-stil.html: светлые токены из блока :root, тёмные — из блока data-theme="dark".
//
// ЧТО ЭТО. Второй блок стилей поверх стилей движка (features/tv/engine/page.ts).
// Подключает его features/tv/ui/tvScreen.ts, сам движок не менялся. Здесь только
// «краска»: цвета, шрифт, скругления, рамки, тени. Позиции и размеры не трогаем —
// сетку плиток считает скрипт движка от ширины экрана.
//
// ОГРАНИЧЕНИЯ ТЕ ЖЕ, ЧТО У ДВИЖКА (см. шапку engine/page.ts): браузеры телевизоров
// 2016–2019, Chromium 38–63. Поэтому БЕЗ CSS-переменных, grid и gap; flex и анимации —
// с -webkit-. Тема — классом на body: тёмная по умолчанию, светлая — .th-light.
// Каждому правилу движка с .th-light здесь соответствует своё, иначе в светлой теме
// проступят старые цвета.
//
// ШРИФТ — Montserrat, лежит рядом с приложением (public/tv/assets, отдаётся без
// сессии — путь под /tv открыт в proxy.ts). Google Fonts не подключаем по той же
// причине, что и движок: телевизор без доступа к Google ждал бы таймаута. Начертаний
// три — 400/500/700; движок просит ещё 600 и 800, браузер подставит вместо них 700.
//
// ПАЛИТРА (тёмная / светлая):
//   фон            #141B24 / #F3F6F7      поверхность  #1F2937 / #FFFFFF
//   текст          #E7ECEF / #343433      приглушённый #A3ABB8 / #5F6672
//   синий бренда   #4C9BE0 / #005CA9      линии        #2E3A4A / #E5E7EB
//   выполнено      #4CD068 / #007A1B      брони        #9CCBF2 / #0055C4
//   песочный акцент #F2CC7F (в светлой текстом — #9A6B00): «ещё не выполнено»,
//   объявления, фокус пульта.

export const TV_SKIN_CSS = String.raw`
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-400.woff2) format("woff2");font-weight:400;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-500.woff2) format("woff2");font-weight:500;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-700.woff2) format("woff2");font-weight:700;font-style:normal}
body{font-family:MontserratTV,Montserrat,"Segoe UI",Roboto,Arial,sans-serif;background:#141B24;color:#E7ECEF}
body.th-light{background:#F3F6F7;color:#343433}
.muted{color:#A3ABB8}.th-light .muted{color:#5F6672}

/* ── Левая панель отдела: карточка с синей полосой сверху (как главный KPI в макетах) */
.side{background:#1F2937;border-color:#1F2937;border-radius:.6vw;-webkit-box-shadow:inset 0 .32vw 0 0 #4C9BE0;box-shadow:inset 0 .32vw 0 0 #4C9BE0}
.th-light .side{background:#FFFFFF;border-color:#FFFFFF;-webkit-box-shadow:inset 0 .32vw 0 0 #005CA9;box-shadow:inset 0 .32vw 0 0 #005CA9}
.dept{font-weight:700;letter-spacing:0}
.dept .muted{font-weight:500}

/* ── Столбец «% плана дня». Заливка — приглушённый синий с яркой кромкой уровня: так
   крупная цифра процента читается и поверх заливки, и на пустой части столбца
   (ярко-синяя заливка под цифрой давала бы слабый контраст). План выполнен — зелёный. */
.col .track{background:#19212C;border-color:#19212C;border-radius:.6vw}
.th-light .col .track{background:#E7ECEF;border-color:#E7ECEF}
.col .fill{background:#2F5E8A;border-top:.28vw solid #4C9BE0;border-radius:0}
.col .fill.ok{background:#1E7A3C;border-top-color:#4CD068}
.col .fill.ok.over{border-radius:0}
.th-light .col .fill{background:#8FB4DA;border-top-color:#005CA9}
.th-light .col .fill.ok{background:#A6DDB3;border-top-color:#009B22}
.col .pct{color:#E7ECEF;font-weight:700;text-shadow:0 .1vw .6vw rgba(20,27,36,.55)}
.th-light .col .pct{color:#020217;text-shadow:none}
.col .cap{color:#E7ECEF}.th-light .col .cap{color:#020217}
.col .mark{border-top-color:#F2CC7F}.col .mark span{color:#F2CC7F}

/* ── Цифры под столбцом: план — нейтральный, факт — зелёный, брони — голубой */
.sst .l{color:#A3ABB8}.th-light .sst .l{color:#5F6672}
.sst .v{font-weight:700}
.sst .v.fact{color:#4CD068}.th-light .sst .v.fact{color:#007A1B}
.sst .v.book{color:#9CCBF2}.th-light .sst .v.book{color:#0055C4}
.sst .v.warn{color:#F2CC7F}.th-light .sst .v.warn{color:#9A6B00}
.sst .v small{color:#A3ABB8}.th-light .sst .v small{color:#5F6672}

/* ── Плитки менеджеров и карточки филиалов: плоские, без рамок. Лидер — синяя полоса
   слева (как строка лидера в таблицах макета), а не отдельный цвет фона. */
.tile{background:#1F2937;border-color:#1F2937;border-radius:.6em}
.th-light .tile{background:#FFFFFF;border-color:#FFFFFF}
.tile.card{border-color:#1F2937}.th-light .tile.card{border-color:#FFFFFF}
.tile.top{background:#1F2937;border-color:#1F2937;-webkit-box-shadow:inset .32em 0 0 0 #4C9BE0;box-shadow:inset .32em 0 0 0 #4C9BE0}
.th-light .tile.top{background:#FFFFFF;border-color:#FFFFFF;-webkit-box-shadow:inset .32em 0 0 0 #005CA9;box-shadow:inset .32em 0 0 0 #005CA9}
/* Фокус пульта — песочная обводка, виден на любой плитке */
.tile.focus{-webkit-box-shadow:0 0 0 .3vw #F2CC7F;box-shadow:0 0 0 .3vw #F2CC7F}
.tile.top.focus{-webkit-box-shadow:inset .32em 0 0 0 #4C9BE0,0 0 0 .3vw #F2CC7F;box-shadow:inset .32em 0 0 0 #4C9BE0,0 0 0 .3vw #F2CC7F}
.th-light .tile.top.focus{-webkit-box-shadow:inset .32em 0 0 0 #005CA9,0 0 0 .3vw #F2CC7F;box-shadow:inset .32em 0 0 0 #005CA9,0 0 0 .3vw #F2CC7F}

/* Аватар без фото — нейтральный кружок с синими инициалами. Движок красит его
   инлайн-стилем в один из пяти цветов по имени, поэтому здесь !important. */
.ava{background:#2E3A4A !important;color:#4C9BE0}
.th-light .ava{background:#E7ECEF !important;color:#005CA9}
.ava.dep{background:#16314A !important;border-radius:.5em}
.th-light .ava.dep{background:#E5EEF6 !important}
.name{font-weight:700}

/* Место в рейтинге: первые три — значки-кружки (1 — залит синим, 2 — мягкий синий,
   3 — контур), остальные — просто цифра. Привязка к атрибуту data-i, который движок
   ставит на плитку: класса «место» у него нет. */
.rank{color:#8A93A1;font-weight:700}.th-light .rank{color:#7C818B}
.tile[data-i="0"] .rank,.tile[data-i="1"] .rank,.tile[data-i="2"] .rank{width:1.9em;min-width:1.9em;height:1.9em;line-height:1.9em;border-radius:1em;text-align:center}
.tile[data-i="0"] .rank{background:#4C9BE0;color:#0B1420}
.tile[data-i="1"] .rank{background:#213F5E;color:#9CCBF2}
.tile[data-i="2"] .rank{color:#9CCBF2;-webkit-box-shadow:inset 0 0 0 .14em #2F5E8A;box-shadow:inset 0 0 0 .14em #2F5E8A}
.th-light .tile[data-i="0"] .rank{background:#005CA9;color:#FFFFFF}
.th-light .tile[data-i="1"] .rank{background:#E5EEF6;color:#005CA9}
.th-light .tile[data-i="2"] .rank{color:#005CA9;-webkit-box-shadow:inset 0 0 0 .14em #E5EEF6;box-shadow:inset 0 0 0 .14em #E5EEF6}

/* Сумма продаж — главная цифра плитки, нейтральная. Цветом говорит только статус:
   процент и полоса ниже плана — песочный/синий, план выполнен — зелёная полоса. */
.hero .v{color:#E7ECEF;font-weight:700}.th-light .hero .v{color:#343433}
.hero .v small{color:#A3ABB8}.th-light .hero .v small{color:#5F6672}
.hero .p{font-weight:700}
.hero .p.warn{color:#F2CC7F}.th-light .hero .p.warn{color:#9A6B00}
.bar{background:#2E3A4A}.th-light .bar{background:#E5E7EB}
.bar i{background:#2FBF4F}.bar.warn i{background:#4C9BE0}
.th-light .bar i{background:#009B22}.th-light .bar.warn i{background:#005CA9}
.sub{color:#A3ABB8}.th-light .sub{color:#5F6672}
.sub b{color:#E7ECEF;font-weight:700}.th-light .sub b{color:#343433}
.sub b.book{color:#9CCBF2}.th-light .sub b.book{color:#0055C4}
.pb{border-top-color:#2E3A4A}.th-light .pb{border-top-color:#E5E7EB}
.pb .l{color:#A3ABB8}.th-light .pb .l{color:#5F6672}
.pb .n{color:#F2CC7F;font-weight:700}.th-light .pb .n{color:#9A6B00}
.pb .n.ok{color:#4CD068}.th-light .pb .n.ok{color:#007A1B}
.pb .n small{color:#A3ABB8}.th-light .pb .n small{color:#5F6672}
.pb .n.book{color:#9CCBF2}.th-light .pb .n.book{color:#0055C4}
.pb .n.book.ok{color:#4CD068}.th-light .pb .n.book.ok{color:#007A1B}

/* ── Низ экрана: голова Монолитика на плитке перед датой, точки-страницы, бегущая строка */
.ftr{color:#A3ABB8}.th-light .ftr{color:#5F6672}
.ftr b{color:#E7ECEF}.th-light .ftr b{color:#343433}
.ftr>div:first-child:before{content:"";display:inline-block;vertical-align:middle;width:2.9vw;height:1.8vw;margin-right:.7vw;border-radius:.4vw;background:#2B3747 url(/tv/assets/monolitik-head.png) no-repeat center;-webkit-background-size:2.3vw auto;background-size:2.3vw auto}
.th-light .ftr>div:first-child:before{background-color:#E7ECEF}
.dots span{background:#2E3A4A}.th-light .dots span{background:#D1D5DB}
.dots span.on{background:#4C9BE0}.th-light .dots span.on{background:#005CA9}
.ticker{background:#1F2937;border-color:#1F2937;border-radius:.5vw}
.th-light .ticker{background:#E7ECEF;border-color:#E7ECEF}
.ticker span{font-weight:500}
.ticker span b{color:#4C9BE0}.th-light .ticker span b{color:#005CA9}

/* ── Плашка паузы и кнопки пульта */
.pill{color:#E7ECEF;font-weight:500}.th-light .pill{color:#343433}
.pill .ico{color:#F2CC7F}.th-light .pill .ico{color:#9A6B00}
.pill .pbtn{border-color:#4C9BE0;background:#4C9BE0;color:#0B1420;border-radius:.5vw;font-weight:700}
.pill .pbtn.go{background:transparent;color:#4C9BE0}
.th-light .pill .pbtn{border-color:#005CA9;background:#005CA9;color:#FFFFFF}
.th-light .pill .pbtn.go{background:transparent;color:#005CA9}

/* ── Служебные состояния и объявления */
.empty{color:#A3ABB8}.th-light .empty{color:#5F6672}
.off{color:#F2CC7F;background:rgba(2,2,23,.6)}
.banner{background:#F2CC7F;color:#343433;border-radius:.6vw;font-weight:700;-webkit-box-shadow:0 .6vw 2vw rgba(2,2,23,.35);box-shadow:0 .6vw 2vw rgba(2,2,23,.35)}
.full{background:#141B24}.th-light .full{background:#F3F6F7}
.full .t{font-weight:700}
.full .s{color:#A3ABB8}.th-light .full .s{color:#5F6672}

/* ── Экран привязки: робот Монолитик, «МОНОЛИТИКА / аналитика», код на плашке.
   Движок рисует его всегда в тёмной теме. */
.pair{padding-top:6vh}
.pair .logo{color:#E7ECEF;letter-spacing:.04em}
.pair .logo:before{content:"";display:block;width:10.1vw;height:9vw;margin:0 auto 1vw;background:url(/tv/assets/monolitik-robot.png) no-repeat center;-webkit-background-size:contain;background-size:contain}
.pair .logo:after{content:"аналитика";display:block;font-size:.62em;font-weight:500;letter-spacing:0;color:#A3ABB8;margin-top:.15vw}
.pair .h{color:#A3ABB8;margin-top:3vh}
.pair .code{display:inline-block;font-family:inherit;font-size:11vw;font-weight:700;letter-spacing:.14em;color:#E7ECEF;background:#1F2937;border-radius:1vw;padding:1.4vw 2.2vw 1.4vw 3.7vw;-webkit-box-shadow:inset 0 .32vw 0 0 #4C9BE0;box-shadow:inset 0 .32vw 0 0 #4C9BE0}
.pair .hint{color:#A3ABB8;margin-top:3vh}
.pair .hint b{color:#E7ECEF;font-weight:700}
.pair .url{color:#A3ABB8}

/* ── Поздравление с продажей / выполненным планом. Конфетти движок красит
   инлайн-стилем в семь цветов — здесь оно в цветах бренда: синий, песочный, светлый. */
.cele{background:rgba(20,27,36,.93)}
.th-light .cele{background:rgba(243,246,247,.95)}
/* «Вспышка»: в пике фон остаётся плотным, иначе сквозь него проступают плитки и текст
   поздравления теряется. У светлой темы свои ключевые кадры — у движка они общие, тёмные. */
@-webkit-keyframes flash{0%,100%{background:rgba(20,27,36,.93)}50%{background:rgba(47,94,138,.95)}}
@keyframes flash{0%,100%{background:rgba(20,27,36,.93)}50%{background:rgba(47,94,138,.95)}}
@-webkit-keyframes flashl{0%,100%{background:rgba(243,246,247,.95)}50%{background:rgba(143,180,218,.96)}}
@keyframes flashl{0%,100%{background:rgba(243,246,247,.95)}50%{background:rgba(143,180,218,.96)}}
.th-light .cele.flash{-webkit-animation-name:flashl;animation-name:flashl}
.cele .k{color:#F2CC7F;font-weight:700;letter-spacing:.14em}.th-light .cele .k{color:#005CA9}
.cele .ava{margin-top:.8vw}
.cele .who{font-weight:700}
.cele .amt{color:#4CD068;font-weight:700}.th-light .cele .amt{color:#007A1B}
.cele .d{color:#A3ABB8}.th-light .cele .d{color:#5F6672}
.cf{background:#4C9BE0 !important}
.cf:nth-child(3n){background:#F2CC7F !important}
.cf:nth-child(3n+1){background:#E7ECEF !important}
.th-light .cf{background:#005CA9 !important}
.th-light .cf:nth-child(3n){background:#F2CC7F !important}
.th-light .cf:nth-child(3n+1){background:#8FB4DA !important}
.toast{background:#1F2937;border-color:#3D4A5C;color:#E7ECEF;border-radius:.6vw}
.th-light .toast{background:#FFFFFF;border-color:#D1D5DB;color:#343433}
.toast b{color:#4CD068}.th-light .toast b{color:#007A1B}
`;
