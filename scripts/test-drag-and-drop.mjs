#!/usr/bin/env node
/**
 * Prove that dragging a file from one pane to the other actually moves it.
 *
 * Not part of `npm test`: it needs a demo control plane and a real Chrome.
 *
 *   node scripts/demo-env.mjs --port 7315 &
 *   node scripts/test-drag-and-drop.mjs <url-with-token> /tmp/shots
 *
 * ## A real drag, not a fabricated one
 *
 * A hand-made DragEvent carries its own empty DataTransfer, so the payload the
 * application writes on dragstart never reaches the drop — the handler fires and
 * does nothing, which looks like a pass and is not one.
 *
 * Chrome can intercept its own native drag instead: setInterceptDrags(true)
 * turns a genuine mouse drag into a `Input.dragIntercepted` event carrying the
 * real drag data, which is then handed to dispatchDragEvent at the target.
 * Everything the browser would have done, it does.
 *
 * The fabricated version was not merely imprecise, it reported success: the
 * drop handler ran, found nothing in its DataTransfer, and did nothing, while
 * the check looked at the wrong pane and saw the word it wanted. Two bugs
 * agreeing is not a passing test.
 *
 * Ground truth is the filesystem — look for the file under the demo's scratch
 * directory afterwards, not at the screen.
 */
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
/* global WebSocket */
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9343; const OUT=process.argv[3]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'rd-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--window-size=1500,950','about:blank'],{ stdio:'ignore' });
let t; for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl); if(p){t=p.webSocketDebuggerUrl;break;}}catch{} await sleep(250);}
const ws=new WebSocket(t); await new Promise(r=>ws.addEventListener('open',r,{ once:true }));
let id=1; const pend=new Map(); const events=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
  if(m.method){events.push(m); return;}
  const w=pend.get(m.id); if(w){pend.delete(m.id); w(m.result);}});
const send=(me,pa={})=>{const i=id++; ws.send(JSON.stringify({ id:i,method:me,params:pa })); return new Promise(r=>pend.set(i,r));};
const ev = async e => (await send('Runtime.evaluate',{ expression:e,returnByValue:true,awaitPromise:true })).result?.value;
const shot = async n => { const s=await send('Page.captureScreenshot',{ format:'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.data,'base64')); };
const waitFor = async (method, ms=4000) => {
  const until = Date.now()+ms;
  while (Date.now() < until) {
    const hit = events.find(e => e.method === method);
    if (hit) { events.length = 0; return hit.params; }
    await sleep(60);
  }
  return null;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Input.enable').catch(()=>{});
await send('Emulation.setDeviceMetricsOverride',{ width:1500,height:950,deviceScaleFactor:1,mobile:false });
await send('Page.navigate',{ url:process.argv[2] }); await sleep(3000);
await ev('document.querySelectorAll(\'[aria-label="Browse files"]\')[1].click()'); await sleep(3800);

const centreOf = async name => ev(`
  (() => { const e = [...document.querySelectorAll('*')]
      .find(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(name)} && e.offsetParent);
    if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);

// Into Documents first: the previous run dragged the folder itself and the
// application correctly refused it. A file is the case worth proving.
const folder = await centreOf('Documents');
await send('Input.dispatchMouseEvent',{ type:'mousePressed',x:folder.x,y:folder.y,button:'left',clickCount:2 });
await send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:folder.x,y:folder.y,button:'left',clickCount:2 });
await sleep(2200);
const from = await centreOf('runbook.md');
const to   = await centreOf('backups');
console.log(`  source (Documents, gauche): ${JSON.stringify(from)}`);
console.log(`  cible  (backups, droite)  : ${JSON.stringify(to)}`);
if (!from || !to) { console.log('  ✗ points introuvables'); chrome.kill(); process.exit(1); }

await send('Input.setInterceptDrags', { enabled: true });

// A drag the browser itself recognises: press, then move far enough to pass the
// threshold that starts one.
await send('Input.dispatchMouseEvent',{ type:'mousePressed',x:from.x,y:from.y,button:'left',clickCount:1 });
await send('Input.dispatchMouseEvent',{ type:'mouseMoved',x:from.x+8,y:from.y+4,button:'left',buttons:1 });
await send('Input.dispatchMouseEvent',{ type:'mouseMoved',x:from.x+40,y:from.y+10,button:'left',buttons:1 });

const intercepted = await waitFor('Input.dragIntercepted', 4000);
if (!intercepted) {
  console.log('  ✗ Chrome n a pas reconnu un glisser — la ligne n est peut-être pas draggable');
  await send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:from.x,y:from.y,button:'left' });
} else {
  const data = intercepted.data;
  console.log(`  ✓ glisser natif reconnu — ${data.items.length} élément(s), types: ${data.items.map(i=>i.mimeType).join(', ')}`);
  await send('Input.dispatchDragEvent',{ type:'dragEnter',x:to.x,y:to.y,data });
  await send('Input.dispatchDragEvent',{ type:'dragOver',x:to.x,y:to.y,data });
  await shot('drag-over');
  await send('Input.dispatchDragEvent',{ type:'drop',x:to.x,y:to.y,data });
  console.log('  ✓ dépôt envoyé sur le panneau distant');
}

await sleep(4000);
await shot('drag-done');
const landed = await ev(`
  (() => { const panes=[...document.querySelectorAll('div.flex.h-full.flex-col')];
    const right = panes[1] ? panes[1].innerText : '';
    return { rightPane: right.split('\\n').filter(Boolean).slice(0,10),
             transferBanner: /transfer|Uploading|Downloading|%/i.test(document.body.innerText) }; })()`);
console.log('  contenu du panneau droit :', JSON.stringify(landed.rightPane));
console.log('  ' + (landed.rightPane.includes('Documents')
  ? '✓ Documents est arrive a droite'
  : '✗ Documents n est pas arrive a droite'));
chrome.kill(); await sleep(600); try{fs.rmSync(profile,{ recursive:true,force:true });}catch{}
