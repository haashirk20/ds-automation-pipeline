// The one stylesheet, served at /style.css. System fonts, one accent, no animation, no images.
export const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#1b1f24;--muted:#57606a;--line:#d0d7de;--accent:#0b5cad;--accent-text:#fff;--ok:#1a7f37;--ok-bg:#dafbe1;--bad:#b42318;--bad-bg:#ffebe9;--warn-bg:#fff4d6;--warn:#7a4b00;--add-bg:#dafbe1;--del-bg:#ffebe9}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--panel:#1c2024;--text:#e6e8eb;--muted:#a3abb4;--line:#363c43;--accent:#5aa6f0;--accent-text:#0b1620;--ok:#56d364;--ok-bg:#12301c;--bad:#ff8d85;--bad-bg:#3b1715;--warn-bg:#3a2d0e;--warn:#f2c36b;--add-bg:#12301c;--del-bg:#3b1715}}
*{box-sizing:border-box}
html{font-size:100%}
body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
header.top{background:var(--panel);border-bottom:1px solid var(--line)}
nav{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center;max-width:70rem;margin:0 auto;padding:.5rem 1rem}
nav a{padding:.5rem .75rem;min-height:44px;display:inline-flex;align-items:center;border-radius:6px;color:var(--text);text-decoration:none}
nav a[aria-current=page]{background:var(--accent);color:var(--accent-text);font-weight:600}
nav a:hover{text-decoration:underline}
nav form{margin:0 0 0 auto}
main{max-width:70rem;margin:0 auto;padding:1rem}
h1{font-size:1.5rem;margin:.5rem 0 1rem}
h2{font-size:1.2rem;margin:1.5rem 0 .5rem}
h3{font-size:1rem;margin:1rem 0 .25rem}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.banner,.notice,.error-box{padding:.75rem 1rem;border-radius:6px;border:1px solid var(--line);margin:0 0 1rem}
.banner{background:var(--warn-bg);color:var(--warn);border-color:var(--warn);font-weight:600}
.notice{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}
.error-box{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:1rem;margin:0 0 1rem}
fieldset{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:0 0 1rem;padding:1rem}
legend{font-weight:700;padding:0 .5rem;font-size:1.05rem}
.field{display:grid;grid-template-columns:minmax(10rem,16rem) minmax(0,1fr);gap:.25rem 1rem;padding:.6rem 0;border-top:1px solid var(--line)}
.field:first-of-type{border-top:0}
.field label,.field .lbl{font-weight:600}
.hint{display:block;color:var(--muted);font-size:.875rem}
.err{display:block;color:var(--bad);font-weight:600;font-size:.9rem;margin-top:.25rem}
.field.has-error input,.field.has-error select,.field.has-error textarea{border-color:var(--bad);border-width:2px}
input[type=text],input[type=number],input[type=password],select,textarea{width:100%;max-width:32rem;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--muted);border-radius:6px;padding:.5rem .6rem;min-height:44px}
input[readonly]{color:var(--muted)}
textarea{max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem;min-height:18rem}
input[type=checkbox]{width:1.5rem;height:1.5rem;vertical-align:middle}
button{font:inherit;min-height:44px;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--muted);background:var(--panel);color:var(--text);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent);font-weight:600}
button.link{border:0;background:none;color:var(--text);padding:.5rem .75rem}
button:hover{text-decoration:underline}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin-top:1rem}
.actions form{margin:0}
table{border-collapse:collapse;width:100%;background:var(--panel)}
th,td{text-align:left;vertical-align:top;padding:.45rem .6rem;border-bottom:1px solid var(--line);overflow-wrap:break-word}
th{font-size:.875rem;color:var(--muted);font-weight:600}
.scroll{margin-bottom:1rem;overflow-x:auto;border:1px solid var(--line);border-radius:8px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem}
pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.75rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.diff{padding:0}
.diff div{padding:0 .6rem;white-space:pre-wrap;overflow-wrap:anywhere}
.diff .add{background:var(--add-bg)}
.diff .del{background:var(--del-bg)}
.tag{display:inline-block;padding:0 .5rem;border-radius:999px;border:1px solid var(--line);font-size:.8rem}
.tag.bad{color:var(--bad);border-color:var(--bad);font-weight:600}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.login{max-width:26rem;margin:3rem auto}
@media (max-width:40rem){.field{grid-template-columns:1fr}main{padding:.75rem}nav form{margin:0}}
`;
