// Оформление экрана телевизора «Кольца» — по макету владельца от 07.10 (тёмно-синий
// экран: шапка с названием отдела и датой, слева панель отдела с большим кольцом
// выполнения плана, справа плитки менеджеров: кольцо, «План» слева и «Факт» справа,
// три показателя внизу, короны у первых трёх мест, рейтинг 6–10 в последней ячейке).
//
// Этот макет меняет не только цвета, но и РАСПОЛОЖЕНИЕ. Разметку экрана выдаёт движок
// (features/tv/engine/page.ts), а его менять нельзя. Поэтому здесь две части:
//   • tvSkinRings.ts (этот файл) — стили;
//   • tvViewRings.ts — небольшой скрипт вида: он читает то, что движок уже нарисовал,
//     и рядом рисует то же самое в новой раскладке. Данные, опрос, карусель, события,
//     привязка — всё по-прежнему делает движок.
//
// СТИЛИ ИЗ ДВУХ СЛОЁВ.
//   1. Запасной: перекраска родной разметки движка. Работает, если скрипт вида не
//      запустился (очень старый браузер) или споткнулся — экран остаётся рабочим,
//      просто в раскладке движка.
//   2. Основной: всё, что начинается с «html.tvx». Класс tvx на <html> ставит скрипт
//      вида, когда стартует, и снимает, если что-то пошло не так.
//
// ОГРАНИЧЕНИЯ ТЕ ЖЕ, что у движка: браузеры телевизоров 2016–2019 (Chromium 38–63) —
// без CSS-переменных, grid и gap; перед градиентом — сплошной цвет. Свечение сделано
// тенью рамки и вторым полупрозрачным штрихом кольца, без CSS-фильтров: фильтры на
// слабых телевизорах тормозят смену страниц.
//
// ПАЛИТРА (тёмная / светлая; в макете светлой нет — она выведена из тёмной):
//   фон        #050D18 / #EDF1F6      карточка      #0A1727 / #FFFFFF
//   вложенный  #081220 / #F3F6FA      рамка         #14304E / #D9E2EC
//   текст      #FFFFFF / #0E1B2C      приглушённый  #8FA6C2 / #63748A
// ЦВЕТ = СМЫСЛ:
//   мятный   #19E3A0 / #0A9E6B — факт, продажи, ход выполнения плана
//   синий    #2D9BFF / #1272D6 — брони
//   янтарный #F6B81B / #C98A00 — кольцо, пока выполнено меньше четверти плана
//   золото / серебро / бронза — рамка и корона 1, 2 и 3 места

