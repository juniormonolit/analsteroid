// «Телевизоры» — публичная страница телевизора: готовый HTML + инлайн CSS/JS.
//
// ПОЧЕМУ НЕ REACT. Телевизоры в отделах разных лет; движки встроенных браузеров:
// Samsung Tizen 2017–2019 — Chromium 47–63, LG webOS 3.x/4.x (2016–2019) —
// Chromium 38/53. Клиентский рантайм Next/React 19 там не поднимается, а ещё нет
// CSS custom properties (Chromium 49), CSS Grid (57), flex-gap (84), fetch (42),
// ES6-синтаксиса (стрелки/const/шаблонные строки — Chromium ~49+). Поэтому здесь:
//   • строка HTML, отдаваемая route handler-ом (app/tv/route.ts, app/tv/s/[token]);
//   • CSS без переменных: тема — классом на <body> (.th-dark / .th-light), размеры
//     плиток — в em от font-size плитки, который выставляет JS (fit());
//   • flexbox с -webkit- префиксами, сетка плиток — position:absolute в px из JS;
//   • JS строго ES5: var, function, XHR, без Promise/fetch/Intl (toLocaleString на
//     старых ТВ даёт мусор — форматирование сумм своё).
// Визуальный эталон — макет владельца (Downloads/tv_dashboard_design.zip, 07.09):
// плитки менеджеров по убыванию продаж, лидер подсвечен, шапка отдела с планом/
// фактом/выполнением/бронями, карусель с точками, две темы. Шрифт — системный
// стек (Inter, если установлен): внешний @import Google Fonts на телевизоре без
// интернета до Google блокировал бы рендер до таймаута.

import { TV_POLL_SEC } from '../shared';

export interface TvPageConfig {
  /** device — телевизор по своему токену (с экраном привязки); screen — по публичному токену экрана. */
  mode: 'device' | 'screen';
  token?: string;
  preview?: boolean;
}

