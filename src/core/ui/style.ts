import { C, FONT, lite } from './u';

/**
 * Стили экранов (docs/design.md). Размеры — в rem: 1rem = 1 em = высота экрана / 48
 * (= 10 dp Android-версии; sp делятся на 10). Цвета — из палитры C (CSS-переменных
 * в Chromium 38 нет). Фокус — белый фон и чёрный текст (класс .f), отмеченное — .m.
 */
export function css(): string {
  const W = C.WHITE;
  return base(W) + (lite() ? LITE : '');
}

/** Облегчённый интерфейс без прозрачности: сплошные фоны вместо градиентов (палитра — applyPalette в u.ts) */
const LITE = `
#menu-shade{background:none}
.fade-top,.fade-bottom{display:none!important}
#info{padding-top:2.4rem}
`;

let styleEl: HTMLStyleElement | null = null;
/** Поставить или обновить стили (после смены настроек «Облегчённый интерфейс») */
export function restyle() {
  if (!styleEl) { styleEl = document.createElement('style'); document.head.appendChild(styleEl); }
  styleEl.textContent = css();
}

function base(W: string): string {
  return `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:#000;color:${W};font-family:${FONT};font-size:inherit;-webkit-user-select:none;user-select:none;cursor:default}
body.nocursor,body.nocursor *{cursor:none!important}
#video{position:absolute;left:0;top:0;width:100%;height:100%;background:#000;object-fit:contain}
#ui{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden}
.abs{position:absolute}
.el{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center}
.grow{-webkit-flex:1;flex:1;min-width:0}
.t95{color:${C.t(0.95)}}.t85{color:${C.t(0.85)}}.t75{color:${C.t(0.75)}}.t65{color:${C.t(0.65)}}.t60{color:${C.t(0.6)}}.t50{color:${C.t(0.5)}}.t40{color:${C.t(0.4)}}
.ic{display:inline-block;width:1.4rem;height:1.4rem;vertical-align:middle;-webkit-flex:none;flex:none}
.ic svg{width:100%;height:100%;display:block}
.f{background:${W}!important;color:#000!important}
.f .t95,.f .t85,.f .t75,.f .t65,.f .t60,.f .t50,.f .t40,.f .v,.f .val,.f .ds,.f .lbl{color:rgba(0,0,0,.62)!important}
.m{background:${C.FILL_MARKED}}

/* загрузка потока */
#buffering{position:absolute;left:50%;top:50%;width:5rem;height:5rem;margin:-2.5rem 0 0 -2.5rem;border-radius:50%;border:0.45rem solid ${C.t(0.18)};border-top-color:${W}}

/* тост */
#toast{position:absolute;left:50%;top:2.4rem;-webkit-transform:translateX(-50%);transform:translateX(-50%);max-width:70%;padding:0.9rem 1.6rem;border-radius:0.6rem;background:${C.PANEL};font-size:1.35rem;text-align:center;z-index:50}

/* логотип */
.logo{position:relative;background:${C.FILL_SOFT};border-radius:0.4rem;overflow:hidden;-webkit-flex:none;flex:none;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center}
.logo img{max-width:72%;max-height:72%;display:block}
.logo .mono{font-weight:700;color:${W};font-size:1.6rem;letter-spacing:-0.02em}
.logo .num{position:absolute;left:0;top:0;padding:0 0.6em;min-width:0.6em;height:1.5em;line-height:1.5em;font-size:1rem;font-weight:700;text-align:center;border-radius:0.4rem 0 0.4rem 0;background:${C.NUM_PLATE};color:${C.t(0.92)}}
.f .logo{background:${C.LOGO_PLATE}}

/* набор номера */
#osd{position:absolute;left:4rem;top:2.4rem;padding:1rem 1.4rem;border-radius:0.6rem;background:${C.PANEL};min-width:22rem;z-index:30}
#osd .numrow>*{margin-right:1.2rem}
#osd .numrow>*:last-child{margin-right:0}
#osd .big{font-size:2.6rem;font-weight:700;min-width:5rem}
#osd .logo{width:6rem;height:4.2rem}
#osd .name{font-size:1.5rem;font-weight:700;max-width:22rem}
#osd .cands{font-size:1.2rem;color:${C.t(0.65)};margin-top:0.6rem;max-width:30rem}
#osd .cands b{color:${W};font-weight:700;margin-right:0.6rem}
#osd .hrow{margin-top:0.35rem}

/* инфопанель */
#info{position:absolute;left:0;right:0;bottom:0;padding:5.6rem 4rem 2.4rem;z-index:10}
#info .top{display:-webkit-flex;display:flex;-webkit-align-items:flex-start;align-items:flex-start}
#info .logo{width:9.6rem;height:6.6rem;margin:0.2rem 1.4rem 0 0}
#info .logo .mono{font-size:2.2rem}
#info .logo .num{font-size:1.15rem}
#info .body{-webkit-flex:1;flex:1;min-width:0}
#info .l1{height:2.2rem}
#info .chname{font-size:1.4rem;color:${C.t(0.8)};max-width:34rem}
#info .badges{margin-left:1rem;height:2.2rem}
.bdg{display:inline-block;height:1.9rem;line-height:1.9rem;padding:0 0.6rem;margin-right:0.5rem;border-radius:0.4rem;background:${C.FILL_ACTIVE};font-size:1.1rem;font-weight:700;letter-spacing:0.03em;vertical-align:middle;white-space:nowrap}
.bdg.live{background:${C.LIVE}}
.bdg.arch{background:${C.ARCHIVE};color:${C.ON_ARCHIVE}}
.bdg .ic{width:1.2rem;height:1.2rem;margin:-0.15rem 0.25rem 0 0}
.bdg.pause{padding:0 0.5rem}
.bdg.pause i{display:inline-block;width:0.3rem;height:0.95rem;background:currentColor;margin:0 0.12rem;vertical-align:-0.05rem}
#info .title{font-size:2.2rem;font-weight:700;height:2.9rem;line-height:2.9rem;margin-top:0.2rem}
#info .l3{height:1.8rem;margin-top:0.5rem}
#info .ts{font-size:1.25rem;color:${C.t(0.75)}}
#info .bar{position:relative;-webkit-flex:1;flex:1;height:1.6rem;margin:0 0.9rem}
#info .bar canvas{position:absolute;left:0;top:0;width:100%;height:100%}
#info .remain{font-size:1.3rem;font-weight:700;margin-left:1.2rem;white-space:nowrap}
#info .l4{position:relative;height:2.2rem;margin-top:0.5rem}
#info .next{font-size:1.3rem;color:${C.t(0.85)};line-height:2.2rem}
#info .next .lbl{color:${C.t(0.5)}}
#info .seekb{position:absolute;top:0.2rem;padding:0.15rem 0.8rem;border-radius:0.4rem;background:${C.ARCHIVE};color:${C.ON_ARCHIVE};font-size:1.3rem;font-weight:700;white-space:nowrap}
#info .seekb.livel{background:${C.LIVE};color:${W}}
#info .clock{font-size:2.4rem;color:${C.t(0.95)};margin-left:1.6rem;line-height:1}
#info .more{overflow:hidden}
#info .more .sep{height:1px;background:${C.LINE_STRONG};margin-top:1.2rem}
#info .more .mrow{display:-webkit-flex;display:flex;padding-top:1.2rem;-webkit-align-items:flex-start;align-items:flex-start}
#info .banner{border-radius:0.6rem;overflow:hidden;background:${C.FILL_SOFT};margin-right:1.6rem;-webkit-flex:none;flex:none;position:relative}
#info .banner .cover{width:100%;height:100%;object-fit:cover;display:block}
#info .banner .logo{position:absolute;left:0;top:0;width:100%;height:100%;margin:0}
#info .banner .logo img{max-width:60%;max-height:60%}
#info .tags{font-size:1.2rem;color:${C.t(0.65)};line-height:1.6rem;height:1.6rem;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#info .desc{font-size:1.3rem;color:${C.t(0.85)};line-height:1.85rem;max-height:11.1rem;overflow:hidden;margin-top:0.6rem}
#info .upnext{margin-left:2rem;-webkit-flex:none;flex:none}
#info .upnext .h{font-size:1.15rem;color:${C.t(0.5)};margin-bottom:0.3rem}
#info .upnext .r{font-size:1.25rem;line-height:2.1rem}
#info .upnext .r b{font-weight:400;color:${C.t(0.6)};margin-right:0.8rem}

/* подсказки клавиш */
.hints{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;height:1.8rem}
.hint{display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;margin-right:1.8rem;font-size:1.15rem;color:${C.t(0.6)};white-space:nowrap}
.kc{display:inline-block;min-width:2rem;height:1.8rem;line-height:1.6rem;padding:0 0.5rem;border:1px solid ${C.t(0.4)};border-radius:0.4rem;font-size:1.1rem;text-align:center;color:${C.t(0.75)};margin-right:0.6rem}
.kc svg{width:1.2rem;height:1.2rem;vertical-align:-0.2rem}
#info .hints{margin-top:1.2rem}

/* карусель */
#carousel{position:absolute;left:0;right:0;height:11rem;overflow:hidden;z-index:11}
#carousel .card{position:absolute;top:0.6rem;width:12.4rem;height:9.6rem;border-radius:0.6rem;background:${C.PANEL_CARD};padding:0.8rem;text-align:center}
#carousel .card .logo{width:10.8rem;height:6rem;margin:0 auto}
#carousel .card .nm{font-size:1.2rem;margin-top:0.6rem;color:${C.t(0.85)}}
#carousel .card.on{background:${C.PANEL_CARD_ON};box-shadow:0 0 0 0.25rem ${W}}

/* окна */
.overlay{position:absolute;left:0;top:0;right:0;bottom:0;background:${C.OVERLAY};z-index:30}
.win{position:absolute;background:${C.POPUP};border-radius:1rem;padding:1.2rem 1.5rem 1.5rem;overflow:hidden}
.win .head{font-size:1.5rem;font-weight:700;margin-bottom:1rem}
.win .sub{font-size:1.2rem;color:${C.t(0.6)};margin:-0.6rem 0 1rem}
.btns{display:-webkit-flex;display:flex;margin-top:1.4rem}
.btn{height:3.4rem;line-height:3.4rem;padding:0 1.6rem;margin-right:0.6rem;border-radius:0.4rem;background:${C.FILL_BTN};font-size:1.35rem;white-space:nowrap}
.list .it{height:3.6rem;border-radius:0.4rem;padding:0 1rem;font-size:1.35rem;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center}
.list .it .logo{width:4.6rem;height:3rem;margin-right:1rem}
.list .it .logo .mono{font-size:1.1rem}
.list .it .logo .num{font-size:0.9rem}
.list .it .v{margin-left:auto;font-size:1.2rem;color:${C.t(0.5)};padding-left:1rem;white-space:nowrap}
.scroller{position:relative;overflow:hidden}
.scroller .inner{position:absolute;left:0;right:0;top:0;-webkit-transition:-webkit-transform 120ms;transition:transform 120ms}
.fade-top{position:absolute;left:0;right:0;top:0;height:3rem;pointer-events:none}
.fade-bottom{position:absolute;left:0;right:0;bottom:0;height:3rem;pointer-events:none}
.empty{font-size:1.35rem;color:${C.t(0.5)};padding:1rem}
.pbar{position:relative;height:0.35rem;border-radius:0.2rem;background:${C.FILL_MARKED};margin-top:0.4rem}
.pbar i{position:absolute;left:0;top:0;bottom:0;border-radius:0.2rem;background:${W}}
.f .pbar{background:rgba(0,0,0,.18)}.f .pbar i{background:#000}

/* меню канала: шторка справа */
#menu-shade{position:absolute;left:0;top:0;right:0;bottom:0;z-index:28;background:-webkit-linear-gradient(left,rgba(0,0,0,0),rgba(0,0,0,.7));background:linear-gradient(to right,rgba(0,0,0,0),rgba(0,0,0,.7))}
.drawer{position:absolute;right:0;top:0;bottom:0;width:35.6rem;background:${C.POPUP};padding:2.4rem 1.6rem 1.6rem;overflow:hidden}
.drawer .head{font-size:1.5rem;font-weight:700;margin-bottom:0.3rem}
.drawer .sub{font-size:1.2rem;color:${C.t(0.6)};margin-bottom:1.2rem}
.tiles{display:-webkit-flex;display:flex;margin-bottom:0.6rem}
.tile{-webkit-flex:1;flex:1;height:5.4rem;margin-right:0.6rem;border-radius:0.6rem;background:${C.FILL_BTN};display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;font-size:1.1rem;text-align:center;padding:0 0.2rem}
.tile:last-child{margin-right:0}
.tile .ic{width:2rem;height:2rem;margin-bottom:0.4rem}
.gl{font-size:1.1rem;letter-spacing:0.1em;text-transform:uppercase;color:${C.t(0.5)};padding:0.9rem 1rem 0.3rem}
.mi{height:2.6rem;border-radius:0.4rem;padding:0 1rem;font-size:1.3rem;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center}
.mi .v{margin-left:auto;font-size:1.2rem;color:${C.t(0.5)};padding-left:0.8rem;white-space:nowrap}
.mi .chev{width:1.2rem;height:1.2rem;margin-left:0.4rem;color:${C.t(0.5)}}
.f .chev{color:#000}

/* гид */
.guide{position:absolute;left:0;top:0;right:0;bottom:0;z-index:15}
.guide canvas,.guide .gdom{position:absolute;left:0;top:0;width:100%;height:100%}
.guide .gdom{overflow:hidden}
.dk{position:absolute;left:0;top:0;margin:0;padding:0;border:0;white-space:pre;pointer-events:none;-webkit-box-sizing:border-box;box-sizing:border-box}
.dks{width:1px;height:1px;overflow:visible}
.dk svg{display:block;width:100%;height:100%}

/* PIN */
.pin .dots{display:-webkit-flex;display:flex;-webkit-justify-content:center;justify-content:center;height:3rem;margin:0.6rem 0 1.2rem}
.pin .dots i{display:inline-block;width:1.4rem;height:1.4rem;border-radius:50%;background:${W};margin:0.8rem 0.6rem}
.pin .err{color:${C.LIVE};text-align:center;font-size:1.3rem;height:1.8rem}
.pin .kb{display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;width:24rem;margin:0 auto}
.pin .kb b{width:7.4rem;height:4rem;line-height:4rem;margin:0 0.4rem 0.4rem 0;border-radius:0.4rem;background:${C.FILL_BTN};text-align:center;font-size:1.6rem;font-weight:500}
.pin .ring{position:relative;width:20rem;height:20rem;margin:0 auto;border-radius:50%;background:${C.FILL_BTN}}
.pin .ring b{position:absolute;width:5rem;height:5rem;line-height:5rem;margin:-2.5rem 0 0 -2.5rem;text-align:center;font-size:2rem;font-weight:500}
.pin .ring .c{left:50%;top:50%;border-radius:50%;background:${C.FILL_MARKED}}
.pin .rows{display:-webkit-flex;display:flex;-webkit-justify-content:center;justify-content:center;-webkit-align-items:center;align-items:center}
.pin .rows .pad{position:relative;width:16rem;height:16rem;border-radius:50%;background:${C.FILL_BTN};margin-right:2.4rem}
.pin .rows .pad b{position:absolute;width:4.4rem;height:4.4rem;line-height:4.4rem;margin:-2.2rem 0 0 -2.2rem;text-align:center;font-size:1.8rem}
.pin .rows .all{display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap;width:13.2rem}
.pin .rows .all b{width:4rem;height:3.4rem;line-height:3.4rem;margin:0 0.4rem 0.4rem 0;text-align:center;font-size:1.4rem;border-radius:0.4rem;color:${C.t(0.5)}}
.pin .rows .all b.on{color:${W};background:${C.FILL_BTN}}
.pin .hint2{font-size:1.15rem;color:${C.t(0.55)};text-align:center;margin-top:1.2rem}

/* формы */
.field{margin-bottom:1rem}
.field .lbl{font-size:1.2rem;color:${C.t(0.6)};margin-bottom:0.4rem}
.field input{width:100%;height:3.6rem;padding:0 1rem;border-radius:0.4rem;border:0.2rem solid transparent;background:${C.FILL_BTN};color:${W};font-size:1.4rem;font-family:${FONT};outline:none}
.field input.f{border-color:${W};background:${C.FILL_ACTIVE}!important;color:${W}!important}

/* настройки */
.settings{position:absolute;left:0;top:0;right:0;bottom:0;background:${C.SETTINGS_BG};z-index:25}
.settings .nav{position:absolute;left:0;top:0;bottom:0;width:25rem;background:${C.FILL};padding:2.4rem 1.2rem 2.4rem 4rem}
.settings .nav .h{font-size:1.7rem;font-weight:700;margin:0 0 1.4rem 1rem}
.settings .nav .it{height:3.4rem;line-height:3.4rem;padding:0 1rem;border-radius:0.4rem;font-size:1.35rem;margin-bottom:0.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.settings .nav .it.a{background:${C.FILL_ACTIVE}}
.settings.form .nav{opacity:0.4}
.settings .page{position:absolute;left:27rem;right:4rem;top:2.4rem;bottom:5rem}
.settings .page .h{font-size:1.7rem;font-weight:700;margin-bottom:1.2rem;padding-left:1rem}
.settings .si{min-height:4.4rem;padding:0.6rem 1rem;border-radius:0.4rem;background:${C.FILL};margin-bottom:0.3rem;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center}
.settings .si .tx{-webkit-flex:1;flex:1;min-width:0}
.settings .si .nm{font-size:1.35rem}
.settings .si .ds{font-size:1.15rem;color:${C.t(0.55)};margin-top:0.2rem}
.settings .si .val{font-size:1.3rem;color:${C.t(0.75)};margin-left:1.2rem;white-space:nowrap}
.settings .note{font-size:1.15rem;color:${C.t(0.55)};padding:0.6rem 1rem 1rem}
.settings .sect{font-size:1.1rem;letter-spacing:0.1em;text-transform:uppercase;color:${C.t(0.5)};padding:1.2rem 1rem 0.5rem}
.settings .hints{position:absolute;left:27rem;bottom:2.4rem}

/* экран ошибки и мастер */
.screen{position:absolute;left:0;top:0;right:0;bottom:0;background:${C.SETTINGS_BG};z-index:26;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center}
.screen .box{width:60rem;max-width:80%}
.screen .h{font-size:2.4rem;font-weight:700;margin-bottom:1rem}
.screen .p{font-size:1.4rem;color:${C.t(0.7)};line-height:2rem;margin-bottom:1.6rem}

/* программа и архив */
.sched .dates{position:absolute;left:0;top:0;bottom:0;width:9rem}
.sched .date{height:4.6rem;border-radius:0.4rem;padding:0.5rem 0.8rem;font-size:1.2rem;line-height:1.7rem;white-space:pre;margin-bottom:0.3rem}
.sched .date.r{box-shadow:inset 0 0 0 0.2rem ${W}}
.sched .pr{height:4.2rem;border-radius:0.4rem;padding:0 1rem;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;font-size:1.45rem}
.sched .pr .tm{width:5.6rem;-webkit-flex:none;flex:none}
.sched .pr .ic{width:1.7rem;height:1.7rem;margin-left:0.8rem}
.sched .pr .live{margin-left:0.8rem;height:1.7rem;line-height:1.5rem;padding:0 0.8rem;border:1px solid currentColor;border-radius:0.4rem;font-size:1rem;font-weight:700}
.sched .pr.past{color:${C.t(0.6)}}
.sched .pr.playing{background:${C.FILL_PLAYING}}
.sched .dh{font-size:1.15rem;color:${C.t(0.5)};padding:0.9rem 1rem 0.4rem;height:3rem}
.sched .panel{position:absolute;top:0;bottom:0;right:0;padding-left:1.6rem;display:-webkit-flex;display:flex;-webkit-flex-direction:column;flex-direction:column}
.sched .panel .tm{font-size:1.4rem;font-weight:700}
.sched .panel .nm{font-size:1.6rem;font-weight:700;margin-top:0.6rem;line-height:2.1rem}
.sched .panel .ds{font-size:1.25rem;color:${C.t(0.75)};margin-top:0.8rem;line-height:1.8rem;overflow:hidden;-webkit-flex:1;flex:1;min-height:0}
.sched .panel .ok{margin-top:1rem;-webkit-flex:none;flex:none}
.sched .tabs{position:absolute;right:1.5rem;top:1.1rem;display:-webkit-flex;display:flex}
.sched .tab{height:2.8rem;line-height:2.8rem;padding:0 1.2rem;border-radius:0.4rem;font-size:1.25rem;margin-left:0.5rem}

/* поиск */
.search{position:absolute;left:0;top:0;right:0;bottom:0;background:${C.GUIDE_TOP};z-index:22}
.search .q{height:4rem;line-height:4rem;font-size:1.8rem;border-bottom:0.2rem solid ${C.t(0.4)};margin-bottom:1.2rem;white-space:nowrap;overflow:hidden}
.search .kb{display:-webkit-flex;display:flex;-webkit-flex-wrap:wrap;flex-wrap:wrap}
.search .kb b{width:3.2rem;height:3.2rem;line-height:3.2rem;margin:0 0.3rem 0.3rem 0;border-radius:0.4rem;background:${C.FILL_BTN};text-align:center;font-size:1.35rem;font-weight:500}
.search .kb b.fn{background:${C.FILL_MARKED};font-size:1.15rem}
.search .kb b.r{box-shadow:inset 0 0 0 0.2rem ${W}}
`;
}
