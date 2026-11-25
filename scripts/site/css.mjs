export const CSS = `
:root{color-scheme:dark light;--bg:#070b14;--bg2:#0b1220;--fg:#e8edf5;--mut:#98a3b6;--dim:#6b7689;--line:rgba(255,255,255,.09);--card:rgba(255,255,255,.035);--card2:rgba(255,255,255,.06);--acc:#34d399;--acc2:#10b981;--accfg:#03140d;--code:#0a101c;--glow:rgba(52,211,153,.16);--shadow:0 20px 60px -20px rgba(0,0,0,.6);--grid:rgba(255,255,255,.045)}
@media(prefers-color-scheme:light){:root{--bg:#f7f9fb;--bg2:#eef2f6;--fg:#0f172a;--mut:#51607a;--dim:#7a879c;--line:rgba(15,23,42,.1);--card:#fff;--card2:#f1f5f9;--acc:#059669;--acc2:#047857;--accfg:#fff;--code:#0f172a;--glow:rgba(16,185,129,.16);--shadow:0 20px 50px -24px rgba(15,23,42,.35);--grid:rgba(15,23,42,.06)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic","Noto Sans",sans-serif;overflow-x:hidden}
a{color:inherit}a:focus-visible,button:focus-visible,summary:focus-visible,label:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:6px}
img,svg{max-width:100%}
.skip{position:absolute;inset-inline-start:.5rem;top:-3rem;background:var(--acc);color:var(--accfg);padding:.5rem .75rem;border-radius:6px;z-index:30}.skip:focus{top:.5rem}
.wrap{max-width:70rem;margin:0 auto;padding:0 1.25rem}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;direction:ltr;unicode-bidi:isolate}
/* header */
header.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 78%,transparent);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:1rem;min-height:3.6rem}
.brand{display:flex;align-items:center;gap:.55rem;font-weight:700;text-decoration:none;letter-spacing:.01em}.brand img{width:26px;height:26px}
nav.main{display:flex;gap:1.2rem;margin-inline-start:auto;align-items:center;font-size:.92rem}
nav.main a{color:var(--mut);text-decoration:none;transition:color .15s}nav.main a:hover{color:var(--fg)}
.btn{display:inline-flex;align-items:center;gap:.45rem;padding:.6rem 1.05rem;border-radius:10px;border:1px solid var(--line);background:var(--card);text-decoration:none;font-weight:600;font-size:.92rem;color:var(--fg);transition:transform .15s,border-color .15s,background .15s,box-shadow .15s}
.btn:hover{border-color:color-mix(in srgb,var(--acc) 55%,var(--line));transform:translateY(-1px)}
.btn.pri{background:linear-gradient(180deg,var(--acc),var(--acc2));border-color:transparent;color:var(--accfg);box-shadow:0 8px 28px -10px var(--acc)}
.btn.pri:hover{box-shadow:0 12px 34px -10px var(--acc)}
.btn.lg{padding:.8rem 1.35rem;font-size:1rem}
nav.main a.btn{color:var(--fg)}nav.main a.btn.pri{color:var(--accfg)}
details.menu{display:none;margin-inline-start:auto;position:relative}
details.menu summary{list-style:none;cursor:pointer;padding:.45rem .8rem;border:1px solid var(--line);border-radius:9px;font-size:.9rem;background:var(--card)}details.menu summary::-webkit-details-marker{display:none}
details.menu .sheet{position:absolute;inset-inline-end:0;top:calc(100% + .5rem);width:min(18rem,84vw);background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:.6rem;box-shadow:var(--shadow);display:grid;gap:.15rem}
details.menu .sheet a{padding:.65rem .8rem;border-radius:9px;text-decoration:none;color:var(--fg)}details.menu .sheet a:hover{background:var(--card2)}
/* hero */
.hero{position:relative;padding:5rem 0 3.5rem;isolation:isolate}
.hero-bg{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none;mask-image:linear-gradient(#000 55%,transparent)}
.hero-bg:before{content:"";position:absolute;inset:0;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(ellipse 70% 60% at 50% 30%,#000,transparent)}
.hero-bg i{position:absolute;border-radius:50%;filter:blur(70px);background:var(--glow)}
.hero-bg i:nth-child(1){width:34rem;height:24rem;inset-inline-start:-6rem;top:-6rem;animation:drift 18s ease-in-out infinite alternate}
.hero-bg i:nth-child(2){width:26rem;height:22rem;inset-inline-end:-4rem;top:4rem;animation:drift 22s ease-in-out infinite alternate-reverse;opacity:.7}
@keyframes drift{to{transform:translate3d(4rem,2rem,0) scale(1.12)}}
.hero-grid{display:grid;gap:3rem;grid-template-columns:minmax(0,1.02fr) minmax(0,1fr);align-items:center}
.badge{display:inline-flex;align-items:center;gap:.5rem;border:1px solid var(--line);background:var(--card);color:var(--mut);padding:.28rem .8rem;border-radius:999px;font-size:.8rem;margin-bottom:1.3rem}
.dot{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 0 var(--acc);animation:ping 2s infinite}
@keyframes ping{70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
h1{font-size:clamp(2.2rem,5.2vw,3.7rem);line-height:1.07;margin:0 0 1.2rem;letter-spacing:-.035em;font-weight:760}
h1 .g{background:linear-gradient(100deg,var(--acc),#67e8f9 80%);-webkit-background-clip:text;background-clip:text;color:transparent}
[dir=rtl] h1{letter-spacing:0;line-height:1.3}
.lead{font-size:1.14rem;color:var(--mut);max-width:38rem;margin:0 0 1.8rem}
.cta{display:flex;gap:.7rem;flex-wrap:wrap;margin-bottom:1.3rem}
.sub{display:flex;align-items:center;gap:.5rem;color:var(--dim);font-size:.85rem}
.install{display:flex;align-items:center;gap:.6rem;background:var(--code);color:#dbe4f0;border:1px solid var(--line);border-radius:11px;padding:.55rem .6rem .55rem .9rem;margin-top:1.1rem;max-width:30rem;font-size:.9rem}
.install code{flex:1;overflow-x:auto;white-space:nowrap}.install .pr{color:var(--acc);margin-inline-end:.4rem;user-select:none}
.copy{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#cbd5e1;border-radius:8px;padding:.25rem .65rem;font:600 .78rem system-ui;cursor:pointer}.copy:hover{background:rgba(255,255,255,.12)}
/* code window */
.win{background:var(--code);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden;color:#d6deeb;position:relative}
.win-h{display:flex;align-items:center;gap:.45rem;padding:.7rem .95rem;border-bottom:1px solid rgba(255,255,255,.07);direction:ltr}
.win-h i{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.16)}.win-h span{margin-inline-start:.5rem;font-size:.78rem;color:#8a97ab;font-family:ui-monospace,Menlo,monospace}
.win pre{margin:0;padding:1.1rem 1.2rem;overflow-x:auto;font-size:.82rem;line-height:1.65;tab-size:2}
.t-c{color:#6b7a90;font-style:italic}.t-s{color:#a5e8c8}.t-k{color:#7dd3fc}.t-n{color:#fbbf77}.t-f{color:#93b4ff}.t-p{color:#d6deeb}
.hero-visual{position:relative}
.hero-visual{padding-bottom:3.2rem}.float{position:absolute;inset-inline-end:-1rem;bottom:-.4rem;width:min(19rem,82%);background:var(--bg2);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:.8rem .9rem;font-size:.8rem;animation:bob 6s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-6px)}}
.feed-h{display:flex;align-items:center;gap:.45rem;color:var(--mut);font-size:.74rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.5rem}
.feed{list-style:none;margin:0;padding:0;display:grid;gap:.35rem;direction:ltr}
[dir=rtl] .feed{direction:rtl}
.feed li{display:flex;gap:.55rem;align-items:center;font-family:ui-monospace,Menlo,monospace;font-size:.76rem;padding:.12rem .4rem;border-radius:6px;animation:feed 8s infinite}
.feed li:nth-child(2){animation-delay:2s}.feed li:nth-child(3){animation-delay:4s}.feed li:nth-child(4){animation-delay:6s}
@keyframes feed{0%,22%{background:var(--glow)}34%,100%{background:transparent}}
.feed b{font-weight:600;color:var(--acc);min-width:4.6rem}.feed em{font-style:normal;color:var(--mut)}.feed s{text-decoration:none;color:var(--dim);margin-inline-start:auto}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:18px;background:var(--card);overflow:hidden}
.stat{padding:1.3rem 1.4rem;border-inline-end:1px solid var(--line)}.stat:last-child{border:0}
.stat strong{white-space:nowrap;display:block;font-size:1.9rem;letter-spacing:-.02em;line-height:1.1;background:linear-gradient(180deg,var(--fg),var(--mut));-webkit-background-clip:text;background-clip:text;color:transparent}
.stat span{display:block;font-size:.9rem;margin-top:.25rem}.stat small{color:var(--dim);font-size:.8rem}
/* sections */
section.s{padding:5rem 0 0}
.eyebrow{color:var(--acc);font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0 0 .7rem}
[dir=rtl] .eyebrow{letter-spacing:0}
h2{font-size:clamp(1.6rem,3.4vw,2.4rem);line-height:1.15;letter-spacing:-.025em;margin:0 0 .9rem;max-width:30ch;font-weight:720}
[dir=rtl] h2{letter-spacing:0;line-height:1.4}
.sec-p{color:var(--mut);max-width:44rem;margin:0 0 2rem;font-size:1.04rem}
/* architecture */
.arch{display:grid;grid-template-columns:1fr auto 1fr auto 1.15fr;gap:0;align-items:center;margin-top:1.5rem}
.node{border:1px solid var(--line);background:var(--card);border-radius:16px;padding:1.1rem 1.2rem;position:relative}
.node h4{margin:0;font-size:1rem}.node p{margin:.2rem 0 0;color:var(--mut);font-size:.82rem}
.node.pgbox{border-color:color-mix(in srgb,var(--acc) 40%,var(--line));background:linear-gradient(180deg,var(--glow),var(--card))}
.pgbox .tag{position:absolute;top:-.7rem;inset-inline-start:1rem;background:var(--acc);color:var(--accfg);font-size:.72rem;font-weight:700;padding:.1rem .6rem;border-radius:999px}
.pgbox .pair{display:grid;gap:.6rem;margin-top:.4rem}.pgbox .pair div{border:1px dashed var(--line);border-radius:11px;padding:.6rem .8rem}
.link{width:3.4rem;height:2px;position:relative;margin:0 .2rem;background:repeating-linear-gradient(90deg,var(--dim) 0 6px,transparent 6px 12px);opacity:.7}
.link:after{content:"";position:absolute;top:-3px;inset-inline-start:0;width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc);animation:flow 2.4s linear infinite}
[dir=rtl] .link:after{animation-name:flowr}
@keyframes flow{to{inset-inline-start:100%;opacity:.2}}@keyframes flowr{to{inset-inline-start:100%;opacity:.2}}
/* bento */
.bento{display:grid;gap:1rem;grid-template-columns:repeat(6,1fr)}
.cell{min-width:0;border:1px solid var(--line);background:var(--card);border-radius:20px;padding:1.4rem;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}
.cell:hover{border-color:color-mix(in srgb,var(--acc) 40%,var(--line))}
.cell h3{margin:0 0 .35rem;font-size:1.12rem;letter-spacing:-.01em}.cell p{margin:0 0 1rem;color:var(--mut);font-size:.94rem}
.c-q{grid-column:span 4}.c-r{grid-column:span 2}.c-rt,.c-s,.c-a,.c-i{grid-column:span 3}
.cell:before{content:"";position:absolute;inset:0;background:radial-gradient(18rem 10rem at var(--mx,80%) -10%,var(--glow),transparent);opacity:.8;pointer-events:none}
.cell>*{position:relative}
.cell .win pre{font-size:.78rem;padding:.9rem 1rem}
.chips{display:flex;flex-wrap:wrap;gap:.5rem}.chip{border:1px solid var(--line);background:var(--card2);border-radius:999px;padding:.3rem .8rem;font-size:.82rem;color:var(--mut)}
.chip.on{border-color:color-mix(in srgb,var(--acc) 50%,var(--line));color:var(--fg)}
.graph{width:100%;height:auto;display:block;direction:ltr}
.graph .nd{fill:var(--card2);stroke:var(--line)}.graph .nd.hi{stroke:var(--acc);fill:color-mix(in srgb,var(--acc) 12%,var(--card2))}
.graph text{fill:var(--fg);font:600 12px ui-monospace,Menlo,monospace}.graph .sm{fill:var(--mut);font-weight:500;font-size:10px}
.graph .ed{stroke:var(--dim);stroke-width:1.5;fill:none}.graph .ed.fl{stroke:var(--acc);stroke-dasharray:5 6;animation:dash 1.6s linear infinite}
@keyframes dash{to{stroke-dashoffset:-22}}
.prov{display:flex;flex-wrap:wrap;gap:.5rem}
/* tabs */
.tabs{position:relative}.tabs>input{position:absolute;opacity:0;pointer-events:none}
.tabbar{display:inline-flex;gap:.25rem;padding:.25rem;border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:1rem}
.tabbar label{padding:.4rem 1rem;border-radius:9px;cursor:pointer;font-size:.9rem;font-weight:600;color:var(--mut)}
#tab1:checked~.tabbar label[for=tab1],#tab2:checked~.tabbar label[for=tab2]{background:var(--card2);color:var(--fg)}
.pane{display:none}#tab1:checked~.panes .p1,#tab2:checked~.panes .p2{display:block}
.sdk-grid{display:grid;gap:2rem;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);align-items:start}
/* ai */
.term pre{font-size:.8rem}.term .t-k{color:var(--acc)}
.split{display:grid;gap:3rem;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);align-items:center}
/* faq */
details.q{border-top:1px solid var(--line);padding:1rem 0}details.q:last-of-type{border-bottom:1px solid var(--line)}
details.q summary{cursor:pointer;font-weight:620;list-style:none;display:flex;justify-content:space-between;gap:1rem}details.q summary::-webkit-details-marker{display:none}
details.q summary:after{content:"+";color:var(--acc);font-size:1.3rem;line-height:1}details.q[open] summary:after{content:"\\2212"}
details.q p{color:var(--mut);margin:.6rem 0 0;max-width:46rem}
/* CTA */
.ctaband{margin-top:5rem;border:1px solid var(--line);border-radius:26px;padding:3.2rem 1.5rem;text-align:center;position:relative;overflow:hidden;background:var(--card)}
.ctaband:before{content:"";position:absolute;inset:0;background:radial-gradient(40rem 16rem at 50% 120%,var(--glow),transparent)}
.ctaband>*{position:relative}.ctaband h2{margin-inline:auto}.ctaband p{color:var(--mut);margin:0 auto 1.6rem;max-width:34rem}.ctaband .cta{justify-content:center;margin:0}
/* inner pages */
.phero{padding:4rem 0 1rem;position:relative;isolation:isolate}
.feat{display:grid;gap:3rem;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);align-items:center;padding:3rem 0;border-top:1px solid var(--line)}
.feat:nth-of-type(even)>:first-child{order:2}
.feat h2{font-size:1.7rem}.feat p{color:var(--mut)}
.steps{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));counter-reset:s;margin-top:1rem}
.step{border:1px solid var(--line);border-radius:16px;padding:1.2rem;background:var(--card)}.step:before{counter-increment:s;content:counter(s);display:inline-grid;place-items:center;width:1.8rem;height:1.8rem;border-radius:50%;background:var(--acc);color:var(--accfg);font-weight:700;font-size:.85rem;margin-bottom:.6rem}
.step h3{margin:0 0 .25rem;font-size:1.02rem}.step p{margin:0;color:var(--mut);font-size:.92rem}
.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))}
.cards .cell{padding:1.3rem}.cards .cell p{margin:0}
.planes{display:grid;grid-template-columns:1fr auto 1fr;gap:1rem;align-items:center;margin:1rem 0 .5rem}
.lock{width:2.6rem;height:2.6rem;border-radius:50%;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--acc) 50%,var(--line));color:var(--acc);background:var(--glow)}
/* footer */
footer{border-top:1px solid var(--line);margin-top:5rem;padding:2.5rem 0 3rem;color:var(--mut);font-size:.9rem;background:linear-gradient(var(--bg),var(--bg2))}
.fcols{display:grid;gap:1.5rem;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));margin-bottom:1.6rem}.fcols h4{margin:0 0 .5rem;color:var(--fg);font-size:.85rem}.fcols a{display:block;color:var(--mut);text-decoration:none;padding:.18rem 0}.fcols a:hover{color:var(--fg)}
.nf{padding:7rem 0;text-align:center}.nf h1{font-size:clamp(4rem,12vw,7rem);margin:0}
/* reveal */
html.js .rv{opacity:0;transform:translateY(18px);transition:opacity .7s cubic-bezier(.2,.7,.2,1),transform .7s cubic-bezier(.2,.7,.2,1)}
html.js .rv.in{opacity:1;transform:none}
html.js .rv.d1{transition-delay:.08s}html.js .rv.d2{transition-delay:.16s}html.js .rv.d3{transition-delay:.24s}
@media(max-width:900px){
 .hero{padding:3rem 0 2.5rem}.hero-grid,.split,.sdk-grid,.feat{grid-template-columns:minmax(0,1fr);gap:2.2rem}.feat:nth-of-type(even)>:first-child{order:0}
 .float{position:relative;inset:auto;margin:-1.2rem .8rem 0 auto;width:min(19rem,92%)}
 .stats{grid-template-columns:repeat(2,1fr)}.stat strong{font-size:1.5rem}.stat{padding:1rem}.stat:nth-child(2){border-inline-end:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line)}
 .arch{grid-template-columns:minmax(0,1fr);gap:0}.link{width:2px;height:2.2rem;margin:.2rem auto;background:repeating-linear-gradient(180deg,var(--dim) 0 6px,transparent 6px 12px)}
 .link:after{top:0;inset-inline-start:-3px;animation-name:flowv}@keyframes flowv{to{top:100%;opacity:.2}}
 .bento{grid-template-columns:minmax(0,1fr)}.cell{grid-column:auto!important}
 nav.main{display:none}details.menu{display:block}section.s{padding-top:3.5rem}
 .planes{grid-template-columns:minmax(0,1fr)}.lock{margin:0 auto}
}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}html.js .rv{opacity:1;transform:none}}
`;
