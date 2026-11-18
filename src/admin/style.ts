// The one stylesheet, served at /style.css. A cozy pixel-art factory theme to match the Factory floor:
// grass around a cream factory floor, steel header with a hazard stripe, wooden signs, chunky bevelled
// buttons and plates with square edges. System fonts only (the CSP allows no font files), no images
// (every texture is a CSS gradient), no animation.
export const CSS = `
:root{--ink:#1b1c24;--grass:#5c9c3e;--grass2:#579539;--bg:#f3ead6;--panel:#fffaf0;--text:#2a2118;--muted:#6b5a45;--line:#d6c5a2;
--accent:#1f5fbf;--accent-text:#1b1c24;--btn:#e8dcc0;--go:#5cb85c;--amber:#f5a524;--wood:#a8703f;--woodD:#7a4c28;--steel:#3e444e;--steelL:#5d6673;
--ok:#1a6b30;--ok-bg:#d9f2c9;--bad:#a8231a;--bad-bg:#ffd9d2;--warn-bg:#ffe58a;--warn:#3a2a00;--add-bg:#d9f2c9;--del-bg:#ffd9d2;--zebra:rgba(168,112,63,.08);
--mono:ui-monospace,"Cascadia Mono",Consolas,"Courier New",monospace}
@media (prefers-color-scheme:dark){:root{--grass:#23401f;--grass2:#203b1c;--bg:#2a2620;--panel:#352f27;--text:#f1e6cf;--muted:#c2b39a;--line:#5a4e3e;
--accent:#8cc0ff;--btn:#5a4e3e;--go:#3f9a4a;--ok:#7ee08a;--ok-bg:#1d3a1f;--bad:#ff9a8f;--bad-bg:#45201b;--warn-bg:#4a3c10;--warn:#ffe58a;--add-bg:#1d3a1f;--del-bg:#45201b;--zebra:rgba(255,230,190,.05)}}
*{box-sizing:border-box}
html{font-size:100%}
body{margin:0;color:var(--text);font:1rem/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:repeating-conic-gradient(var(--grass) 0 25%,var(--grass2) 0 50%) 0 0/16px 16px,var(--grass);min-height:100vh}
::selection{background:var(--amber);color:var(--ink)}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:2px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--amber);outline-offset:2px;box-shadow:0 0 0 6px var(--ink)}

/* header: a steel beam with a hazard stripe */
header.top{position:relative;background:linear-gradient(var(--steelL) 0 3px,var(--steel) 3px);border-bottom:3px solid var(--ink);padding-bottom:8px}
header.top::after{content:"";position:absolute;left:0;right:0;bottom:0;height:8px;background:repeating-linear-gradient(-45deg,#e7b52c 0 8px,var(--ink) 8px 16px);border-top:2px solid var(--ink)}
nav{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;max-width:70rem;margin:0 auto;padding:.6rem 1rem}
nav a,nav button.link{padding:.4rem .7rem;min-height:44px;display:inline-flex;align-items:center;border:3px solid transparent;color:#f4efe4;text-decoration:none;font:700 .85rem/1 var(--mono);text-transform:uppercase;letter-spacing:.04em}
nav a:hover,nav button.link:hover{background:var(--steelL);border-color:var(--ink);text-decoration:none}
nav a[aria-current=page]{background:var(--amber);color:var(--ink);border-color:var(--ink);box-shadow:inset -3px -3px 0 rgba(0,0,0,.22),inset 3px 3px 0 rgba(255,255,255,.45)}
nav form{margin:0 0 0 auto}

/* the factory floor every page sits on */
main{max-width:70rem;margin:1.5rem auto 2.5rem;padding:1.25rem 1.5rem 1.5rem;background:var(--bg);border:4px solid var(--ink);box-shadow:8px 8px 0 rgba(27,28,36,.55),inset 0 4px 0 rgba(255,255,255,.35)}
h1,h2,h3,legend{font-family:var(--mono);text-transform:uppercase;letter-spacing:.04em}
h1{display:inline-flex;align-items:center;gap:.6rem;font-size:1.5rem;line-height:1.2;margin:0 0 1.25rem;padding:.35rem .9rem .35rem .6rem;color:#fff4dc;background:var(--wood);border:3px solid var(--ink);
  box-shadow:4px 4px 0 var(--ink),inset 0 3px 0 rgba(255,255,255,.25),inset 0 -4px 0 var(--woodD);text-shadow:2px 2px 0 var(--woodD)}
h1::before{content:"";flex:none;width:1.1em;height:1.1em;border:3px solid var(--ink);
  background:linear-gradient(90deg,transparent 38%,#efd9a6 38% 62%,transparent 62%) 0 0/100% 55% no-repeat,linear-gradient(#e8b97a 0 3px,#d29a5a 3px 60%,#9c6a36 60%)}
h2{font-size:1.1rem;margin:1.75rem 0 .75rem;padding-bottom:.45rem;background:repeating-linear-gradient(-45deg,#e7b52c 0 6px,var(--ink) 6px 12px) left bottom/100% 4px no-repeat}
h3{font-size:.95rem;margin:1rem 0 .35rem}
p{margin:.5rem 0}
.muted{color:var(--muted)}

/* message plates */
.banner,.notice,.error-box{padding:.7rem 1rem;border:3px solid var(--ink);margin:0 0 1rem;box-shadow:3px 3px 0 var(--ink)}
.banner{background:repeating-linear-gradient(-45deg,var(--ink) 0 6px,#f2c230 6px 12px) left/14px 100% no-repeat,var(--warn-bg);color:var(--warn);padding-left:1.75rem;font-weight:700}
.notice{background:var(--ok-bg);color:var(--ok);font-weight:600}
.error-box{background:var(--bad-bg);color:var(--bad);font-weight:600}

/* panels: bolted plates */
.panel,fieldset{background:
  linear-gradient(var(--steelL),var(--steelL)) 6px 6px/4px 4px no-repeat,linear-gradient(var(--steelL),var(--steelL)) calc(100% - 6px) 6px/4px 4px no-repeat,
  linear-gradient(var(--steelL),var(--steelL)) 6px calc(100% - 6px)/4px 4px no-repeat,linear-gradient(var(--steelL),var(--steelL)) calc(100% - 6px) calc(100% - 6px)/4px 4px no-repeat,var(--panel);
  border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink),inset 0 3px 0 rgba(255,255,255,.4);padding:1.1rem 1.25rem;margin:0 0 1.25rem}
fieldset{padding-top:.6rem}
legend{font-weight:700;padding:.25rem .7rem;font-size:.9rem;background:var(--ink);color:var(--amber);border:3px solid var(--ink)}
.field{display:grid;grid-template-columns:minmax(10rem,16rem) minmax(0,1fr);gap:.25rem 1rem;padding:.7rem 0;border-top:2px dashed var(--line)}
.field:first-of-type{border-top:0}
.field label,.field .lbl{font-weight:700}
.hint{display:block;color:var(--muted);font-size:.875rem}
.err{display:block;color:var(--bad);font-weight:700;font-size:.9rem;margin-top:.25rem}
.field.has-error input,.field.has-error select,.field.has-error textarea{border-color:var(--bad)}

/* inputs: sunken slots */
input[type=text],input[type=number],input[type=password],select,textarea{width:100%;max-width:32rem;font:inherit;color:var(--text);background:var(--bg);border:3px solid var(--ink);border-radius:0;padding:.5rem .6rem;min-height:44px;box-shadow:inset 3px 3px 0 rgba(0,0,0,.14)}
input[readonly]{color:var(--muted);background:repeating-linear-gradient(-45deg,transparent 0 6px,rgba(0,0,0,.04) 6px 12px),var(--bg)}
textarea{max-width:100%;font-family:var(--mono);font-size:.9rem;min-height:18rem}
textarea.short{min-height:0}
td code{overflow-wrap:anywhere}
input[type=checkbox]{width:1.5rem;height:1.5rem;vertical-align:middle;accent-color:var(--go)}
input[type=file]{font:inherit;max-width:100%}
input[type=file]::file-selector-button{font:700 .8rem var(--mono);text-transform:uppercase;margin-right:.75rem;padding:.45rem .8rem;border:3px solid var(--ink);background:var(--btn);color:var(--text);cursor:pointer}

/* buttons: chunky bevelled plates that press down */
button{font:700 .85rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.04em;min-height:44px;padding:.55rem 1rem;border:3px solid var(--ink);border-radius:0;background:var(--btn);color:var(--text);cursor:pointer;
  box-shadow:inset -3px -3px 0 rgba(0,0,0,.22),inset 3px 3px 0 rgba(255,255,255,.45),0 4px 0 var(--ink);margin-bottom:4px;position:relative}
button:hover{filter:brightness(1.07)}
button:active{top:3px;box-shadow:inset 3px 3px 0 rgba(0,0,0,.22),0 1px 0 var(--ink)}
button.primary{background:var(--go);color:var(--ink)}
button.link{border:0;background:none;box-shadow:none;color:var(--text);padding:.5rem .75rem;margin:0}
button.link:active{top:0}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-top:1rem}
.actions form{margin:0}
.actions>a{font:700 .85rem var(--mono);text-transform:uppercase}

/* tables: a control board */
table{border-collapse:collapse;width:100%;background:var(--panel)}
th,td{text-align:left;vertical-align:top;padding:.5rem .65rem;border-bottom:2px solid var(--line);overflow-wrap:break-word}
tbody tr:nth-child(even){background:var(--zebra)}
.nw{white-space:nowrap}
th{font:700 .78rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
thead th{background:var(--steel);color:#ffd36a;border-bottom:3px solid var(--ink)}
.scroll{margin-bottom:1.25rem;overflow-x:auto;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink)}
.panel>table{background:transparent}

/* code: the green terminal from the concept studio */
code,pre{font-family:var(--mono);font-size:.875rem}
:not(pre)>code{background:rgba(27,28,36,.09);padding:.05rem .3rem;border:1px solid rgba(27,28,36,.18)}
pre{background:#14181f;color:#c9f2b8;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink),inset 0 0 0 2px #2b3340;padding:.85rem 1rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.diff{padding:0}
.diff div{padding:0 .6rem;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);font-size:.875rem}
.diff .add{background:var(--add-bg)}
.diff .del{background:var(--del-bg)}

/* small stamped tags */
.tag{display:inline-block;padding:.05rem .45rem;border:2px solid var(--ink);background:var(--btn);font:700 .72rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.04em}
.tag.bad{color:#fff;background:var(--bad);border-color:var(--ink)}
.tag.ok{color:var(--ink);background:#7ed36b}

video,audio{display:block;max-width:100%}
video{width:100%;max-width:16rem;background:#000;border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink)}
.card{display:grid;grid-template-columns:minmax(0,16rem) minmax(0,1fr);gap:1rem}
.login{max-width:26rem;margin:3rem auto}

/* brand plate in the header, and the line under each title */
nav a.brand{background:var(--wood);color:#fff4dc;border-color:var(--ink);margin-right:.5rem;box-shadow:inset 0 -3px 0 var(--woodD)}
.lede{margin:-.5rem 0 1.25rem;color:var(--muted);font-size:1.05rem}
h2 small{font:600 .8rem var(--mono);text-transform:none;letter-spacing:0;margin-left:.5rem}
a.btn{display:inline-flex;align-items:center;min-height:44px;padding:.55rem 1rem;border:3px solid var(--ink);background:var(--btn);color:var(--text);text-decoration:none;font:700 .85rem/1.2 var(--mono);text-transform:uppercase;box-shadow:inset -3px -3px 0 rgba(0,0,0,.22),inset 3px 3px 0 rgba(255,255,255,.45),0 4px 0 var(--ink)}
a.btn.primary{background:var(--go);color:var(--ink)}
button.link.danger{color:var(--bad)}

/* home: status tiles and big shortcuts */
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1rem;margin:0 0 1.5rem}
.tile{display:flex;flex-direction:column;gap:.15rem;padding:.9rem 1rem;background:var(--panel);border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink);color:var(--text);text-decoration:none;border-top-width:10px}
.tile:hover{filter:brightness(1.04);text-decoration:none}
.tile.good{border-top-color:#3fa45a}.tile.bad{border-top-color:var(--bad)}.tile.warn{border-top-color:var(--amber)}
.tile-l{font:700 .75rem var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.tile-v{font:800 1.45rem/1.2 var(--mono)}
.tile-s{font-size:.85rem;color:var(--muted)}
.quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:.9rem;margin:0 0 1.5rem}
.qa{display:flex;flex-direction:column;gap:.3rem;padding:.9rem 1rem;min-height:6.5rem;background:var(--wood);color:#fff4dc;border:3px solid var(--ink);box-shadow:inset 0 3px 0 rgba(255,255,255,.25),inset 0 -5px 0 var(--woodD),4px 4px 0 var(--ink);text-decoration:none}
.qa b{font:800 .95rem var(--mono);text-transform:uppercase}
.qa span{font-size:.85rem;opacity:.92}
.qa:hover{filter:brightness(1.08);text-decoration:none}
.qa:active{transform:translateY(2px)}
details.tech summary{cursor:pointer;font:700 .85rem var(--mono);text-transform:uppercase;min-height:32px}
details.tech[open] summary{margin-bottom:.5rem}

/* numbered how-to strip */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.5rem;margin:0 0 1rem}
.steps div{display:flex;gap:.6rem;align-items:center;padding:.5rem .7rem;background:var(--panel);border:2px dashed var(--line)}
.steps b{flex:none;display:grid;place-items:center;width:1.6rem;height:1.6rem;background:var(--amber);border:3px solid var(--ink);font:800 .85rem var(--mono)}

/* products */
.pgrid{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));gap:1rem;margin:0;padding:0}
.pcard{display:flex;flex-direction:column;background:var(--panel);border:3px solid var(--ink);box-shadow:4px 4px 0 var(--ink);opacity:.72}
.pcard.on{opacity:1;box-shadow:4px 4px 0 var(--ink),inset 0 0 0 3px var(--go)}
.pcard-pick{display:flex;align-items:center;gap:.5rem;padding:.45rem .6rem;background:var(--steel);color:#f4efe4;font:700 .8rem var(--mono);text-transform:uppercase;cursor:pointer;min-height:44px}
.pcard.on .pcard-pick{background:var(--go);color:var(--ink)}
.pcard-img{display:grid;place-items:center;aspect-ratio:1;background:repeating-conic-gradient(rgba(0,0,0,.05) 0 25%,transparent 0 50%) 0 0/16px 16px,#fff;border-bottom:3px solid var(--ink)}
.pcard-img img{width:100%;height:100%;object-fit:contain}
.pcard-body{display:flex;flex-direction:column;gap:.25rem;padding:.6rem .7rem .8rem}
.pcard-price{font:800 1.05rem var(--mono)}
.pcard-act{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.25rem}
.pcard-act button{min-height:0;padding:0}
.pcard.add{opacity:1;border-style:dashed;box-shadow:none;background:transparent}
.pcard.add a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;min-height:14rem;font:800 .9rem var(--mono);text-transform:uppercase;text-decoration:none;color:var(--text)}
.plus{display:grid;place-items:center;width:3rem;height:3rem;background:var(--go);border:3px solid var(--ink);box-shadow:0 4px 0 var(--ink);font:800 2rem/1 var(--mono)}
.tag.shop{background:#95bf47;color:var(--ink)}.tag.own{background:var(--amber);color:var(--ink)}
.pcard .tag{align-self:flex-start}
.logo-panel{display:grid;grid-template-columns:10rem minmax(0,1fr);gap:1.25rem;align-items:start}
.logo-box{display:grid;place-items:center;aspect-ratio:1;border:3px solid var(--ink);background:repeating-conic-gradient(rgba(0,0,0,.06) 0 25%,transparent 0 50%) 0 0/16px 16px,#fff}
.logo-box img{width:100%;height:100%;object-fit:contain}
.thumbs{display:flex;flex-wrap:wrap;gap:.75rem}
.thumb{display:flex;flex-direction:column;align-items:center;gap:.25rem;font-size:.85rem}
.thumb img{width:96px;height:96px;object-fit:contain;border:3px solid var(--ink);background:#fff}
.price-row{display:flex;gap:.5rem;max-width:32rem}
.price-row input{flex:1}.price-row select{width:7rem}
@media (max-width:40rem){.logo-panel{grid-template-columns:1fr}.logo-box{max-width:10rem}}
@media (max-width:40rem){.field,.card{grid-template-columns:1fr}main{padding:1rem .85rem;margin:.75rem .5rem 1.5rem;box-shadow:4px 4px 0 rgba(27,28,36,.55)}nav form{margin:0}h1{font-size:1.2rem}}
`;
