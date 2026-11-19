// The stylesheet of every admin page except Factory, served at /style.css (D-41). Plain and calm: sentence-case
// system fonts, a warm paper palette that keeps 4.5:1 text contrast in both colour schemes, and a wood-brown
// brand plate with one thin hazard stripe as the only nod to the Factory. No images, no fonts, no animation.
export const CSS = `
:root{--bg:#f6f1e7;--surface:#fffdf8;--surface-2:#efe6d4;--text:#231c14;--muted:#5f5141;--border:#d9ccb0;--border-strong:#8a7a60;
--accent:#1f5fbf;--primary:#2f7d32;--on-primary:#fff;--danger:#a8231a;--ok:#1f5f24;--ok-bg:#e3f3d8;--warn:#5a3d00;--warn-bg:#fff1c2;
--bad-bg:#fbe3df;--info:#1d4a8a;--info-bg:#e4eefb;--brand:#8a5a2f;--header:#3e444e;--on-header:#f4efe4;--ink:#1b1c24;
--add-bg:#d9f2c9;--del-bg:#ffd9d2;--radius:4px;--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-6:1.5rem;--space-8:2rem;
--font:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--mono:ui-monospace,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1f1b16;--surface:#2b251e;--surface-2:#352f27;--text:#f1e6cf;--muted:#c2b39a;--border:#4a4033;
--accent:#8cc0ff;--ok:#9fe0a6;--ok-bg:#1d3a1f;--warn:#ffe58a;--warn-bg:#4a3c10;--danger:#ff9a8f;--bad-bg:#45201b;--info:#a9cdfb;--info-bg:#1d2c44;
--add-bg:#1d3a1f;--del-bg:#45201b;color-scheme:dark}}
*{box-sizing:border-box}
html{font-size:100%}
body{margin:0;background:var(--bg);color:var(--text);font:1.0625rem/1.55 var(--font)}
a{color:var(--accent);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.vh{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.muted{color:var(--muted)}
.hint{display:block;color:var(--muted);font-size:.9375rem;margin-top:var(--space-1)}
p{margin:var(--space-2) 0}
h1{font-size:1.75rem;line-height:1.25;font-weight:700;margin:0 0 var(--space-2)}
h2{font-size:1.3rem;line-height:1.3;font-weight:700;margin:0 0 var(--space-3)}
h3{font-size:1.1rem;font-weight:600;margin:var(--space-4) 0 var(--space-2)}
code,pre{font-family:var(--mono);font-size:.875rem}
:not(pre)>code{background:var(--surface-2);padding:.05rem .3rem;border-radius:var(--radius);overflow-wrap:anywhere}
pre{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3) var(--space-4);overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}

/* header: brand plate, primary links, More; one Menu on phones */
header.top{background:var(--header);color:var(--on-header);border-bottom:6px solid transparent;border-image:repeating-linear-gradient(-45deg,#e7b52c 0 8px,var(--ink) 8px 16px) 6}
nav{display:flex;align-items:center;gap:var(--space-1);max-width:60rem;margin:0 auto;padding:var(--space-2) var(--space-4);min-height:56px}
nav a,nav summary,nav button.link{display:inline-flex;align-items:center;min-height:44px;padding:0 var(--space-3);border-radius:var(--radius);color:var(--on-header);text-decoration:none;font:600 1rem/1 var(--font);background:none;border:0;cursor:pointer}
nav a:hover,nav summary:hover,nav button.link:hover{background:rgba(255,255,255,.12)}
nav a[aria-current=page]{background:var(--on-header);color:var(--header)}
nav a.brand{background:var(--brand);color:#fff;font-weight:700;margin-right:var(--space-2);border:2px solid var(--ink)}
nav .nav-wide{display:flex;align-items:center;gap:var(--space-1);flex:1;flex-wrap:wrap}
nav details{position:relative}
nav summary{list-style:none}
nav summary::-webkit-details-marker{display:none}
nav summary::after{content:"\\25BE";margin-left:var(--space-2);font-size:.8em}
nav details[open]>summary{background:rgba(255,255,255,.12)}
nav details.more{margin-left:auto}
nav .drop{position:absolute;right:0;top:100%;z-index:10;min-width:15rem;display:flex;flex-direction:column;gap:2px;padding:var(--space-2);background:var(--header);border:1px solid var(--ink);border-radius:var(--radius);box-shadow:0 6px 16px rgba(0,0,0,.3)}
nav .drop form{margin:0}
nav .drop button.link{width:100%;text-align:left}
nav .drop hr{border:0;border-top:1px solid rgba(255,255,255,.25);margin:var(--space-1) 0;width:100%}
nav details.menu{display:none;margin-left:auto}
@media (max-width:48rem){nav .nav-wide{display:none}nav details.menu{display:block}}

/* page frame */
main{max-width:60rem;margin:0 auto;padding:var(--space-6)}
.lede{color:var(--muted);margin:0 0 var(--space-6);font-size:1.0625rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4) var(--space-6);margin:0 0 var(--space-6)}
.card>h2:first-child,.card>.section-head:first-child{margin-top:0}
.section-head{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4);align-items:center;justify-content:space-between;margin:0 0 var(--space-3)}
.section-head h2{margin:0}
.section-actions{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center}
.section-actions form{margin:0}
section{margin:0 0 var(--space-8)}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{font-weight:600;padding:0;margin-bottom:var(--space-2)}

/* form rows */
.form-row{display:grid;grid-template-columns:minmax(12rem,18rem) 1fr;gap:var(--space-1) var(--space-4);padding:var(--space-3) 0;border-top:1px solid var(--border)}
.form-row:first-of-type{border-top:0}
.form-row>label,.form-row>.lbl{font-weight:600;padding-top:.6rem}
.ctl{min-width:0}
.unit{margin-left:var(--space-2);color:var(--muted)}
.err{display:block;color:var(--danger);font-weight:600;margin-top:var(--space-1)}
.has-error input,.has-error select,.has-error textarea{border-color:var(--danger);border-width:2px}
input[type=text],input[type=number],input[type=password],input[type=time],select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius);padding:.5rem .6rem;min-height:44px;width:100%;max-width:24rem}
input[type=time],input[inputmode=decimal]{max-width:10rem}
input[readonly]{background:var(--surface-2);color:var(--muted);border-color:var(--border)}
textarea{max-width:100%;font-family:var(--mono);font-size:.9375rem;min-height:18rem}
textarea.short{min-height:0;font-family:var(--font)}
input[type=checkbox],input[type=radio]{width:1.375rem;height:1.375rem;accent-color:var(--primary);vertical-align:middle;margin:0}
input[type=file]{font:inherit;max-width:100%}
input[type=file]::file-selector-button{font:600 1rem var(--font);margin-right:var(--space-3);min-height:44px;padding:0 var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface-2);color:var(--text);cursor:pointer}
.check{display:flex;gap:var(--space-3);align-items:center;min-height:44px;cursor:pointer}
.price-row{display:flex;gap:var(--space-2);max-width:24rem}
.price-row input{flex:1;max-width:none}.price-row select{width:7rem}

/* on/off switch: a checkbox with role=switch and visible On/Off text */
.toggle{position:relative;display:inline-flex;align-items:center;gap:var(--space-3);min-height:44px;cursor:pointer;font-weight:600}
.toggle input{appearance:none;-webkit-appearance:none;position:relative;width:3rem;height:1.75rem;border-radius:1rem;background:var(--surface-2);border:2px solid var(--border-strong);cursor:pointer;flex:none}
.toggle input::after{content:"";position:absolute;top:2px;left:2px;width:1.2rem;height:1.2rem;border-radius:50%;background:var(--border-strong)}
.toggle input:checked{background:var(--primary);border-color:var(--primary)}
.toggle input:checked::after{left:auto;right:2px;background:#fff}
.toggle .on,.toggle input:checked~.off{display:none}
.toggle input:checked~.on{display:inline}

/* buttons */
button,a.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);font:600 1rem/1.2 var(--font);min-height:44px;padding:.5rem var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface-2);color:var(--text);cursor:pointer;text-decoration:none}
button:hover,a.btn:hover{filter:brightness(.96)}
button.primary,a.btn.primary,.btn.primary{background:var(--primary);color:var(--on-primary);border:2px solid var(--ink)}
button.danger,.btn.danger{background:var(--danger);color:#fff;border-color:var(--danger)}
button.link,.btn.link,summary.btn.link{background:none;border:0;color:var(--accent);text-decoration:underline;padding:0 var(--space-2)}
button.link.danger,.btn.link.danger{color:var(--danger);background:none}
button:disabled{opacity:.55;cursor:not-allowed;filter:none}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;margin-top:var(--space-4)}
.actions form{margin:0}
.apart{margin-left:auto}

/* confirmation for destructive actions: open the details, then press the real button */
details.confirm{display:inline-block}
details.confirm>summary{list-style:none;display:inline-flex;align-items:center;min-height:44px;cursor:pointer}
details.confirm>summary::-webkit-details-marker{display:none}
details.confirm[open]>div{margin-top:var(--space-2);padding:var(--space-3);border:1px solid var(--danger);border-radius:var(--radius);background:var(--bad-bg)}
details.confirm[open]>div p{margin:0 0 var(--space-2)}

/* badges: always with words, never colour alone */
.badge{display:inline-block;padding:.05rem .5rem;border-radius:1rem;font-size:.875rem;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.badge.ok{color:var(--ok);background:var(--ok-bg)}
.badge.warn{color:var(--warn);background:var(--warn-bg)}
.badge.bad{color:var(--danger);background:var(--bad-bg)}
.badge.neutral{color:var(--muted);background:var(--surface-2)}

/* flashes: what happened, then when it takes effect */
.flash{display:flex;gap:var(--space-3);align-items:flex-start;padding:var(--space-3) var(--space-4);border-radius:var(--radius);border:1px solid currentColor;border-left-width:6px;margin:0 0 var(--space-6)}
.flash p{margin:0}
.flash .icon{font-weight:700;flex:none}
.flash.ok{color:var(--ok);background:var(--ok-bg)}
.flash.bad{color:var(--danger);background:var(--bad-bg)}
.flash.warn{color:var(--warn);background:var(--warn-bg)}
.flash.info{color:var(--info);background:var(--info-bg)}
.flash details{margin-top:var(--space-2);color:var(--text)}
.err-summary{padding:var(--space-3) var(--space-4);border:2px solid var(--danger);border-radius:var(--radius);background:var(--bad-bg);color:var(--danger);margin:0 0 var(--space-6)}
.err-summary ul{margin:var(--space-2) 0 0;padding-left:1.25rem}
.err-summary a{color:var(--danger);font-weight:600}
.empty{border:2px dashed var(--border-strong);border-radius:var(--radius);padding:var(--space-4) var(--space-6);color:var(--muted);margin:0 0 var(--space-4)}
.empty p{margin:0 0 var(--space-2)}

/* tables: scroll inside .scroll, stack on phones */
.scroll{position:relative;overflow-x:auto;margin:0 0 var(--space-4)}
table{border-collapse:collapse;width:100%;background:var(--surface)}
th,td{text-align:left;vertical-align:top;padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--border);overflow-wrap:anywhere}
thead th{font-size:.9375rem;color:var(--muted);border-bottom:2px solid var(--border-strong);overflow-wrap:normal}
td.num,.nw{white-space:nowrap;font-variant-numeric:tabular-nums}
td details summary{cursor:pointer;color:var(--accent)}
@media (max-width:40rem){
  table.stack thead{display:none}
  table.stack tr{display:block;border-bottom:1px solid var(--border-strong);padding:var(--space-2) 0}
  table.stack td{display:flex;gap:var(--space-3);border:0;padding:var(--space-1) var(--space-2)}
  table.stack td[data-label]::before{content:attr(data-label);flex:0 0 7rem;color:var(--muted);font-weight:600}
}
.diff{padding:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin:0 0 var(--space-4)}
.diff div{padding:0 var(--space-3);white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);font-size:.875rem}
.diff .add{background:var(--add-bg)}
.diff .del{background:var(--del-bg)}
details.tech{margin:0 0 var(--space-6)}
details.tech>summary,details.plain>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600;color:var(--accent)}
details.tech[open]>summary{margin-bottom:var(--space-3)}
details.card>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:1.3rem;font-weight:700}
details.card[open]>summary{margin-bottom:var(--space-3)}

/* sticky save bar */
/* keyboard focus and in-page links scroll to above the bar, never under it (the bar is up to ~8.5rem tall when it wraps at 360 px) */
html:has(.sticky-save){scroll-padding-bottom:10rem}
.sticky-save{position:sticky;bottom:0;z-index:5;display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;padding:var(--space-3) var(--space-4);margin:var(--space-4) 0 0;background:var(--surface-2);border-top:1px solid var(--border-strong)}

/* home */
.headline{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4);align-items:center;margin:0 0 var(--space-2)}
.headline p{font-size:1.5rem;font-weight:700;margin:0}
.next-line{margin:0 0 var(--space-6);font-size:1.125rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:var(--space-4);margin:0 0 var(--space-8)}
.tile{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-3) var(--space-4);background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--border-strong);border-radius:var(--radius);color:var(--text);text-decoration:none}
.tile:hover{background:var(--surface-2)}
.tile.ok{border-left-color:var(--primary)}.tile.bad{border-left-color:var(--danger)}.tile.warn{border-left-color:#c98a00}
.tile-l{font-size:.9375rem;color:var(--muted);font-weight:600}
.tile-v{font-size:1.5rem;font-weight:700;line-height:1.25}
.tile-s{font-size:.9375rem;color:var(--muted)}
.quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:var(--space-3);margin:0 0 var(--space-8)}
.qa{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-3) var(--space-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);text-decoration:none;color:var(--text)}
.qa:hover{background:var(--surface-2)}
.qa b{color:var(--accent)}
.qa span{font-size:.9375rem;color:var(--muted)}

/* videos waiting, music tracks */
video,audio{display:block;max-width:100%}
video{width:100%;max-width:14rem;background:#000;border-radius:var(--radius)}
.media-row{display:grid;grid-template-columns:minmax(0,14rem) minmax(0,1fr);gap:var(--space-6)}
.tracks{list-style:none;margin:0;padding:0}
.track{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:var(--space-2) var(--space-4);align-items:center;padding:var(--space-3) 0;border-top:1px solid var(--border)}
.track:first-child{border-top:0}
.track audio{grid-column:1/-1;width:100%}
.track details.tech{grid-column:1/-1;margin:0}

/* products */
.next-posts{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-2)}
.next-posts li{padding:var(--space-2) var(--space-3);background:var(--surface-2);border-radius:var(--radius)}
.pgrid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:var(--space-4);margin:0;padding:0}
.pcard{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.pcard.on{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary)}
.pcard-img{display:grid;place-items:center;aspect-ratio:3/2;max-height:11rem;background:#fff;border-bottom:1px solid var(--border)}
.pcard-img img{width:100%;height:100%;object-fit:contain}
.pcard-img .muted{font-weight:600;color:#5f5141}
.pcard-body{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-3) var(--space-4) var(--space-4)}
.pcard-price{font-weight:700}
.pcard fieldset{margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--border)}
.pcard-act{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-3);align-items:center;margin-top:var(--space-2)}
.pcard .badge{align-self:flex-start}
.pcard.add{border:2px dashed var(--border-strong);background:transparent}
.pcard.add a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-2);min-height:12rem;font-weight:600;text-decoration:none}
.plus{display:grid;place-items:center;width:3rem;height:3rem;border-radius:50%;background:var(--primary);color:#fff;font:700 2rem/1 var(--font)}
.logo-panel{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:var(--space-6);align-items:start}
.logo-box{display:grid;place-items:center;aspect-ratio:1;border:1px solid var(--border);border-radius:var(--radius);background:#fff}
.logo-box img{width:100%;height:100%;object-fit:contain}
.logo-box .muted{color:#5f5141}
.logo-panel .form-row{grid-template-columns:1fr}
.logo-panel .form-row>label{padding-top:0}
.thumbs{display:flex;flex-wrap:wrap;gap:var(--space-3)}
.thumb{display:flex;flex-direction:column;align-items:center;gap:var(--space-1);font-size:.9375rem}
.thumb img{width:96px;height:96px;object-fit:contain;border:1px solid var(--border);border-radius:var(--radius);background:#fff}

/* settings */
.times td,.times th{vertical-align:middle}
.times input[type=time]{min-width:7.5rem}
.safe input{max-width:6rem}
.login{max-width:24rem;margin:var(--space-8) auto}
.login .form-row{grid-template-columns:1fr}
.login .form-row>label{padding-top:0}

@media (max-width:40rem){
  main{padding:var(--space-4)}
  .card{padding:var(--space-4)}
  .form-row{grid-template-columns:1fr}
  .form-row>label,.form-row>.lbl{padding-top:0}
  .media-row,.logo-panel{grid-template-columns:1fr}
  .logo-box{max-width:10rem}
  h1{font-size:1.5rem}
  .apart{margin-left:0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;
