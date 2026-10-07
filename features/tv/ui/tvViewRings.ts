// Скрипт вида «Кольца» для экрана телевизора (стили — tvSkinRings.ts, там же описан
// макет). Вставляется в страницу движка в <head>, перед его собственным скриптом.
//
// ЧТО ОН ДЕЛАЕТ. Движок (features/tv/engine/page.ts) по-прежнему сам опрашивает фид,
// листает страницы, показывает события и рисует свою разметку. Этот скрипт только
// ПЕРЕРИСОВЫВАЕТ: следит за разметкой движка (MutationObserver) и рядом с ней кладёт
// то же самое в раскладке макета —
//   • шапку: название отдела, дата, «Обновлено ЧЧ:ММ»;
//   • панель отдела: «План / Факт», кольцо, три показателя;
//   • плитку: место (корона у 1–3), кольцо, «План» слева и «Факт» справа, три показателя;
//   • рейтинг 6–10 на месте шестой плитки, когда менеджеров в отделе больше шести.
// Родные блоки движка при этом скрыты стилями (html.tvx …), но остаются в странице:
// движок продолжает их обновлять, а вид читает из них цифры. Сам он ничего не считает
// и не форматирует — берёт готовые строки движка («1,2 млн ₽», «44%», «2 / 30»).
//
// ЧЕГО ОН НЕ МОЖЕТ без правки движка. Листание остаётся прежним: по шесть менеджеров
// на страницу. Поэтому при 7+ менеджерах шестой виден только строкой рейтинга, а
// 7-й и дальше — и в рейтинге, и карточками на следующей странице. Чтобы было «пять
// карточек + рейтинг, дальше со шестого», нужно менять pages() в движке.
//
// ОТКУДА РЕЙТИНГ. На первой странице движок рисует шесть плиток, имён остальных в
// разметке нет. Вид подслушивает ответ фида, который запрашивает сам движок (обёртка
// над XMLHttpRequest.open — только чтение, ответ не меняется, лишних запросов нет),
// и находит в нём список, начало которого совпадает с плитками на экране.
//
// ЗАЩИТА. Если в браузере нет MutationObserver или вид не нашёл в разметке движка то,
// что ожидал (движок поменяли), он снимает класс tvx с <html> и отключается: экран
// остаётся в раскладке движка, перекрашенной запасным слоем стилей.
//
// ES5! Как и в движке: без стрелок, const/let, шаблонных строк, for-of, fetch, Promise.