const CSS = String.raw`
*{-webkit-box-sizing:border-box;box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;width:100%;overflow:hidden}
body{font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#0B1220;color:#F2F6FC;-webkit-font-smoothing:antialiased;line-height:1.25}
body.th-light{background:#F6F8FA;color:#1A202C}
.fx{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center}
.fxb{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;-webkit-box-pack:justify;-webkit-justify-content:space-between;justify-content:space-between}
.grow{-webkit-box-flex:1;-webkit-flex:1;flex:1;min-width:0}
.tnum{font-variant-numeric:tabular-nums;-webkit-font-feature-settings:"tnum";font-feature-settings:"tnum"}
.muted{color:#8FA1BD}.th-light .muted{color:#6B7280}
.stage{position:absolute;left:0;top:0;right:0;bottom:0;padding:1.8vw 2.2vw 1.4vw}
.slide{position:absolute;left:2.2vw;right:2.2vw;top:1.8vw;bottom:1.4vw}
.slide.in{-webkit-animation:tvin .5s ease;animation:tvin .5s ease}
@-webkit-keyframes tvin{from{opacity:0;-webkit-transform:translateX(2vw)}to{opacity:1;-webkit-transform:none}}
@keyframes tvin{from{opacity:0;transform:translateX(2vw)}to{opacity:1;transform:none}}
.hdr{height:5.6vw;margin-bottom:1vw;padding:0 .2vw}
.dept{font-size:2.4vw;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dept .muted{font-size:1.4vw;font-weight:500;margin-left:.6vw}
.st{text-align:right;margin-left:2.4vw}
.st .l,.blg .l{display:block;font-size:.95vw;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8FA1BD}
.th-light .st .l,.th-light .blg .l{color:#6B7280}
.st .v{display:block;font-size:2.5vw;font-weight:700;line-height:1.1;margin-top:.15vw;letter-spacing:-.01em}
.st .v.fact{color:#5BC878}.th-light .st .v.fact{color:#1E8E3E}
.st .v.book{color:#7FB9E8}.th-light .st .v.book{color:#0069BE}
.blg{width:18vw;margin-left:2.4vw}
.blg .p{font-size:3.1vw;font-weight:800;line-height:1;color:#FBBC04}
.blg .p.ok{color:#5BC878}.th-light .blg .p.ok{color:#1E8E3E}.th-light .blg .p{color:#B26000}
.trk{height:.7vw;border-radius:1vw;background:#243450;overflow:hidden;margin-top:.35vw}
.th-light .trk{background:#E5E9EF}
.trk i{display:block;height:100%;border-radius:1vw;background:rgba(91,200,120,.75)}
.trk.warn i{background:rgba(251,188,4,.7)}
.th-light .trk i{background:#34A853}.th-light .trk.warn i{background:#FBBC04}
.grid{position:absolute;left:0;right:0;top:6.8vw;bottom:2.6vw}
.grid.tk{bottom:5.4vw}
.tile{position:absolute;background:#121C2E;border:1px solid #243450;border-radius:.9em;padding:.9em 1.1em;overflow:hidden}
.th-light .tile{background:#fff;border-color:#E5E9EF}
.tile.top{background:#1A2740;border-color:#33507E}
.th-light .tile.top{background:#EDF5FC;border-color:#AFD3F1}
.tile .inner{position:absolute;left:1.1em;right:1.1em;top:50%;margin-top:-5.3em}
.ava{width:2.3em;height:2.3em;border-radius:50%;margin-right:.7em;-webkit-flex:none;flex:none;text-align:center;line-height:2.3em;font-weight:700;color:#fff;overflow:hidden;background:#1B7FD4}
.ava span{font-size:.85em}
.ava img{width:100%;height:100%;display:block;-o-object-fit:cover;object-fit:cover}
.name{font-size:1.1em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank{font-size:.9em;font-weight:600;color:#8FA1BD;min-width:1.4em;text-align:right;margin-left:.4em}
.th-light .rank{color:#6B7280}
.tile.top .rank{color:#FBBC04}.th-light .tile.top .rank{color:#B26000}
.hero{margin-top:.55em;-webkit-box-align:baseline;-webkit-align-items:baseline;align-items:baseline}
.hero .v{font-size:1.9em;font-weight:600;color:#5BC878;line-height:1.05;white-space:nowrap}
.th-light .hero .v{color:#1E8E3E}
.hero .v small{font-size:.45em;font-weight:500;color:#8FA1BD;margin-left:.35em}
.th-light .hero .v small{color:#6B7280}
.hero .p{font-size:1.25em;font-weight:600;white-space:nowrap}
.hero .p.warn{color:#FBBC04}.th-light .hero .p.warn{color:#B26000}
.bar{margin-top:.55em;height:.42em;border-radius:1em;background:#243450;overflow:hidden}
.th-light .bar{background:#E5E9EF}
.bar i{display:block;height:100%;border-radius:1em;background:rgba(91,200,120,.75)}
.bar.warn i{background:rgba(251,188,4,.7)}
.th-light .bar i{background:#34A853}.th-light .bar.warn i{background:#FBBC04}
.sub{margin-top:.55em;font-size:.9em;color:#8FA1BD;white-space:nowrap;overflow:hidden}
.th-light .sub{color:#6B7280}
.sub b{font-weight:600;color:#F2F6FC;margin-left:.3em}.th-light .sub b{color:#1A202C}
.sub b.book{color:#7FB9E8}.th-light .sub b.book{color:#0069BE}
.sub small{font-size:.75em;margin-left:.25em}
.pb{margin-top:.6em;padding-top:.5em;border-top:1px solid #243450;-webkit-box-align:baseline;-webkit-align-items:baseline;align-items:baseline}
.th-light .pb{border-top-color:#E5E9EF}
.pb .l{font-size:.8em;font-weight:700;letter-spacing:.08em;color:#8FA1BD}.th-light .pb .l{color:#6B7280}
.pb .n{font-size:1.6em;font-weight:800;line-height:1;color:#FBBC04}.th-light .pb .n{color:#B26000}
.pb .n.ok{color:#5BC878}.th-light .pb .n.ok{color:#1E8E3E}
.pb .n small{font-size:.55em;font-weight:600;color:#8FA1BD;margin-left:.15em}
.ftr{position:absolute;left:0;right:0;bottom:0;height:1.8vw;font-size:1vw;color:#8FA1BD}
.th-light .ftr{color:#6B7280}
.ftr b{color:#F2F6FC;font-size:1.15vw;font-weight:700;margin-left:.45vw}.th-light .ftr b{color:#1A202C}
.dots span{display:inline-block;width:.6vw;height:.6vw;border-radius:1vw;background:#243450;margin-left:.6vw;vertical-align:middle;-webkit-transition:all .3s;transition:all .3s}
.th-light .dots span{background:#E5E9EF}
.dots span.on{background:#4A9CDE;width:2vw}.th-light .dots span.on{background:#1B7FD4}
.ticker{position:absolute;left:0;right:0;bottom:2.4vw;height:2.6vw;border-radius:.6vw;background:#121C2E;border:1px solid #243450;overflow:hidden;white-space:nowrap}
.th-light .ticker{background:#fff;border-color:#E5E9EF}
.ticker span{position:absolute;left:100%;top:0;line-height:2.5vw;font-size:1.35vw;font-weight:600;padding:0 1vw;will-change:transform}
.ticker span b{color:#4A9CDE;font-weight:700}.th-light .ticker span b{color:#1B7FD4}
.empty{position:absolute;left:0;right:0;top:40%;text-align:center;font-size:1.6vw;color:#8FA1BD}
.off{position:absolute;left:1vw;bottom:.6vw;font-size:.85vw;color:#FBBC04;background:rgba(0,0,0,.35);padding:.2vw .6vw;border-radius:.4vw;display:none}
.off.on{display:block}
.banner{position:absolute;left:2.2vw;right:2.2vw;top:1.2vw;background:#1B7FD4;color:#fff;border-radius:.8vw;padding:1vw 1.6vw;font-size:1.7vw;font-weight:600;text-align:center;-webkit-box-shadow:0 1vw 3vw rgba(0,0,0,.4);box-shadow:0 1vw 3vw rgba(0,0,0,.4);z-index:20;white-space:normal;word-wrap:break-word}
.full{position:absolute;left:0;top:0;right:0;bottom:0;background:#0B1220;z-index:30;text-align:center;padding:6vw;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;-webkit-box-pack:center;-webkit-justify-content:center;justify-content:center}
.th-light .full{background:#F6F8FA}
.full.img{background-position:center;background-size:cover;background-repeat:no-repeat;color:#fff}
.full.img .t{text-shadow:0 .2vw 1.2vw rgba(0,0,0,.85),0 0 .3vw rgba(0,0,0,.9);background:rgba(0,0,0,.35);padding:1.5vw 3vw;border-radius:1vw;display:inline-block}
.full .t{font-size:4vw;font-weight:700;line-height:1.2;white-space:normal;word-wrap:break-word;max-width:100%}
.full .s{font-size:1.2vw;color:#8FA1BD;margin-top:2vw;text-transform:uppercase;letter-spacing:.1em}
.pair{position:absolute;left:0;top:0;right:0;bottom:0;text-align:center;padding-top:14vh}
.pair .logo{font-size:2vw;font-weight:700;letter-spacing:.02em;color:#4A9CDE}.th-light .pair .logo{color:#005CA9}
.pair .h{font-size:1.6vw;color:#8FA1BD;margin-top:4vh}
.pair .code{font-size:14vw;font-weight:700;letter-spacing:.18em;line-height:1;margin-top:2vh;font-family:Menlo,Consolas,"Courier New",monospace}
.pair .hint{font-size:1.3vw;color:#8FA1BD;margin-top:4vh;line-height:1.6}
.pair .hint b{color:#F2F6FC;font-weight:600}.th-light .pair .hint b{color:#1A202C}
.pair .url{font-size:1.1vw;color:#8FA1BD;margin-top:3vh;opacity:.7}
.cele{position:absolute;left:0;top:0;right:0;bottom:0;z-index:40;background:rgba(11,18,32,.82);text-align:center;overflow:hidden}
.th-light .cele{background:rgba(246,248,250,.9)}
.cele.flash{-webkit-animation:flash .6s ease 4;animation:flash .6s ease 4}
@-webkit-keyframes flash{0%,100%{background:rgba(11,18,32,.82)}50%{background:rgba(27,127,212,.7)}}
@keyframes flash{0%,100%{background:rgba(11,18,32,.82)}50%{background:rgba(27,127,212,.7)}}
.cele .box{position:absolute;left:10vw;right:10vw;top:50%;margin-top:-16vw;-webkit-animation:pop .6s cubic-bezier(.2,1.4,.4,1);animation:pop .6s cubic-bezier(.2,1.4,.4,1)}
@-webkit-keyframes pop{from{opacity:0;-webkit-transform:scale(.6)}to{opacity:1;-webkit-transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
.cele .k{font-size:3.2vw;font-weight:800;letter-spacing:.2em;color:#FBBC04;text-transform:uppercase}
.cele .who{font-size:4.4vw;font-weight:700;margin-top:1.5vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cele .amt{font-size:9vw;font-weight:800;color:#5BC878;line-height:1;margin-top:1vw;letter-spacing:-.02em}
.th-light .cele .amt{color:#1E8E3E}
.cele .d{font-size:1.6vw;color:#8FA1BD;margin-top:2vw;text-transform:uppercase;letter-spacing:.1em}
.cele .ava{width:8vw;height:8vw;line-height:8vw;margin:0 auto;font-size:3vw}
.cf{position:absolute;top:-3vw;width:1vw;height:1.6vw;border-radius:.15vw;opacity:.9}
.toast{position:absolute;right:2.2vw;top:1.2vw;background:#121C2E;border:1px solid #33507E;color:#F2F6FC;border-radius:.8vw;padding:.8vw 1.4vw;font-size:1.3vw;z-index:40;-webkit-animation:pop .4s ease;animation:pop .4s ease}
.th-light .toast{background:#fff;border-color:#AFD3F1;color:#1A202C}
.toast b{color:#5BC878}.th-light .toast b{color:#1E8E3E}
`;

