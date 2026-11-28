export const CSS = `
:root{color-scheme:dark light;
--paper:#f5f4f0;--raised:#fdfdfa;--ink:#191811;--mut:#5d594c;--dim:#8a8577;
--line:rgba(25,24,17,.16);--line2:rgba(25,24,17,.08);
--acc:#c2410c;--accfg:#fdfdfa;
--plate:#17160f;--plate-fg:#e6e2d5;--plate-mut:#8f8a7a;
--serif:Georgia,"Iowan Old Style","Times New Roman","Noto Serif",serif;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic","Noto Sans",sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono",monospace}
@media(prefers-color-scheme:dark){:root{
--paper:#131210;--raised:#1a1916;--ink:#e9e6dc;--mut:#a09b8c;--dim:#6f6a5e;
--line:rgba(233,230,220,.17);--line2:rgba(233,230,220,.08);
--acc:#f0642f;--accfg:#171510;
--plate:#0d0c09;--plate-fg:#ded9cb;--plate-mut:#7d7869}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans);overflow-x:hidden}
::selection{background:var(--acc);color:var(--accfg)}
a{color:inherit;text-decoration-color:color-mix(in srgb,var(--acc) 55%,transparent);text-underline-offset:3px}
a:hover{text-decoration-color:var(--acc)}
a:focus-visible,button:focus-visible,summary:focus-visible,label:focus-visible{outline:2px solid var(--acc);outline-offset:3px;border-radius:2px}
img,svg{max-width:100%}
.skip{position:absolute;inset-inline-start:.5rem;top:-3rem;background:var(--acc);color:var(--accfg);padding:.5rem .75rem;border-radius:2px;z-index:30;text-decoration:none}.skip:focus{top:.5rem}
.wrap{max-width:68rem;margin:0 auto;padding:0 1.25rem}
code,pre,.mono{font-family:var(--mono);direction:ltr;unicode-bidi:isolate}
/* header */
header.top{position:sticky;top:0;z-index:20;background:var(--paper);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:1rem;min-height:3.4rem}
.brand{display:flex;align-items:baseline;gap:.45rem;font-family:var(--serif);font-weight:700;font-size:1.12rem;text-decoration:none;letter-spacing:.01em}
.brand i{width:8px;height:8px;background:var(--acc);border-radius:1px;transform:translateY(-1px)}
nav.main{display:flex;gap:1.25rem;margin-inline-start:auto;align-items:center;font-size:.88rem}
nav.main a{color:var(--mut);text-decoration:none;transition:color .15s}nav.main a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;gap:.45rem;padding:.55rem 1rem;border-radius:3px;border:1px solid var(--line);background:var(--raised);text-decoration:none;font-weight:600;font-size:.88rem;color:var(--ink);transition:border-color .15s,background .15s}
.btn:hover{border-color:var(--ink)}
.btn.pri{background:var(--acc);border-color:var(--acc);color:var(--accfg)}
.btn.pri:hover{background:color-mix(in srgb,var(--acc) 88%,var(--ink));border-color:color-mix(in srgb,var(--acc) 88%,var(--ink))}
.btn.lg{padding:.7rem 1.3rem;font-size:.95rem}
nav.main a.btn{color:var(--ink)}nav.main a.btn.pri{color:var(--accfg)}
details.menu{display:none;margin-inline-start:auto;position:relative}
details.menu summary{list-style:none;cursor:pointer;padding:.45rem .8rem;border:1px solid var(--line);border-radius:3px;font-size:.88rem;background:var(--raised)}details.menu summary::-webkit-details-marker{display:none}
details.menu .sheet{position:absolute;inset-inline-end:0;top:calc(100% + .5rem);width:min(18rem,84vw);background:var(--raised);border:1px solid var(--line);border-radius:3px;padding:.4rem;display:grid;gap:.1rem}
details.menu .sheet a{padding:.6rem .75rem;border-radius:2px;text-decoration:none;color:var(--ink)}details.menu .sheet a:hover{background:var(--paper)}
/* hero */
.hero{padding:4.5rem 0 3rem;border-bottom:1px solid var(--line)}
.kicker{display:flex;align-items:center;gap:.6rem;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin:0 0 1.4rem}
[dir=rtl] .kicker{letter-spacing:0}
.kicker:before{content:"";width:8px;height:8px;background:var(--acc);border-radius:1px}
h1{font-family:var(--serif);font-size:clamp(2.3rem,5vw,3.6rem);line-height:1.08;margin:0 0 1.2rem;letter-spacing:-.015em;font-weight:700}
[dir=rtl] h1{letter-spacing:0;line-height:1.3}
h1 em{font-style:italic;color:var(--acc)}
.lead{font-size:1.1rem;color:var(--mut);max-width:36rem;margin:0 0 1.7rem}
.hero-grid{display:grid;gap:3rem;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);align-items:start}
.cta{display:flex;gap:.7rem;flex-wrap:wrap;margin-bottom:1.2rem}
.sub{color:var(--dim);font-size:.85rem}
.install{display:flex;align-items:center;gap:.6rem;background:var(--plate);color:var(--plate-fg);border:1px solid var(--plate);border-radius:3px;padding:.55rem .6rem .55rem .9rem;margin-top:1.1rem;max-width:30rem;font-size:.88rem}
.install code{flex:1;overflow-x:auto;white-space:nowrap}.install .pr{color:var(--acc);margin-inline-end:.4rem;user-select:none}
.copy{border:1px solid var(--line);background:transparent;color:var(--plate-mut);border-radius:2px;padding:.25rem .65rem;font:600 .76rem var(--sans);cursor:pointer}.copy:hover{color:var(--plate-fg);border-color:var(--plate-mut)}
/* code plate */
.win{background:var(--plate);border:1px solid var(--plate);border-radius:3px;overflow:hidden;color:var(--plate-fg);position:relative}
.win-h{display:flex;align-items:center;gap:.5rem;padding:.6rem .95rem;border-bottom:1px solid rgba(230,226,213,.12);direction:ltr}
.win-h:before{content:"";width:7px;height:7px;background:var(--acc);border-radius:1px}
.win-h span{font-size:.76rem;color:var(--plate-mut);font-family:var(--mono)}
.win pre{margin:0;padding:1rem 1.15rem;overflow-x:auto;font-size:.82rem;line-height:1.65;tab-size:2}
.t-c{color:#77725f;font-style:italic}.t-s{color:#b8cf9e}.t-k{color:#7fb5c9}.t-n{color:#d8a05e}.t-f{color:#9ea8d8}.t-p{color:var(--plate-fg)}
figure.plate{margin:0}
figcaption{display:flex;gap:.6rem;align-items:baseline;margin-top:.6rem;font-size:.8rem;color:var(--mut)}
figcaption b{font-family:var(--mono);font-weight:600;color:var(--acc);font-size:.76rem;white-space:nowrap}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:3rem 0 0}
.stat{padding:1.4rem 1.4rem;border-inline-end:1px solid var(--line2)}.stat:last-child{border:0}
.stat strong{display:block;font-family:var(--serif);font-size:2rem;letter-spacing:-.01em;line-height:1.1;font-weight:700}
.stat span{display:block;font-size:.88rem;margin-top:.3rem}
.stat small{color:var(--dim);font-size:.78rem}
/* sections */
section.s{padding:4.5rem 0 0}
.shead{display:flex;align-items:baseline;gap:1rem;border-bottom:1px solid var(--line);padding-bottom:.9rem;margin-bottom:1.8rem}
.snum{font-family:var(--mono);font-size:.85rem;font-weight:600;color:var(--acc)}
.eyebrow{color:var(--mut);font-size:.78rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin:0}
[dir=rtl] .eyebrow{letter-spacing:0}
h2{font-family:var(--serif);font-size:clamp(1.55rem,3vw,2.15rem);line-height:1.18;letter-spacing:-.01em;margin:0 0 .8rem;max-width:32ch;font-weight:700}
[dir=rtl] h2{letter-spacing:0;line-height:1.4}
.sec-p{color:var(--mut);max-width:44rem;margin:0 0 1.8rem;font-size:1rem}
/* architecture diagram: ruled boxes, right-angle connectors */
.arch{display:grid;grid-template-columns:1fr auto 1fr auto 1.15fr;gap:0;align-items:stretch;margin-top:1.5rem}
.node{border:1px solid var(--line);background:var(--raised);border-radius:2px;padding:1rem 1.1rem;position:relative}
.node h4{margin:0;font-size:.95rem;font-family:var(--serif)}.node p{margin:.25rem 0 0;color:var(--mut);font-size:.8rem}
.node.pgbox{border-color:var(--acc);border-inline-start-width:3px}
.link{align-self:center;width:2.2rem;height:1px;background:var(--line);position:relative}
.link:after{content:"";position:absolute;inset-inline-end:-1px;top:-3px;border:1.5px solid var(--line);border-bottom:0;border-inline-start:0;width:5px;height:5px;transform:rotate(45deg)}
[dir=rtl] .link:after{transform:rotate(-45deg);inset-inline-end:auto;inset-inline-start:-1px}
.tag{position:absolute;top:-.6rem;inset-inline-start:.8rem;background:var(--paper);padding:0 .45rem;font:600 .68rem var(--mono);color:var(--acc);letter-spacing:.06em}
.pair{display:grid;gap:.7rem;margin-top:.2rem}
/* ledger: the feature index */
.ledger{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.ledger>li{display:grid;grid-template-columns:3.2rem minmax(0,17rem) 1fr auto;gap:1.2rem;align-items:baseline;padding:1.05rem 0;border-bottom:1px solid var(--line2)}
.ledger>li:hover{background:color-mix(in srgb,var(--raised) 65%,transparent)}
.ledger .idx{font-family:var(--mono);font-size:.82rem;font-weight:600;color:var(--acc)}
.ledger h3{margin:0;font-family:var(--serif);font-size:1.08rem;font-weight:700}
.ledger p{margin:0;color:var(--mut);font-size:.9rem}
.ledger .tagx{font-family:var(--mono);font-size:.72rem;color:var(--dim);border:1px solid var(--line2);border-radius:2px;padding:.2rem .5rem;white-space:nowrap}
/* plates row */
.plates{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:1.8rem;align-items:start}
/* graph (relations) */
.graph text{fill:var(--ink);font:12px var(--mono)}.graph .sm{fill:var(--mut);font-size:10px}
.graph .nd{fill:var(--raised);stroke:var(--line);rx:2}
.graph .nd.hi{stroke:var(--acc)}
.graph .ed{fill:none;stroke:var(--mut);stroke-width:1.2}
/* sdk tabs */
.sdk-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:3rem;align-items:start}
.tabs{position:relative}
.tabs input{position:absolute;opacity:0;pointer-events:none}
.tabbar{display:inline-flex;border:1px solid var(--line);border-radius:3px;overflow:hidden;margin-bottom:1rem;background:var(--raised)}
.tabbar label{padding:.45rem 1rem;font-size:.85rem;cursor:pointer;color:var(--mut);border-inline-end:1px solid var(--line2)}
.tabbar label:last-child{border:0}
.tabs input#tab1:checked~.tabbar label[for=tab1],.tabs input#tab2:checked~.tabbar label[for=tab2]{background:var(--ink);color:var(--paper)}
.tabs .pane{display:none}
.tabs input#tab1:checked~.panes .p1,.tabs input#tab2:checked~.panes .p2{display:block}
/* split section */
.split{display:grid;grid-template-columns:1fr 1fr;gap:3rem;align-items:center}
/* faq */
.q{border-top:1px solid var(--line);padding:.95rem 0}
.q:last-of-type{border-bottom:1px solid var(--line)}
.q summary{cursor:pointer;font-family:var(--serif);font-weight:700;font-size:1.02rem;list-style:none;display:flex;gap:.8rem;align-items:baseline}
.q summary::-webkit-details-marker{display:none}
.q summary:before{content:"+";font-family:var(--mono);color:var(--acc);font-weight:600}
.q[open] summary:before{content:"–"}
.q p{margin:.6rem 0 0;color:var(--mut);max-width:46rem;font-size:.94rem}
/* cta band */
.ctaband{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:4.5rem 0;padding:3rem 0;text-align:start}
.ctaband h2{margin-bottom:.6rem}
.ctaband p{color:var(--mut);margin:0 0 1.5rem;max-width:40rem}
/* page hero (subpages) */
.phero{padding:3.8rem 0 2.6rem;border-bottom:1px solid var(--line)}
.phero .lead{margin-bottom:0}
/* feature rows on subpages */
.feat{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:2.5rem;padding:2.6rem 0;border-bottom:1px solid var(--line2);align-items:start}
.feat:last-of-type{border:0}
.feat h2{font-size:1.5rem}
.feat p{color:var(--mut);font-size:.95rem;margin:.5rem 0 0}
/* security planes */
.planes{display:grid;grid-template-columns:1fr auto 1.2fr;gap:1.2rem;align-items:center;margin-top:2.2rem}
.lock{color:var(--acc);display:flex}
/* cards (security grid) */
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid var(--line);border-radius:2px;overflow:hidden;margin:2.4rem 0}
.cards .cell{padding:1.3rem 1.3rem;border-inline-end:1px solid var(--line2);border-bottom:1px solid var(--line2);background:var(--raised)}
.cards .cell h3{margin:0 0 .4rem;font-family:var(--serif);font-size:1.02rem}
.cards .cell p{margin:0;color:var(--mut);font-size:.86rem}
.chips,.prov{display:flex;flex-wrap:wrap;gap:.45rem}
.chip{font:500 .76rem var(--mono);border:1px solid var(--line2);color:var(--mut);border-radius:2px;padding:.28rem .6rem}
.chip.on{border-color:color-mix(in srgb,var(--acc) 45%,var(--line2));color:var(--acc)}
/* steps */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-top:1px solid var(--line);margin-top:2.6rem}
.step{padding:1.3rem 1.3rem 1.3rem 0;border-inline-end:1px solid var(--line2)}
.step:last-child{border:0}
.step h3{margin:0 0 .35rem;font-family:var(--serif);font-size:1rem}
.step h3:before{content:counter(step) ". ";color:var(--acc);font-family:var(--mono);font-size:.85rem}
.steps{counter-reset:step}.step{counter-increment:step}
.step p{margin:0;color:var(--mut);font-size:.86rem}
/* feed (realtime sample, kept as mono log) */
.feed-h{display:flex;align-items:center;gap:.5rem;color:var(--mut);font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.5rem}
[dir=rtl] .feed-h{letter-spacing:0}
.feed-h:before{content:"";width:7px;height:7px;background:var(--acc);border-radius:1px}
.feed{list-style:none;margin:0;padding:0;display:grid;gap:.3rem;direction:ltr}
[dir=rtl] .feed{direction:rtl}
.feed li{display:flex;gap:.55rem;align-items:center;font-family:var(--mono);font-size:.76rem;padding:.12rem .4rem}
.feed b{font-weight:600;color:var(--acc);min-width:4.6rem}.feed em{font-style:normal;color:var(--mut)}.feed s{text-decoration:none;color:var(--dim);margin-inline-start:auto}
/* 404 */
.nf{text-align:center;padding:6rem 0}
.nf h1{font-size:5rem;margin-bottom:.6rem}
/* footer */
footer{border-top:1px solid var(--line);margin-top:4.5rem;padding:2.6rem 0 2rem;font-size:.86rem}
.fcols{display:grid;grid-template-columns:repeat(3,1fr);gap:2rem;margin-bottom:1.8rem}
.fcols h4{margin:0 0 .6rem;font:700 .78rem var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
[dir=rtl] .fcols h4{letter-spacing:0}
.fcols a{display:block;color:var(--mut);text-decoration:none;padding:.18rem 0}.fcols a:hover{color:var(--ink)}
footer p{color:var(--dim);margin:.25rem 0;font-size:.8rem}
/* responsive */
@media(max-width:60rem){
.hero-grid,.sdk-grid,.split,.feat{grid-template-columns:1fr}
.stats{grid-template-columns:repeat(2,1fr)}.stat:nth-child(2){border-inline-end:0}.stat:nth-child(-n+2){border-bottom:1px solid var(--line2)}
.arch{grid-template-columns:1fr}.link{width:1px;height:1.6rem;justify-self:center}.link:after{inset-inline-end:auto;top:auto;bottom:-1px;inset-inline-start:-3px;transform:rotate(135deg)}
[dir=rtl] .link:after{transform:rotate(45deg)}
.plates{grid-template-columns:1fr}
.cards{grid-template-columns:1fr}.cards .cell{border-inline-end:0}
.steps{grid-template-columns:1fr}.step{border-inline-end:0;border-bottom:1px solid var(--line2);padding-inline-start:0}
.planes{grid-template-columns:1fr}.lock{justify-self:center;transform:rotate(90deg)}
.ledger>li{grid-template-columns:2.4rem 1fr;grid-template-rows:auto auto}
.ledger .idx{grid-row:1}.ledger h3{grid-column:2}.ledger p{grid-column:2}.ledger .tagx{grid-column:2;justify-self:start}
nav.main{display:none}details.menu{display:block}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`.trim();