export const TV_SKIN_RINGS_CSS = String.raw`
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-400.woff2) format("woff2");font-weight:400;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-500.woff2) format("woff2");font-weight:500;font-style:normal}
@font-face{font-family:MontserratTV;src:url(/tv/assets/montserrat-700.woff2) format("woff2");font-weight:700;font-style:normal}
body{font-family:MontserratTV,Montserrat,"Segoe UI",Roboto,Arial,sans-serif;background:#050D18;color:#FFFFFF}
body{background-image:-webkit-radial-gradient(28% 0%,ellipse farthest-corner,#0C2238 0%,#050D18 62%);background-image:radial-gradient(ellipse farthest-corner at 28% 0%,#0C2238 0%,#050D18 62%)}
body.th-light{background:#EDF1F6;color:#0E1B2C}
.muted{color:#8FA6C2}.th-light .muted{color:#63748A}

/* ══ 1. ЗАПАСНОЙ СЛОЙ — родная разметка движка в новой палитре ══ */
.side,.tile,.tile.top,.ticker{background:#0A1727;border-color:#14304E}
.th-light .side,.th-light .tile,.th-light .tile.top,.th-light .ticker{background:#FFFFFF;border-color:#D9E2EC}
.col .track{background:#081220;border-color:#14304E}.th-light .col .track{background:#F3F6FA;border-color:#E3EAF2}
.col .fill{background:#F6B81B}.col .fill.ok{background:#19E3A0}
.col .pct,.col .cap{color:#FFFFFF}.th-light .col .pct,.th-light .col .cap{color:#0E1B2C}
.hero .v,.sst .v.fact,.pb .n.ok,.pb .n.book.ok{color:#19E3A0}
.th-light .hero .v,.th-light .sst .v.fact,.th-light .pb .n.ok,.th-light .pb .n.book.ok{color:#0A9E6B}
.sst .v.book,.sub b.book,.pb .n.book{color:#4DA8FF}
.th-light .sst .v.book,.th-light .sub b.book,.th-light .pb .n.book{color:#1272D6}
.sst .v.warn,.hero .p.warn,.pb .n,.tile.top .rank{color:#F6B81B}
.th-light .sst .v.warn,.th-light .hero .p.warn,.th-light .pb .n,.th-light .tile.top .rank{color:#C98A00}
.sst .l,.sub,.pb .l,.rank,.hero .v small,.pb .n small,.sst .v small{color:#8FA6C2}
.th-light .sst .l,.th-light .sub,.th-light .pb .l,.th-light .rank,.th-light .hero .v small,.th-light .pb .n small,.th-light .sst .v small{color:#63748A}
.sub b{color:#FFFFFF}.th-light .sub b{color:#0E1B2C}
.bar{background:#12263E}.th-light .bar{background:#E3EAF2}
.bar i,.th-light .bar i{background:#19E3A0}.bar.warn i,.th-light .bar.warn i{background:#F6B81B}
.pb{border-top-color:#14304E}.th-light .pb{border-top-color:#E3EAF2}
.ava{background:#12263E !important;color:#DCE8F7}
.th-light .ava{background:#E3EAF2 !important;color:#0E1B2C}
.ava.dep{border-radius:.55em}
.tile.card{border-color:#1D4A78}.th-light .tile.card{border-color:#B9CCE0}
.tile.focus,.th-light .tile.focus{-webkit-box-shadow:0 0 0 .3vw #2D9BFF;box-shadow:0 0 0 .3vw #2D9BFF}

/* ══ 2. ОСНОВНОЙ СЛОЙ — раскладка макета; действует, пока на <html> стоит класс tvx ══ */
.nx,.nx-side,.nx-head,.nx-rate{display:none}
html.tvx .nx,html.tvx .nx-head,html.tvx .nx-rate{display:block}
html.tvx .nx-side{display:-webkit-flex;display:flex}
html.tvx .tile>.inner,html.tvx .side>.dept,html.tvx .side>.col,html.tvx .side>.sst,html.tvx .nx-hide,html.tvx .ftr>div:first-child{display:none}

/* ── Каркас: шапка сверху, панель отдела шире, низ без строки с датой. Сетку плиток
   по-прежнему считает скрипт движка — он просто меряет то место, что ему оставлено. */
html.tvx .slide{left:1.1vw;right:1.1vw;top:.9vw;bottom:1vw}
html.tvx .sides{top:4.7vw;width:29.6vw}
html.tvx .side{width:29.6vw;padding:0;border-radius:1.1vw;background:#0A1727;background:-webkit-linear-gradient(top,#0C1C30,#081424);background:linear-gradient(to bottom,#0C1C30,#081424);border:1px solid #14304E}
html.tvx .th-light .side{background:#FFFFFF;border-color:#D9E2EC}
html.tvx .main{left:30.8vw;top:4.7vw}
html.tvx .grid{bottom:0}
html.tvx .grid.tk{bottom:3.4vw}
html.tvx .ticker{bottom:0;height:2.6vw;border-radius:.8vw}
html.tvx .ticker span{font-weight:500}
/* строка движка с паузой и точками-страницами переезжает в шапку, дата из неё скрыта */
html.tvx .ftr{top:-3.75vw;bottom:auto;left:6vw;right:25.5vw;height:2.4vw;-webkit-box-pack:end;-webkit-justify-content:flex-end;justify-content:flex-end}
html.tvx .off{left:auto;bottom:auto;right:.4vw;top:3.1vw;font-size:.8vw}

/* ── Шапка: отдел слева, дата и время обновления справа */
.nx-head{position:absolute;left:0;right:0;top:0;height:3.9vw}
.nx-ti{position:absolute;left:.5vw;top:0;max-width:36vw;font-size:2.55vw;font-weight:700;line-height:3.5vw;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nx-ti small{font-size:.5em;font-weight:500;color:#8FA6C2;margin-left:.9vw;letter-spacing:0}
.th-light .nx-ti small{color:#63748A}
.nx-dt{position:absolute;right:.4vw;top:0;line-height:3.5vw;font-size:1.05vw;font-weight:500;white-space:nowrap;color:#E6EEF8}
.th-light .nx-dt{color:#0E1B2C}
.nx-dt .nx-ic{display:inline-block;vertical-align:middle;width:1.5vw;height:1.5vw;margin:-.2vw .7vw 0 0}
.nx-dt i{display:inline-block;vertical-align:middle;width:1px;height:1.5vw;background:#2A405C;margin:0 1.2vw}
.th-light .nx-dt i{background:#C3CFDC}

/* ── Общие детали: значки, кольцо, «План / Факт» */
.nx-ic{display:block}
.nx-ic .c{fill:currentColor;stroke:#081220;stroke-width:1.3}
.th-light .nx-ic .c{stroke:#F3F6FA}
.nx-rg{display:block;width:100%;height:100%}
.nx-rg .t{stroke:#0F2236}.th-light .nx-rg .t{stroke:#E3EAF2}
.nx-rg .a,.nx-rg .g{stroke:#19E3A0}.nx-rg .g{opacity:.18}
.nx-rg.lo .a,.nx-rg.lo .g{stroke:#F6B81B}
.th-light .nx-rg .a,.th-light .nx-rg .g{stroke:#10B981}
.th-light .nx-rg.lo .a,.th-light .nx-rg.lo .g{stroke:#E0A100}
.nx-rt{position:absolute;left:0;top:0;right:0;bottom:0;display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column;-webkit-justify-content:center;justify-content:center;-webkit-align-items:center;align-items:center;text-align:center;line-height:1;white-space:nowrap}
.nx-rt b{display:block;font-weight:700;letter-spacing:-.02em}
.nx-rt span{display:block;color:#C5D6EA}
.th-light .nx-rt span{color:#63748A}
.nx-c{-webkit-flex:none;flex:none}
.nx-c .l{display:block;color:#A9BDD6}
.th-light .nx-c .l{color:#63748A}
.nx-c .v{display:block;line-height:1.05}
.nx-pl .v{font-weight:500;color:#B7D3F2}
.th-light .nx-pl .v{color:#3D5673}
.nx-fa .v{font-weight:700;color:#19E3A0;letter-spacing:-.01em}
.th-light .nx-fa .v{color:#0A9E6B}
.nx-u{font-style:normal;font-size:.74em;margin-left:.22em;letter-spacing:0}
.nx-sl{-webkit-flex:none;flex:none;font-weight:400;color:#3F5876;line-height:1.05}
/* строка «План / Факт» целиком; если не влезает, скрипт вида уменьшает ей шрифт */
.nx-fi{-webkit-flex:none;flex:none;display:-webkit-flex;display:flex;-webkit-align-items:flex-end;align-items:flex-end;white-space:nowrap}
.th-light .nx-sl{color:#A6B4C4}

/* ── Панель отдела: «План / Факт», большое кольцо, три показателя столбиком */
.nx-side{position:absolute;left:0;top:0;right:0;bottom:0;padding:1.6vw .8vw .8vw;-webkit-flex-direction:column;flex-direction:column}
.nx-spf{-webkit-flex:none;flex:none;margin:0 .3vw 0 1.1vw;font-size:2.85vw;display:-webkit-flex;display:flex;-webkit-align-items:flex-end;align-items:flex-end;overflow:hidden}
.nx-spf .l{font-size:.44em;margin-bottom:.25em}
.nx-spf .nx-fa .v{font-size:1.22em}
.nx-spf .nx-sl{margin:0 .32em .06em}
/* кольцо занимает всё, что осталось между строкой «План / Факт» и показателями; размер
   шрифта подписи в центре скрипт вида задаёт от фактического диаметра (em ниже — от него) */
.nx-sr{-webkit-flex:1 1 0%;flex:1 1 0%;min-height:0;position:relative;margin:1.3vw 1.2vw .5vw}
.nx-sr .nx-rg{position:absolute;left:0;top:0}
.nx-sr .nx-rt{font-size:4.5vw}
.nx-sr .nx-rt b{font-size:1em}
.nx-sr .nx-rt.w4 b{font-size:.84em}
.nx-sr .nx-rt span{font-size:.28em;margin-top:.42em}
.nx-sb{-webkit-flex:none;flex:none}
.nx-sx{position:relative;height:12.6vh;max-height:7.1vw;margin-top:.75vw;border-radius:.9vw;background:#081220;border:1px solid #12263E;white-space:nowrap;overflow:hidden}
.th-light .nx-sx{background:#F3F6FA;border-color:#E3EAF2}
.nx-sx .nx-ic{position:absolute;left:1.7vw;top:50%;margin-top:-1.55vw;width:3.1vw;height:3.1vw}
.nx-sx .tx{position:absolute;left:7vw;right:.6vw;top:50%;margin-top:-2.55vw}
.nx-sx .l{display:block;font-size:1.25vw;line-height:1.5vw;color:#B5C7DD}
.th-light .nx-sx .l{color:#63748A}
.nx-sx .l small{font-size:.8em;color:#6F86A3;margin-left:.7vw}
.nx-sx .n{display:block;font-size:2.7vw;font-weight:700;line-height:3.3vw;margin-top:.2vw}
.nx-sx.m .n{font-size:2.9vw}
.nx-sx .n small,.nx-x .n small{font-size:1em;font-weight:500;color:#6F86A3;margin-left:.24em}
.th-light .nx-sx .n small,.th-light .nx-x .n small,.th-light .nx-sx .l small{color:#8496AB}
.nx-sx.s .nx-ic,.nx-sx.s .n,.nx-x.s .nx-ic,.nx-x.s .n,.nx-x.b .n.ok{color:#19E3A0}
.th-light .nx-sx.s .nx-ic,.th-light .nx-sx.s .n,.th-light .nx-x.s .nx-ic,.th-light .nx-x.s .n,.th-light .nx-x.b .n.ok{color:#0A9E6B}
.nx-sx.b .nx-ic,.nx-sx.b .n,.nx-sx.m .nx-ic,.nx-sx.m .n,.nx-x.b .nx-ic,.nx-x.m .nx-ic{color:#2D9BFF}
.th-light .nx-sx.b .nx-ic,.th-light .nx-sx.b .n,.th-light .nx-sx.m .nx-ic,.th-light .nx-sx.m .n,.th-light .nx-x.b .nx-ic,.th-light .nx-x.m .nx-ic{color:#1272D6}

/* ── Плитка. Размеры в em: скрипт движка задаёт плитке размер шрифта, и всё внутри
   растёт вместе с ней. Плитка не меньше 19em в ширину и 11.9em в высоту. */
html.tvx .tile,html.tvx .nx-rate{padding:0;border-radius:.85em;background:#0A1727;background:-webkit-linear-gradient(top,#0C1C30,#081424);background:linear-gradient(to bottom,#0C1C30,#081424);border:1px solid #14304E}
html.tvx .th-light .tile,html.tvx .th-light .nx-rate{background:#FFFFFF;border-color:#D9E2EC}
html.tvx .tile.card{cursor:pointer}
/* 1, 2 и 3 место: цветная рамка, тёплый отсвет из угла, мягкое свечение */
html.tvx .tile.nx-g1{border:.12em solid #F4C20D;background:#0E1A22;background:-webkit-radial-gradient(0% 0%,ellipse farthest-corner,rgba(244,170,13,.26) 0%,rgba(244,170,13,0) 58%),-webkit-linear-gradient(top,#0C1C30,#081424);background:radial-gradient(ellipse farthest-corner at 0% 0%,rgba(244,170,13,.26) 0%,rgba(244,170,13,0) 58%),linear-gradient(to bottom,#0C1C30,#081424);-webkit-box-shadow:0 0 1.2em rgba(244,194,13,.28);box-shadow:0 0 1.2em rgba(244,194,13,.28)}
html.tvx .tile.nx-g2{border:.12em solid #C2CDDA;background:#0C1826;background:-webkit-radial-gradient(0% 0%,ellipse farthest-corner,rgba(170,195,225,.18) 0%,rgba(170,195,225,0) 58%),-webkit-linear-gradient(top,#0C1C30,#081424);background:radial-gradient(ellipse farthest-corner at 0% 0%,rgba(170,195,225,.18) 0%,rgba(170,195,225,0) 58%),linear-gradient(to bottom,#0C1C30,#081424);-webkit-box-shadow:0 0 1em rgba(194,205,218,.16);box-shadow:0 0 1em rgba(194,205,218,.16)}
html.tvx .tile.nx-g3{border:.12em solid #F0652B;background:#10161F;background:-webkit-radial-gradient(0% 0%,ellipse farthest-corner,rgba(240,101,43,.22) 0%,rgba(240,101,43,0) 58%),-webkit-linear-gradient(top,#0C1C30,#081424);background:radial-gradient(ellipse farthest-corner at 0% 0%,rgba(240,101,43,.22) 0%,rgba(240,101,43,0) 58%),linear-gradient(to bottom,#0C1C30,#081424);-webkit-box-shadow:0 0 1em rgba(240,101,43,.22);box-shadow:0 0 1em rgba(240,101,43,.22)}
html.tvx .th-light .tile.nx-g1{border-color:#E0A800;background:#FFFBEF;-webkit-box-shadow:0 0 1em rgba(224,168,0,.28);box-shadow:0 0 1em rgba(224,168,0,.28)}
html.tvx .th-light .tile.nx-g2{border-color:#9AA8B8;background:#F8FAFC;-webkit-box-shadow:0 0 1em rgba(120,140,165,.22);box-shadow:0 0 1em rgba(120,140,165,.22)}
html.tvx .th-light .tile.nx-g3{border-color:#E05A1E;background:#FFF7F2;-webkit-box-shadow:0 0 1em rgba(224,90,30,.22);box-shadow:0 0 1em rgba(224,90,30,.22)}
html.tvx .tile.focus,html.tvx .th-light .tile.focus{-webkit-box-shadow:0 0 0 .3vw #2D9BFF;box-shadow:0 0 0 .3vw #2D9BFF}
.nx{position:absolute;left:0;top:0;right:0;bottom:0}
/* верх: место, аватар, имя */
.nx-h{position:absolute;left:.75em;right:.9em;top:.55em;height:2.5em;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center}
.nx-k{-webkit-flex:none;flex:none;position:relative;width:1.9em;height:1.9em;margin-right:.7em;border-radius:.4em;background:#102238;text-align:center}
.th-light .nx-k{background:#E3EAF2}
.nx-k b{display:block;font-size:1.15em;font-weight:700;line-height:1.65em;color:#DCE8F7}
.th-light .nx-k b{color:#0E1B2C}
.nx-k.g1,.nx-k.g2,.nx-k.g3,.th-light .nx-k.g1,.th-light .nx-k.g2,.th-light .nx-k.g3{width:2em;height:2.3em;background:none;border-radius:0}
.nx-k svg{display:block;position:absolute;left:0;top:0;width:100%;height:100%}
.nx-k.g1 b,.nx-k.g2 b,.nx-k.g3 b,.th-light .nx-k.g1 b,.th-light .nx-k.g2 b,.th-light .nx-k.g3 b{position:absolute;left:0;right:0;bottom:.14em;line-height:1.2em;color:#FFFFFF;text-shadow:0 .05em .18em rgba(0,0,0,.5)}
.nx-k.g1 svg{fill:#F2B90F}.nx-k.g2 svg{fill:#A3B1C2}.nx-k.g3 svg{fill:#EC5F26}
.nx .ava{-webkit-flex:none;flex:none;width:2.35em;height:2.35em;line-height:2.35em;margin-right:.7em;-webkit-box-shadow:0 0 0 .08em #29425F;box-shadow:0 0 0 .08em #29425F}
.th-light .nx .ava{-webkit-box-shadow:0 0 0 .08em #C3CFDC;box-shadow:0 0 0 .08em #C3CFDC}
.nx-nm{-webkit-flex:1;flex:1;min-width:0;font-size:1.15em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nx-nm small{font-size:.68em;font-weight:500;color:#8FA6C2;margin-left:.7em}
.th-light .nx-nm small{color:#63748A}
/* середина: кольцо с процентом, правее — «План» слева и «Факт» справа */
.nx-m{position:absolute;left:1.6em;right:.8em;top:3.2em;bottom:3.7em}
.nx-r{position:absolute;left:.3em;top:50%;margin-top:-2.5em;width:5em;height:5em}
.nx-r .nx-rt b{font-size:1.32em}
.nx-r .nx-rt.w4 b{font-size:1.12em}
.nx-r .nx-rt span{font-size:.66em;margin-top:.2em}
.nx-pf{position:absolute;left:7.4em;right:0;top:50%;margin-top:-1.95em;height:3.8em;display:-webkit-flex;display:flex;-webkit-align-items:flex-end;align-items:flex-end;overflow:hidden}
.nx-pf .l{font-size:.82em;margin-bottom:.35em}
.nx-pf .nx-pl .v{font-size:1.3em}
.nx-pf .nx-fa .v{font-size:1.95em}
.nx-pf .nx-sl{font-size:1.5em;margin:0 .5em .1em}
/* низ: продажи, брони, сумма броней */
.nx-b{position:absolute;left:.7em;right:.7em;bottom:.65em;height:2.7em;display:-webkit-flex;display:flex}
.nx-x{-webkit-flex:1 1 0%;flex:1 1 0%;min-width:0;margin-left:.5em;padding:0 .7em;border-radius:.55em;background:#081220;border:1px solid #12263E;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;white-space:nowrap;overflow:hidden}
.th-light .nx-x{background:#F3F6FA;border-color:#E3EAF2}
.nx-x:first-child{margin-left:0}
.nx-x.m{-webkit-flex:1.35 1 0%;flex:1.35 1 0%}
.nx-x .nx-ic{-webkit-flex:none;flex:none;width:1.45em;height:1.45em}
.nx-x .n{-webkit-flex:1 0 auto;flex:1 0 auto;text-align:center;font-size:1.3em;font-weight:700;line-height:1;padding-left:.35em}
.nx-x.m .n{font-size:1.2em}

/* ── Рейтинг 6–10 в ячейке шестой плитки */
.nx-rate{position:absolute;overflow:hidden}
.nx-ri{position:absolute;left:.9em;right:.9em;top:.7em}
.nx-rh{font-size:.82em;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:#C5D6EA;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.th-light .nx-rh{color:#63748A}
.nx-rr{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;height:1.68em;margin-top:.24em;border-radius:.35em;background:#0B1A2C}
.th-light .nx-rr{background:#F3F6FA}
.nx-rr .k{-webkit-flex:none;flex:none;width:1.9em;height:1.68em;line-height:1.68em;border-radius:.35em;background:#102238;text-align:center;font-weight:700;margin-right:.55em}
.th-light .nx-rr .k{background:#E3EAF2}
.nx-rr .a{-webkit-flex:none;flex:none;width:1.45em;height:1.45em;line-height:1.45em;border-radius:50%;background:#12263E;color:#DCE8F7;overflow:hidden;text-align:center;margin-right:.55em}
.th-light .nx-rr .a{background:#DCE4EE;color:#0E1B2C}
.nx-rr .a i{font-style:normal;font-size:.58em;font-weight:700;vertical-align:top}
.nx-rr .a img{display:block;width:100%;height:100%;-o-object-fit:cover;object-fit:cover}
.nx-rr .nm{-webkit-flex:0 1 9.6em;flex:0 1 9.6em;min-width:0;font-size:.95em;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nx-rr .br{-webkit-flex:1 1 0%;flex:1 1 0%;height:.5em;border-radius:1em;background:#0F2236;overflow:hidden;margin:0 .7em}
.th-light .nx-rr .br{background:#E3EAF2}
.nx-rr .br i{display:block;height:100%;border-radius:1em;background:#19E3A0}
.nx-rr .br i.lo{background:#F6B81B}
.th-light .nx-rr .br i{background:#10B981}.th-light .nx-rr .br i.lo{background:#E0A100}
.nx-rr .p{-webkit-flex:none;flex:none;width:3.2em;text-align:right;font-size:.95em;font-weight:700;padding-right:.5em}

/* ══ 3. ОБЩЕЕ ДЛЯ ОБОИХ СЛОЁВ — подвал, пауза, объявления, привязка, поздравления ══ */
.ftr{color:#8FA6C2}.th-light .ftr{color:#63748A}
.ftr b{color:#FFFFFF}.th-light .ftr b{color:#0E1B2C}
.dots span{background:#16304D}.th-light .dots span{background:#CBD6E2}
.dots span.on{background:#19E3A0}.th-light .dots span.on{background:#0A9E6B}
.ticker span b{color:#4DA8FF}.th-light .ticker span b{color:#1272D6}
.pill{color:#FFFFFF;font-weight:500}.th-light .pill{color:#0E1B2C}
.pill .ico{color:#F6B81B}
.pill .pbtn,.th-light .pill .pbtn{border-color:#2D9BFF;background:#1583F0;color:#FFFFFF;border-radius:.6vw;font-weight:500}
.pill .pbtn.go{background:transparent;color:#8FC4FF;border-radius:2vw}
.th-light .pill .pbtn.go{background:transparent;color:#1272D6;border-radius:2vw}
.empty{color:#8FA6C2}.th-light .empty{color:#63748A}
.off{color:#F6B81B;background:rgba(8,18,32,.85)}
.banner{background:#1272D6;background:-webkit-linear-gradient(left,#1583F0,#0B5CC0);background:linear-gradient(to right,#1583F0,#0B5CC0);color:#FFFFFF;border-radius:.9vw;font-weight:500;-webkit-box-shadow:0 .6vw 2vw rgba(0,0,0,.5);box-shadow:0 .6vw 2vw rgba(0,0,0,.5)}
.full{background:#050D18}.th-light .full{background:#EDF1F6}
.full .s{color:#8FA6C2}.th-light .full .s{color:#63748A}
/* экран привязки (движок рисует его всегда в тёмной теме): робот, название, код */
.pair{padding-top:6vh}
.pair .logo{color:#FFFFFF;letter-spacing:.04em;font-weight:700}
.pair .logo:before{content:"";display:block;width:10.1vw;height:9vw;margin:0 auto 1vw;background:url(/tv/assets/monolitik-robot.png) no-repeat center;-webkit-background-size:contain;background-size:contain}
.pair .logo:after{content:"аналитика";display:block;font-size:.62em;font-weight:400;letter-spacing:0;color:#8FA6C2;margin-top:.15vw}
.pair .h{color:#8FA6C2;margin-top:3vh}
.pair .code{display:inline-block;font-family:inherit;font-size:11vw;font-weight:700;letter-spacing:.14em;color:#19E3A0;background:#0A1727;border:1px solid #14304E;border-radius:1.6vw;padding:1.4vw 2.2vw 1.4vw 3.7vw}
.pair .hint{color:#8FA6C2;margin-top:3vh}
.pair .hint b{color:#FFFFFF;font-weight:500}
.pair .url{color:#8FA6C2}
/* поздравление с продажей / выполненным планом; конфетти движок красит инлайн-стилем,
   поэтому !important */
.cele{background:rgba(5,13,24,.94)}
.th-light .cele{background:rgba(237,241,246,.96)}
@-webkit-keyframes flash{0%,100%{background:rgba(5,13,24,.94)}50%{background:rgba(10,120,90,.95)}}
@keyframes flash{0%,100%{background:rgba(5,13,24,.94)}50%{background:rgba(10,120,90,.95)}}
@-webkit-keyframes flashl{0%,100%{background:rgba(237,241,246,.96)}50%{background:rgba(150,230,200,.97)}}
@keyframes flashl{0%,100%{background:rgba(237,241,246,.96)}50%{background:rgba(150,230,200,.97)}}
.th-light .cele.flash{-webkit-animation-name:flashl;animation-name:flashl}
.cele .k,.th-light .cele .k{display:inline-block;color:#04130D;font-size:2.2vw;font-weight:700;letter-spacing:.12em;background:#19E3A0;border-radius:3vw;padding:.7vw 2.2vw .7vw 2.5vw}
.cele .ava{margin-top:1.4vw;-webkit-box-shadow:0 0 0 .25vw #19E3A0;box-shadow:0 0 0 .25vw #19E3A0}
.cele .who{font-weight:700}
.cele .amt{color:#19E3A0;font-weight:700}.th-light .cele .amt{color:#0A9E6B}
.cele .d{color:#8FA6C2}.th-light .cele .d{color:#63748A}
.cf{background:#19E3A0 !important}
.cf:nth-child(5n){background:#2D9BFF !important}
.cf:nth-child(5n+1){background:#F4C20D !important}
.cf:nth-child(5n+2){background:#F0652B !important}
.cf:nth-child(5n+3){background:#FFFFFF !important}
.th-light .cf:nth-child(5n+3){background:#7C3AED !important}
.toast{background:#0A1727;border-color:#1D4A78;color:#FFFFFF;border-radius:.9vw}
.th-light .toast{background:#FFFFFF;border-color:#D9E2EC;color:#0E1B2C}
.toast b{color:#19E3A0;font-weight:700}.th-light .toast b{color:#0A9E6B}
`;