// ES5! Никаких стрелок, const/let, шаблонных строк, for-of, fetch, Promise.
const JS = String.raw`
(function(){
var CFG=window.TV_CFG||{};
var root=document.getElementById('root');
var body=document.body;
var POLL=(CFG.poll||15)*1000;
var startV=null,pageStart=Date.now();
var data=null,idx=0,timerRot=null,timerPoll=null,timerClock=null;
var seeded=false,seenSales={},pctBySlide={},evQueue=[],evBusy=false,offline=false,lastOk=null;
var deviceToken=null;

function $(s,el){return (el||document).querySelector(s);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function pad(n){return (n<10?'0':'')+n;}
function grp(n){var s=String(Math.round(n)),o='';while(s.length>3){o='\u2009'+s.slice(-3)+o;s=s.slice(0,-3);}return s+o;}
function fmtMoney(v){
  v=Number(v)||0;
  if(v>=1e6){var m=Math.round(v/1e5)/10;var s=String(m).replace('.',',');return s+' млн \u20BD';}
  if(v>=1e4){return grp(Math.round(v/1e3))+' тыс \u20BD';}
  return grp(v)+' \u20BD';
}
function initials(n){var p=String(n||'').split(/\s+/),o='';for(var i=0;i<p.length&&o.length<2;i++){if(p[i])o+=p[i].charAt(0).toUpperCase();}return o||'?';}
var AVA=['#1B7FD4','#7DA7D9','#46BDC6','#4285F4','#5B84B5'];
function hue(n){var h=0;for(var i=0;i<n.length;i++)h+=n.charCodeAt(i);return AVA[h%AVA.length];}
var WD=['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
var MN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function mskNow(){var d=new Date();return new Date(d.getTime()+(d.getTimezoneOffset()+180)*60000);}
function dateStr(){var d=mskNow();return WD[d.getDay()]+', '+d.getDate()+' '+MN[d.getMonth()];}
function timeStr(){var d=mskNow();return pad(d.getHours())+':'+pad(d.getMinutes());}

function xhr(method,url,bodyObj,cb){
  var x=new XMLHttpRequest();
  x.open(method,url,true);
  x.setRequestHeader('Accept','application/json');
  if(bodyObj)x.setRequestHeader('Content-Type','application/json');
  x.timeout=12000;
  x.onreadystatechange=function(){
    if(x.readyState!==4)return;
    var j=null;try{j=JSON.parse(x.responseText);}catch(e){}
    cb(x.status,j);
  };
  x.ontimeout=function(){cb(0,null);};
  x.onerror=function(){cb(0,null);};
  x.send(bodyObj?JSON.stringify(bodyObj):null);
}
function store(k,v){try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch(e){}
  try{document.cookie=k+'='+(v==null?'':encodeURIComponent(v))+';path=/tv;max-age='+(v==null?0:31536000)+';SameSite=Lax';}catch(e){}}
function load(k){try{var v=localStorage.getItem(k);if(v)return v;}catch(e){}
  try{var m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));if(m)return decodeURIComponent(m[1]);}catch(e){}return null;}

/* ---------- экран привязки ---------- */
function renderPairing(code,expires){
  body.className='th-dark';
  root.innerHTML='<div class="pair"><div class="logo">МОНОЛИТИКА</div>'+
    '<div class="h">Код для привязки этого телевизора</div>'+
    '<div class="code">'+esc(code)+'</div>'+
    '<div class="hint">Откройте в Монолитике раздел <b>«Ещё → Телевизоры»</b>,<br>нажмите <b>«Привязать телевизор»</b> у нужного экрана и введите этот код.</div>'+
    '<div class="url">'+esc(location.host+'/tv')+'</div></div>';
}
function renderMessage(t,s){
  root.innerHTML='<div class="full"><div><div class="t">'+esc(t)+'</div>'+(s?'<div class="s">'+esc(s)+'</div>':'')+'</div></div>';
}

/* ---------- дашборд ---------- */
function bar(p,cls){
  var w=p==null?0:Math.min(p,100),warn=p!=null&&p<100;
  return '<div class="'+cls+(warn?' warn':'')+'"><i style="width:'+w+'%"></i></div>';
}
function tileHtml(m,i,showAva){
  var mp=m.plan||0,pct=mp?Math.round(m.salesSum/mp*100):null;
  var target=(data&&data.screen.settings&&data.screen.settings.dailyTarget)||5,pb=(m.salesCount||0)+(m.bookCount||0);
  var ava=showAva?(m.avatar?'<div class="ava"><img src="'+esc(m.avatar)+'" alt=""></div>':'<div class="ava" style="background:'+hue(m.name)+'"><span>'+esc(initials(m.name))+'</span></div>'):'';
  return '<div class="tile'+(i===0&&m.salesSum>0?' top':'')+'" data-i="'+i+'"><div class="inner">'+
    '<div class="fx">'+ava+'<div class="name grow">'+esc(m.name)+'</div><div class="rank tnum">'+(i+1)+'</div></div>'+
    '<div class="fxb hero tnum"><div class="v">'+fmtMoney(m.salesSum)+'<small>'+m.salesCount+' шт</small></div><div class="p'+(pct!=null&&pct<100?' warn':'')+'">'+(pct==null?'\u2014':pct+'%')+'</div></div>'+
    bar(pct,'bar')+
    '<div class="fxb sub tnum"><span>План<b>'+fmtMoney(mp)+'</b></span><span>Брони<b class="book">'+fmtMoney(m.bookSum)+'</b><small>'+m.bookCount+' шт</small></span></div>'+
    '<div class="fxb pb tnum"><span class="l">ПРОДАЖЕБРОНЕЙ</span><span class="n'+(pb>=target?' ok':'')+'">'+pb+'<small>/ '+target+'</small></span></div>'+
    '</div></div>';
}
/* Правка владельца 07.09: бегущая строка из рассылки ПЕРЕКРЫВАЕТ строку экрана/отдела
   («она важней»); строка экрана возвращается, когда рассылка закончилась. */
function tickerText(slide){
  if(!data)return '';
  var parts=[];
  for(var i=0;i<data.messages.length;i++){var m=data.messages[i];if(m.kind==='ticker'&&new Date(m.until).getTime()>Date.now())parts.push(m.text);}
  if(parts.length)return parts.join('   \u2022   ');
  return (slide&&slide.ticker)||'';
}
/* Большой отдел (60 менеджеров) на одном экране нечитаем — режем на страницы по
   PER_PAGE плиток; страницы крутятся как слайды, шапка — итоги всего отдела. */
/* Правка владельца 07.09: первая страница отдела — топ-6 по продажам (висит rotateSec),
   остальные — «хвост» страницами по PER_PAGE (висят rotateTailSec). */
var TOP_N=6,PER_PAGE=20;
function pages(){
  var out=[];if(!data)return out;
  for(var i=0;i<data.slides.length;i++){var s=data.slides[i],ms=s.managers;
    if(ms.length<=TOP_N){out.push({s:s,page:0,pages:1,managers:ms,offset:0});continue;}
    var rest=ms.length-TOP_N,tail=Math.ceil(rest/PER_PAGE),n=1+tail;
    out.push({s:s,page:0,pages:n,managers:ms.slice(0,TOP_N),offset:0});
    for(var p=0;p<tail;p++){var from=TOP_N+p*PER_PAGE;out.push({s:s,page:p+1,pages:n,managers:ms.slice(from,from+PER_PAGE),offset:from});}}
  return out;
}
function render(animate){
  if(!data)return;
  var pg=pages(),n=pg.length;
  if(n===0){root.innerHTML='<div class="stage"><div class="empty">Для этого экрана не выбраны отделы</div></div>';return;}
  if(idx>=n)idx=0;
  var cur=pg[idx],s=cur.s,plan=s.planDay||0,fact=s.factDay||0,pct=plan?Math.round(fact/plan*100):null;
  var showAva=!(data.screen.settings&&data.screen.settings.showAvatars===false);
  var tk=tickerText(s);
  var h='<div class="stage"><div class="slide'+(animate?' in':'')+'">'+
    '<div class="fxb hdr"><div class="dept grow">'+esc(s.dept)+(cur.pages>1?' <span class="muted">'+(cur.page+1)+'/'+cur.pages+'</span>':'')+'</div><div class="fx tnum">'+
    '<div class="st"><span class="l">План</span><span class="v">'+fmtMoney(plan)+'</span></div>'+
    '<div class="st"><span class="l">Факт</span><span class="v fact">'+fmtMoney(fact)+'</span></div>'+
    '<div class="blg"><div class="fxb"><span class="l">Выполнение</span><span class="p'+(pct!=null&&pct>=100?' ok':'')+'">'+(pct==null?'\u2014':pct+'%')+'</span></div>'+bar(pct,'trk')+'</div>'+
    '<div class="st"><span class="l">Брони</span><span class="v book">'+fmtMoney(s.bookSum)+'</span></div>'+
    '</div></div>'+
    '<div class="grid'+(tk?' tk':'')+'" id="grid">';
  for(var i=0;i<cur.managers.length;i++)h+=tileHtml(cur.managers[i],cur.offset+i,showAva);
  if(s.managers.length===0)h+='<div class="empty">В отделе нет активных менеджеров</div>';
  h+='</div>';
  if(tk)h+='<div class="ticker" id="ticker"><span id="tks">'+esc(tk)+'</span></div>';
  h+='<div class="fxb ftr"><div class="tnum">'+dateStr()+'<b id="clock">'+timeStr()+'</b></div><div class="dots">';
  for(var j=0;j<n;j++)h+='<span'+(j===idx?' class="on"':'')+'></span>';
  h+='</div></div>';
  h+='<div class="off'+(offline?' on':'')+'" id="off">нет связи'+(lastOk?' \u00b7 данные на '+lastOk:'')+'</div>';
  h+='</div></div>';
  root.innerHTML=h;
  renderOverlays();
  fit();
  startTicker();
}
/* Раскладка плиток: столбцы 1..6, размер шрифта плитки — максимум, при котором
   контент (~9.3em высоты, ~15em ширины) влезает. Всё внутри плитки — в em. */
/* Ширина по самой широкой строке — hero: «12,5 млн ₽» (1.9em) + «12 шт» + «451%» (1.25em) ≈ 19em. */
var CONTENT_H=11.9,CONTENT_W=19;
function fit(){
  var grid=$('#grid');if(!grid)return;
  var tiles=grid.getElementsByClassName('tile'),n=tiles.length;if(!n)return;
  var gw=grid.clientWidth,gh=grid.clientHeight,gap=Math.round(window.innerWidth*0.007);
  var best={k:0,cols:1,rows:n};
  for(var cols=1;cols<=Math.min(n,6);cols++){
    var rows=Math.ceil(n/cols),tw=(gw-gap*(cols-1))/cols,th=(gh-gap*(rows-1))/rows;
    var k=Math.min(th/CONTENT_H,tw/CONTENT_W);
    if(k>best.k)best={k:k,cols:cols,rows:rows};
  }
  var fs=Math.max(9,Math.min(best.k,window.innerWidth*0.022));
  var tw2=(gw-gap*(best.cols-1))/best.cols,th2=(gh-gap*(best.rows-1))/best.rows;
  for(var i=0;i<n;i++){
    var r=Math.floor(i/best.cols),c=i%best.cols,t=tiles[i];
    t.style.fontSize=fs.toFixed(2)+'px';
    t.style.left=Math.round(c*(tw2+gap))+'px';t.style.top=Math.round(r*(th2+gap))+'px';
    t.style.width=Math.floor(tw2)+'px';t.style.height=Math.floor(th2)+'px';
  }
}
/* Бегущая строка — rAF-анимация transform (CSS-переменных и динамических keyframes нет). */
var tkRaf=null;
function startTicker(){
  if(tkRaf){cancelAnimationFrame(tkRaf);tkRaf=null;}
  var box=$('#ticker'),sp=$('#tks');if(!box||!sp)return;
  var speed=(data&&data.screen.settings&&data.screen.settings.tickerSpeed)||'normal';
  var pxs=window.innerWidth*(speed==='slow'?0.06:speed==='fast'?0.16:0.1);
  var w=sp.offsetWidth,bw=box.clientWidth,x=0,last=null;
  function step(ts){
    if(last==null)last=ts;var dt=(ts-last)/1000;last=ts;x+=pxs*dt;if(x>w+bw)x=0;
    var tr='translateX('+(-x)+'px)';sp.style.webkitTransform=tr;sp.style.transform=tr;
    tkRaf=requestAnimationFrame(step);
  }
  tkRaf=requestAnimationFrame(step);
}
/* Баннер / полноэкранное сообщение из рассылок */
function renderOverlays(){
  var stage=$('.stage');if(!stage||!data)return;
  var old=stage.querySelectorAll('.banner,.full');for(var i=0;i<old.length;i++)old[i].parentNode.removeChild(old[i]);
  var now=Date.now(),banner=null,full=null;
  for(var j=0;j<data.messages.length;j++){var m=data.messages[j];if(new Date(m.until).getTime()<=now)continue;
    if(m.kind==='banner'&&!banner)banner=m;if(m.kind==='fullscreen'&&!full)full=m;}
  if(banner){var b=document.createElement('div');b.className='banner';b.innerHTML=esc(banner.text);stage.appendChild(b);}
  if(full){var f=document.createElement('div');f.className='full'+(full.image?' img':'');
    if(full.image)f.style.backgroundImage='url("'+full.image.replace(/"/g,'')+'")';
    f.innerHTML=full.text?'<div class="t">'+esc(full.text)+'</div>':'';stage.appendChild(f);}
}
function tick(){
  var c=$('#clock');if(c)c.innerHTML=timeStr();
  /* сообщения с истёкшим until снимаем сами, не дожидаясь фида */
  if(data){var ch=false;for(var i=0;i<data.messages.length;i++){if(new Date(data.messages[i].until).getTime()<=Date.now()){ch=true;}}
    if(ch){data.messages=data.messages.filter(function(m){return new Date(m.until).getTime()>Date.now();});render(false);}}
}
function next(d){var n=pages().length;if(n<2)return;idx=(idx+d+n)%n;render(true);restartRotate();}
function restartRotate(){
  if(timerRot)clearTimeout(timerRot);timerRot=null;
  var pg=pages();if(pg.length<2)return;
  var cur=pg[idx]||pg[0],st=data.screen.settings||{};
  var sec=cur.page===0?(data.screen.rotateSec||15):(st.rotateTailSec||10);
  timerRot=setTimeout(function(){next(1);},sec*1000);
}

/* ---------- события («мувики») ---------- */
function evSettings(){var s=data&&data.screen.settings&&data.screen.settings.events;return s||{enabled:false};}
function detectEvents(prev,cur){
  var ev=evSettings();
  var i,m;
  if(!seeded){for(i=0;i<cur.sales.length;i++)seenSales[cur.sales[i].id]=1;
    for(i=0;i<cur.slides.length;i++){var s0=cur.slides[i];pctBySlide[s0.key]=s0.planDay?s0.factDay/s0.planDay:0;}
    seeded=true;return;}
  var fresh=[];
  for(i=0;i<cur.sales.length;i++){var sl=cur.sales[i];if(!seenSales[sl.id]){seenSales[sl.id]=1;fresh.push(sl);}}
  if(ev.enabled&&ev.sale){
    fresh.sort(function(a,b){return new Date(a.at)-new Date(b.at);});
    for(i=0;i<fresh.length;i++){m=fresh[i];if(m.amount>=(ev.minAmount||0)){
      var dept='';for(var k=0;k<cur.slides.length;k++){for(var q=0;q<cur.slides[k].managers.length;q++){if(cur.slides[k].managers[q].id===m.managerId){dept=cur.slides[k].dept;m.avatar=cur.slides[k].managers[q].avatar;}}}
      evQueue.push({type:'sale',name:m.managerName,amount:m.amount,dept:dept,avatar:m.avatar});}}
  }
  for(i=0;i<cur.slides.length;i++){var s=cur.slides[i],p=s.planDay?s.factDay/s.planDay:0,was=pctBySlide[s.key];
    if(ev.enabled&&ev.planDone&&was!=null&&was<1&&p>=1)evQueue.push({type:'plan',dept:s.dept,amount:s.factDay});
    pctBySlide[s.key]=p;}
  runEvents();
}
function runEvents(){
  if(evBusy||!evQueue.length)return;
  var e=evQueue.shift(),ev=evSettings(),dur=(ev.durationSec||12)*1000,style=ev.style||'confetti';
  evBusy=true;
  var stage=$('.stage');if(!stage){evBusy=false;return;}
  var el=document.createElement('div');
  if(style==='minimal'){
    el.className='toast';
    el.innerHTML=e.type==='sale'?('Продажа: '+esc(e.name)+' \u2014 <b>'+fmtMoney(e.amount)+'</b>'):('План дня выполнен: <b>'+esc(e.dept)+'</b>');
  }else{
    el.className='cele'+(style==='flash'?' flash':'');
    var ava=e.avatar?'<div class="ava"><img src="'+esc(e.avatar)+'" alt=""></div>':(e.name?'<div class="ava" style="background:'+hue(e.name)+'">'+esc(initials(e.name))+'</div>':'');
    el.innerHTML='<div class="box">'+(e.type==='sale'?
      ('<div class="k">Продажа!</div>'+ava+'<div class="who">'+esc(e.name)+'</div><div class="amt tnum">'+fmtMoney(e.amount)+'</div><div class="d">'+esc(e.dept)+'</div>'):
      ('<div class="k">План дня выполнен!</div><div class="who">'+esc(e.dept)+'</div><div class="amt tnum">'+fmtMoney(e.amount)+'</div><div class="d">Так держать</div>'))+'</div>';
    if(style==='confetti')confetti(el,dur);
  }
  stage.appendChild(el);
  if(ev.sound&&!CFG.preview)fanfare(e.type);
  setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);evBusy=false;runEvents();},dur);
}
var CF=['#4285F4','#EA4335','#FBBC04','#34A853','#FF6D01','#46BDC6','#7FB9E8'];
function confetti(host,dur){
  var W=window.innerWidth,H=window.innerHeight,N=Math.min(90,Math.round(W/16)),ps=[],i;
  for(i=0;i<N;i++){var d=document.createElement('i');d.className='cf';d.style.background=CF[i%CF.length];d.style.left=Math.random()*W+'px';host.appendChild(d);
    ps.push({el:d,x:Math.random()*W,y:-Math.random()*H*0.6,vy:H*(0.25+Math.random()*0.35),vx:(Math.random()-0.5)*W*0.08,r:Math.random()*360,vr:(Math.random()-0.5)*400});}
  var start=null,alive=true;
  function step(ts){if(!alive||!host.parentNode)return;if(start==null)start=ts;var t=(ts-start)/1000;
    for(var k=0;k<ps.length;k++){var p=ps[k],y=p.y+p.vy*t,x=p.x+p.vx*t+Math.sin(t*3+k)*W*0.01,r=p.r+p.vr*t;
      if(y>H+40){p.y=-40-Math.random()*H*0.2;p.x=Math.random()*W;start=ts;y=p.y;x=p.x;}
      var tr='translate('+x.toFixed(0)+'px,'+y.toFixed(0)+'px) rotate('+r.toFixed(0)+'deg)';p.el.style.webkitTransform=tr;p.el.style.transform=tr;}
    requestAnimationFrame(step);}
  requestAnimationFrame(step);
  setTimeout(function(){alive=false;},dur);
}
var actx=null;
function fanfare(type){
  try{
    var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
    if(!actx)actx=new AC();if(actx.state==='suspended'&&actx.resume)actx.resume();
    var notes=type==='plan'?[523,659,784,1047,784,1047]:[659,784,1047,1319];
    var t=actx.currentTime;
    for(var i=0;i<notes.length;i++){var o=actx.createOscillator(),g=actx.createGain();o.type='triangle';o.frequency.value=notes[i];
      g.gain.setValueAtTime(0.0001,t+i*0.16);g.gain.exponentialRampToValueAtTime(0.25,t+i*0.16+0.02);g.gain.exponentialRampToValueAtTime(0.0001,t+i*0.16+0.3);
      o.connect(g);g.connect(actx.destination);o.start(t+i*0.16);o.stop(t+i*0.16+0.32);}
  }catch(e){}
}

/* ---------- опрос ---------- */
function feedUrl(fresh){
  var u=CFG.api||'/api/tv/feed';
  if(CFG.mode==='screen')u=u+'?s='+encodeURIComponent(CFG.token||'');
  else u=u+'?d='+encodeURIComponent(deviceToken||'');
  if(fresh)u=u+'&fresh=1';
  return u;
}
function schedule(ms){if(timerPoll)clearTimeout(timerPoll);timerPoll=setTimeout(function(){poll(false);},ms);}
function registerDevice(){
  xhr('POST','/api/tv/device',{ua:navigator.userAgent},function(st,j){
    if(st===200&&j&&j.token){deviceToken=j.token;store('tv_device',j.token);renderPairing(j.code);schedule(5000);}
    else{renderMessage('Не удалось подключиться','Проверьте интернет на телевизоре — повторим через минуту');schedule(60000);}
  });
}
/* Задача #5636: событие sa_deals_changed из /api/tv/stream — не ждём таймер,
   опрашиваем фид сразу с fresh=1 (мимо Redis-кэша 20 с). Троттлинг 1.5 с —
   несколько NOTIFY подряд (одна транзакция n8n меняет несколько полей) не
   должны превращаться в дождь запросов; таймер обычного опроса перезаводится
   этим же вызовом poll(), так что дублей не будет. */
var lastPushPoll=0;
function pollNow(){
  var now=Date.now();
  if(now-lastPushPoll<1500)return;
  lastPushPoll=now;
  if(timerPoll)clearTimeout(timerPoll);
  poll(true);
}
function poll(fresh){
  if(CFG.mode==='device'&&!deviceToken){registerDevice();return;}
  xhr('GET',feedUrl(fresh),null,function(st,j){
    if(st===429){schedule(60000);return;}
    if(st===0||!j){offline=true;var o=$('#off');if(o){o.className='off on';o.innerHTML='нет связи'+(lastOk?' \u00b7 данные на '+lastOk:'');}
      if(!data&&!$('.pair'))renderMessage('Нет связи с Монолитикой','Повторим через 30 секунд'+(lastOk?'. Данные на '+lastOk:''));schedule(30000);return;}
    if(j.v){if(startV==null)startV=j.v;else if(j.v!==startV){location.reload();return;}}
    if(j.state==='pairing'){data=null;renderPairing(j.code);schedule(5000);return;}
    if(j.state==='unknown_device'){deviceToken=null;store('tv_device',null);registerDevice();return;}
    if(j.state==='unknown_screen'){data=null;renderMessage('Экран удалён','Привяжите телевизор заново в разделе «Телевизоры»');schedule(60000);return;}
    if(j.state!=='ok'){renderMessage('Ошибка',j.message||'Попробуем ещё раз');schedule(30000);return;}
    offline=false;lastOk=timeStr();
    var prev=data,firstRender=!data;
    data=j;
    body.className='th-'+(j.screen.theme||'dark');
    if(prev&&prev.day!==j.day){seeded=false;seenSales={};pctBySlide={};idx=0;}
    render(firstRender);
    if(firstRender)restartRotate();
    detectEvents(prev,j);
    /* ночная перезагрузка — раз в сутки в 03–05 МСК, если страница живёт дольше 20 ч */
    var h=mskNow().getHours();if(Date.now()-pageStart>20*3600*1000&&h>=3&&h<5){location.reload();return;}
    schedule(POLL);
  });
}

/* Задача #5636: SSE как быстрый путь поверх опроса (fallback-поллинг POLL/5000мс
   остаётся штатным путём и единственным источником правды при недоступности
   EventSource — Tizen 2016/webOS 3.x иногда его не имеют). Браузер сам
   переподключается при обрыве (retry по умолчанию ~3 с), поэтому явного
   реконнекта в клиенте не нужно — только троттлинг через pollNow(). */
function startStream(){
  if(!window.EventSource)return;
  try{
    var es=new EventSource('/api/tv/stream');
    es.addEventListener('hello',function(){pollNow();});
    es.addEventListener('deal',function(){pollNow();});
    es.addEventListener('resync',function(){pollNow();});
    es.onerror=function(){/* EventSource переподключится сам; фолбэк-опрос жив всегда */};
  }catch(e){/* старый ТВ без EventSource — фолбэк-опрос справится один */}
}

window.addEventListener('resize',function(){fit();startTicker();});
document.addEventListener('keydown',function(e){var k=e.keyCode||e.which;if(k===39)next(1);if(k===37)next(-1);});
timerClock=setInterval(tick,1000);
if(CFG.mode==='device'){deviceToken=load('tv_device');}
renderMessage('Монолитика','Подключаемся…');
poll(false);
startStream();
})();
`;

function escJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/-->/g, '--\\>');
}

export function renderTvPage(cfg: TvPageConfig): string {
  const clientCfg = { mode: cfg.mode, token: cfg.token ?? null, preview: !!cfg.preview, poll: TV_POLL_SEC, api: '/api/tv/feed' };
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<title>Монолитика — ТВ</title>
<style>${CSS}</style>
</head>
<body class="th-dark">
<div id="root"></div>
<script>window.TV_CFG=${escJson(clientCfg)};</script>
<script>${JS}</script>
</body>
</html>`;
}