export const TV_VIEW_RINGS_JS = String.raw`
(function(){
var W=window,D=document,H=D.documentElement;
if(!W.MutationObserver||!D.querySelector||!W.JSON||!W.getComputedStyle)return;
H.className=(H.className?H.className+' ':'')+'tvx';
var feeds=[],upd=null,mo=null,dead=false;
var MN=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
function pad(n){return (n<10?'0':'')+n;}
function msk(){var d=new Date();return new Date(d.getTime()+(d.getTimezoneOffset()+180)*60000);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function q(el,s){return el?el.querySelector(s):null;}
function need(x){if(!x)throw new Error('tv-view: markup');return x;}
function txt(el){return el?(el.textContent||''):'';}
/* собственный текст узла — без вложенных small */
function own(el){var c=el&&el.firstChild;return c&&c.nodeType===3?c.nodeValue:'';}
function cls(el,name,on){var c=el.className||'',has=(' '+c+' ').indexOf(' '+name+' ')>=0;
  if(on&&!has)el.className=c?c+' '+name:name;
  else if(!on&&has)el.className=(' '+c+' ').replace(' '+name+' ',' ').replace(/^\s+|\s+$/g,'');}
/* «219 тыс ₽» → число крупно, единица мельче */
function money(s){var m=/^([\d\u2009\s,]*\d)\s*(.*)$/.exec(s||'');return m?esc(m[1])+(m[2]?'<i class="nx-u">'+esc(m[2])+'</i>':''):esc(s);}
/* «2» + «/ 30» из блока движка */
function frac(el){return esc(own(el))+'<small>'+esc(txt(q(el,'small')))+'</small>';}
function num(el){var t=txt(el);return /^\s*\d/.test(t)?parseInt(t,10):null;}
function initials(n){var p=String(n||'').split(/\s+/),o='';for(var i=0;i<p.length&&o.length<2;i++){if(p[i])o+=p[i].charAt(0).toUpperCase();}return o||'?';}

var SV='<svg class="nx-ic" viewBox="0 0 24 24" ';
var LN='fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ';
var IC={
  cart:SV+LN+'stroke-width="2"><path d="M2.5 4h2.7l2.3 10.6h10.4L20.3 7.4H6.4"/><circle cx="9.3" cy="19" r="1.5"/><circle cx="16.9" cy="19" r="1.5"/></svg>',
  cube:SV+LN+'stroke-width="2"><path d="M12 2.6l8.2 4.6v9.6L12 21.4l-8.2-4.6V7.2z"/><path d="M3.8 7.2l8.2 4.6 8.2-4.6M12 11.8v9.6"/></svg>',
  coin:SV+'><ellipse class="c" cx="12" cy="17.6" rx="7.6" ry="3.4"/><ellipse class="c" cx="12" cy="13.6" rx="7.6" ry="3.4"/><ellipse class="c" cx="12" cy="9.6" rx="7.6" ry="3.4"/><ellipse class="c" cx="12" cy="5.6" rx="7.6" ry="3.4"/></svg>',
  cal:SV+LN+'stroke-width="1.8"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.8h17M8 3v4M16 3v4M8 13.6h.01M12 13.6h.01M16 13.6h.01M8 17h.01M12 17h.01"/></svg>'
};
var CROWN='<svg viewBox="0 0 40 46"><path d="M4 16V5l8.5 6.5L20 2l7.5 9.5L36 5v11z"/><path d="M4 18h32v16.5a4 4 0 0 1-2.4 3.7L20 45 6.4 38.2A4 4 0 0 1 4 34.5z"/></svg>';

/* Кольцо: p — процент плана или null (плана нет). Меньше LOW — янтарное, иначе мятное.
   Дуга начинается сверху и идёт по часовой; под ней второй, широкий и прозрачный
   штрих — свечение без CSS-фильтров. */
var LOW=25;
function ring(p,sw){
  var R=50-sw/2-3,C=2*Math.PI*R,f=p==null?0:Math.max(0,Math.min(p,100))/100;
  var h='<svg class="nx-rg'+(p!=null&&p<LOW?' lo':'')+'" viewBox="0 0 100 100"><circle class="t" cx="50" cy="50" r="'+R+'" fill="none" stroke-width="'+sw+'"/>';
  if(f>0){
    var a=' cx="50" cy="50" r="'+R+'" fill="none" stroke-linecap="round" transform="rotate(-90 50 50)" stroke-dasharray="'+(C*f).toFixed(1)+' '+C.toFixed(1)+'"';
    h+='<circle class="g"'+a+' stroke-width="'+(sw+5)+'"/><circle class="a"'+a+' stroke-width="'+sw+'"/>';
  }
  return h+'</svg>';
}
function pctText(p){return p==null?'\u2014':p+'%';}
/* подпись в центре кольца; «107%» длиннее «44%» — такой процент пишем мельче (класс w4) */
function ringText(p,cap){var t=pctText(p);return '<div class="nx-rt'+(t.length>3?' w4':'')+'"><b>'+t+'</b><span>'+cap+'</span></div>';}
function planFact(plan,fact){
  return '<div class="nx-c nx-pl"><span class="l">План</span><span class="v">'+money(plan)+'</span></div>'+
    '<div class="nx-sl">/</div>'+
    '<div class="nx-c nx-fa"><span class="l">Факт</span><span class="v">'+money(fact)+'</span></div>';
}
/* Если строка не влезла в блок box (например «12,5 млн ₽ / 15,3 млн ₽») — уменьшаем
   шрифт у её содержимого target. Сам блок не трогаем: его отступы заданы в em. */
function fit(box,target){
  if(!box||!target)return;
  target.style.fontSize='';
  for(var n=0;n<10&&box.scrollWidth>box.clientWidth+1;n++){
    target.style.fontSize=(parseFloat(W.getComputedStyle(target).fontSize)*0.93).toFixed(2)+'px';
  }
}
function fitIn(root){
  var a=root.querySelectorAll('.nx-pf,.nx-spf'),b=root.querySelectorAll('.nx-x'),i;
  for(i=0;i<a.length;i++)fit(a[i],q(a[i],'.nx-fi'));
  for(i=0;i<b.length;i++)fit(b[i],q(b[i],'.n'));
}
/* Подпись в центре большого кольца — от его фактического диаметра: панель отдела
   тянется по высоте экрана, и кольцо бывает разным. */
function sizeRing(nx){
  var sr=q(nx,'.nx-sr'),rt=q(sr,'.nx-rt');if(!rt)return;
  var d=Math.min(sr.clientWidth,sr.clientHeight);
  if(d>0)rt.style.fontSize=(d*0.27).toFixed(1)+'px';
}
/* Ширину меряем по тому шрифту, что есть в эту секунду. Свой шрифт экрана догружается
   позже и он шире запасного — поэтому после его загрузки перемеряем всё заново. */
function refit(){
  if(dead)return;
  try{fitIn(D);}catch(e){}
}

/* ---------- плитка менеджера / карточка филиала ---------- */
function tile(t){
  var inner=q(t,'.inner');if(!inner)return;
  var i=parseInt(t.getAttribute('data-i'),10)||0;
  var ns=inner.querySelectorAll('.pb .n'),sN=need(ns[0]),bN=need(ns[1]);
  /* корона — первым трём, у кого сегодня есть хоть одна продажа или бронь */
  var medal=i<3&&((num(sN)||0)>0||(num(bN)||0)>0)?i+1:0;
  cls(t,'nx-g1',medal===1);cls(t,'nx-g2',medal===2);cls(t,'nx-g3',medal===3);
  var sig=i+'|'+inner.innerHTML,nx=t.lastChild;
  if(nx&&nx.className==='nx'&&nx._sig===sig)return;
  var v=need(q(inner,'.hero .v')),p=num(q(inner,'.hero .p')),ava=q(inner,'.ava');
  var act=txt(q(inner,'.pb .l small'));
  var h='<div class="nx-h">'+
      '<div class="nx-k'+(medal?' g'+medal:'')+'">'+(medal?CROWN:'')+'<b>'+(i+1)+'</b></div>'+
      (ava?ava.outerHTML:'')+
      '<div class="nx-nm">'+esc(txt(q(inner,'.name')))+(act?'<small>'+esc(act)+'</small>':'')+'</div>'+
    '</div>'+
    '<div class="nx-m">'+
      '<div class="nx-r">'+ring(p,8)+ringText(p,'плана')+'</div>'+
      '<div class="nx-pf"><div class="nx-fi">'+planFact(txt(q(inner,'.sub b')),own(v))+'</div></div>'+
    '</div>'+
    '<div class="nx-b">'+
      '<div class="nx-x s">'+IC.cart+'<span class="n">'+frac(sN)+'</span></div>'+
      '<div class="nx-x b">'+IC.cube+'<span class="n'+(/\bok\b/.test(bN.className)?' ok':'')+'">'+frac(bN)+'</span></div>'+
      '<div class="nx-x m">'+IC.coin+'<span class="n">'+money(txt(q(inner,'.sub b.book')))+'</span></div>'+
    '</div>';
  if(!nx||nx.className!=='nx'){nx=D.createElement('div');nx.className='nx';t.appendChild(nx);}
  nx.innerHTML=h;nx._sig=sig;
  fitIn(nx);
}

/* ---------- панель отдела ---------- */
function side(sd){
  var col=need(q(sd,'.col')),ss=sd.querySelectorAll('.sst');need(ss.length>=4);
  var sig=col.innerHTML,i;for(i=0;i<ss.length;i++)sig+=ss[i].innerHTML;
  var nx=sd.lastChild;
  if(nx&&nx.className==='nx-side'&&nx._sig===sig)return;
  var s0=ss[0],p=num(q(col,'.pct')),act=txt(q(s0,'.l small'));
  var h='<div class="nx-spf"><div class="nx-fi">'+planFact(txt(q(ss[1],'.v')),txt(q(ss[2],'.v')))+'</div></div>'+
    '<div class="nx-sr">'+ring(p,10)+ringText(p,'плана на день')+'</div>'+
    '<div class="nx-sb">'+
      '<div class="nx-sx s">'+IC.cart+'<div class="tx"><span class="l">Продажи'+(act?'<small>'+esc(act)+'</small>':'')+'</span><span class="n">'+frac(need(q(s0,'.v')))+'</span></div></div>'+
      '<div class="nx-sx b">'+IC.cube+'<div class="tx"><span class="l">Брони</span><span class="n">'+frac(need(q(s0,'.r .v')))+'</span></div></div>'+
      '<div class="nx-sx m">'+IC.coin+'<div class="tx"><span class="l">Сумма броней</span><span class="n">'+money(txt(q(ss[3],'.v')))+'</span></div></div>'+
    '</div>';
  if(!nx||nx.className!=='nx-side'){nx=D.createElement('div');nx.className='nx-side';sd.appendChild(nx);}
  nx.innerHTML=h;nx._sig=sig;
  fitIn(nx);sizeRing(nx);
}

/* ---------- шапка ---------- */
function head(slide){
  var hd=null,c=slide.children,i;
  for(i=0;i<c.length;i++){if(c[i].className==='nx-head')hd=c[i];}
  var sides=D.getElementById('sides'),dp=q(sides&&sides.lastChild,'.dept');
  var title=own(dp),lab=txt(q(dp,'.muted')),d=msk();
  var date=d.getDate()+' '+MN[d.getMonth()]+' '+d.getFullYear();
  var sig=title+'|'+lab+'|'+date+'|'+upd;
  if(hd&&hd._sig===sig)return;
  if(!hd){hd=D.createElement('div');hd.className='nx-head';slide.appendChild(hd);}
  hd.innerHTML='<div class="nx-ti">'+esc(title)+(lab?'<small>'+esc(lab)+'</small>':'')+'</div>'+
    '<div class="nx-dt">'+IC.cal+'<span>'+date+'</span>'+(upd?'<i></i><span>Обновлено '+upd+'</span>':'')+'</div>';
  hd._sig=sig;
}

/* ---------- рейтинг 6–10 ---------- */
/* Список менеджеров из подслушанного фида: тот, чьё начало совпадает с именами плиток. */
function findList(names){
  for(var f=0;f<feeds.length;f++){
    var sl=feeds[f].slides||[];
    for(var i=0;i<sl.length;i++){
      var ls=[sl[i].managers||[]],ps=sl[i].pageSeq||[],k,n;
      for(k=0;k<ps.length;k++){if(ps[k]&&ps[k].managers)ls.push(ps[k].managers);}
      for(k=0;k<ls.length;k++){
        var L=ls[k],ok=L.length>names.length;
        for(n=0;ok&&n<names.length;n++){if(!L[n]||L[n].name!==names[n])ok=false;}
        if(ok)return L;
      }
    }
  }
  return null;
}
function rate(layer){
  var ts=[],old=null,c=layer.children,i;
  for(i=0;i<c.length;i++){
    var cn=' '+(c[i].className||'')+' ';
    if(cn.indexOf(' tile ')>=0)ts.push(c[i]);else if(cn.indexOf(' nx-rate ')>=0)old=c[i];
  }
  var L=null;
  /* только первая страница менеджеров, когда она заполнена целиком */
  if(ts.length===6&&(' '+ts[0].className+' ').indexOf(' card ')<0&&ts[0].getAttribute('data-i')==='0'){
    var names=[];for(i=0;i<6;i++)names.push(txt(q(ts[i],'.inner .name')));
    L=findList(names);
  }
  if(!L){
    if(old)layer.removeChild(old);
    for(i=0;i<ts.length;i++)cls(ts[i],'nx-hide',false);
    return;
  }
  var showAva=!!q(ts[0],'.inner .ava');
  var h='<div class="nx-ri"><div class="nx-rh">Рейтинг по выполнению плана</div>';
  for(i=5;i<L.length&&i<10;i++){
    var m=L[i],p=m.plan?Math.round((m.salesSum||0)/m.plan*100):null;
    h+='<div class="nx-rr"><span class="k">'+(i+1)+'</span>'+
      (showAva?'<span class="a">'+(m.avatar?'<img src="'+esc(m.avatar)+'" alt="">':'<i>'+esc(initials(m.name))+'</i>')+'</span>':'')+
      '<span class="nm">'+esc(m.name)+'</span>'+
      '<span class="br"><i'+(p!=null&&p<LOW?' class="lo"':'')+' style="width:'+(p==null?0:Math.min(p,100))+'%"></i></span>'+
      '<span class="p">'+pctText(p)+'</span></div>';
  }
  h+='</div>';
  var box=ts[5].style.cssText,sig=box+'|'+h;
  cls(ts[5],'nx-hide',true);
  if(old&&old._sig===sig)return;
  if(!old){old=D.createElement('div');old.className='nx-rate';layer.appendChild(old);}
  old.style.cssText=box;old.innerHTML=h;old._sig=sig;
}

/* ---------- запуск ---------- */
function off(){
  dead=true;
  try{if(mo)mo.disconnect();}catch(e){}
  H.className=(' '+H.className+' ').replace(' tvx ',' ').replace(/^\s+|\s+$/g,'');
  /* движок пересчитает сетку под свою раскладку */
  try{var ev=D.createEvent('Event');ev.initEvent('resize',true,true);W.dispatchEvent(ev);}catch(e){}
}
function run(){
  if(dead)return;
  try{
    var slide=q(D,'.slide');if(!slide)return;
    var sides=D.getElementById('sides'),grid=D.getElementById('grid'),c,i,k;
    if(sides){c=sides.children;for(i=0;i<c.length;i++)side(c[i]);}
    if(grid){c=grid.children;for(i=0;i<c.length;i++){
      var ts=c[i].querySelectorAll('.tile');for(k=0;k<ts.length;k++)tile(ts[k]);
      rate(c[i]);}}
    head(slide);
  }catch(e){off();if(W.console&&console.error)console.error('[tv-view] вид отключён:',e&&e.message);}
}
function start(){
  var root=D.getElementById('root');if(!root)return;
  mo=new MutationObserver(function(recs){
    /* часы, счётчик паузы и бегущая строка тикают каждую секунду — на них не реагируем */
    for(var i=0;i<recs.length;i++){
      var t=recs[i].target;if(t&&t.nodeType===3)t=t.parentNode;
      var id=t&&t.id;
      if(id!=='clock'&&id!=='pillTxt'&&id!=='tks'){run();return;}
    }
  });
  mo.observe(root,{childList:true,subtree:true,characterData:true});
  run();
  try{if(D.fonts&&D.fonts.addEventListener)D.fonts.addEventListener('loadingdone',refit);}catch(e){}
  setTimeout(refit,1500);setTimeout(refit,5000);setTimeout(refit,15000);
}
/* Подслушиваем ответ фида, который запрашивает движок. Слушатель вешается в open() —
   раньше, чем движок назначит свой обработчик, поэтому к моменту перерисовки свежие
   данные уже здесь. */
try{
  var XP=W.XMLHttpRequest.prototype,open0=XP.open;
  XP.open=function(method,url){
    try{
      var api=(W.TV_CFG&&W.TV_CFG.api)||'/api/tv/feed',x=this;
      if(typeof url==='string'&&url.indexOf(api)===0&&x.addEventListener){
        x.addEventListener('readystatechange',function(){
          if(x.readyState!==4||x.status!==200)return;
          try{
            var j=JSON.parse(x.responseText);
            if(j&&j.state==='ok'&&j.slides){
              feeds.unshift(j);if(feeds.length>4)feeds.length=4;
              var d=msk();upd=pad(d.getHours())+':'+pad(d.getMinutes());
              setTimeout(run,0);
            }
          }catch(e){}
        });
      }
    }catch(e){}
    return open0.apply(this,arguments);
  };
}catch(e){}
if(D.readyState==='loading')D.addEventListener('DOMContentLoaded',start);else start();
})();
`;
