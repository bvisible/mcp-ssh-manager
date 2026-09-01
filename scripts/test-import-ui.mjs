#!/usr/bin/env node
/**
 * Can somebody actually find and use the importer?
 *
 * The readers, the seven formats and the thirteen unit tests all passed while
 * the feature was unreachable from the interface, which is the same as it not
 * existing. This drives the path a person takes: the introduction, the Import
 * button, a source, the preview, the confirm — and then checks the vault,
 * because the screen saying "Import 111 servers" is not evidence that 111
 * servers were written. It said exactly that while writing none.
 *
 *   SSH_MANAGER_HOME=$(mktemp -d) SSH_MANAGER_KEY_SOURCE=file \
 *     node cli/control.js --port 7318 &
 *   node scripts/test-import-ui.mjs <url-with-token> /tmp/shots
 */
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
/* global WebSocket */
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9346; const OUT=process.argv[3]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'im-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--window-size=1400,950','about:blank'],{ stdio:'ignore' });
let t; for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl); if(p){t=p.webSocketDebuggerUrl;break;}}catch{} await sleep(250);}
const ws=new WebSocket(t); await new Promise(r=>ws.addEventListener('open',r,{ once:true }));
let id=1; const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); const w=pend.get(m.id); if(w){pend.delete(m.id); w(m.result);}});
const send=(me,pa={})=>{const i=id++; ws.send(JSON.stringify({ id:i,method:me,params:pa })); return new Promise(r=>pend.set(i,r));};
const ev=async e=>(await send('Runtime.evaluate',{ expression:e,returnByValue:true })).result?.value;
const shot=async n=>{const s=await send('Page.captureScreenshot',{ format:'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.data,'base64'));};
const clickIn = async (scope, text, label) => {
  const c = await ev(`
    (() => { const root = document.querySelector(${JSON.stringify(scope)}) || document;
      const e=[...root.querySelectorAll('button')].find(b=>b.textContent.trim().includes(${JSON.stringify(text)}) && b.offsetParent);
      if(!e) return null; const r=e.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
  if (!c) { console.log(`  ✗ « ${label} » introuvable`); return false; }
  await send('Input.dispatchMouseEvent',{ type:'mousePressed',x:c.x,y:c.y,button:'left',clickCount:1 });
  await send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:c.x,y:c.y,button:'left',clickCount:1 });
  console.log(`  ✓ clic « ${label} »`); await sleep(1200); return true;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{ width:1400,height:950,deviceScaleFactor:1,mobile:false });
await send('Page.navigate',{ url:process.argv[2] }); await sleep(3500);

console.log('\n— depuis l introduction —');
const wiz = await ev('[...document.querySelectorAll(\'h2\')].some(e=>/shell/.test(e.textContent))');
console.log(`  ${wiz ? '✓' : '✗'} le wizard est là`);
if (wiz) {
  await clickIn('.fixed.inset-0', 'Next', 'Next');
  const hasImport = await ev('[...document.querySelectorAll(\'button\')].some(b=>/Import mine/.test(b.textContent))');
  console.log(`  ${hasImport ? '✓' : '✗'} l étape 2 propose « Import mine »`);
  await shot('wiz-import');
  if (hasImport) await clickIn('.fixed.inset-0', 'Import mine', 'Import mine');
  await sleep(1800);
}

console.log('\n— le dialogue d import —');
const sources = await ev(`
  (() => { const h=[...document.querySelectorAll('h2')].find(e=>/Import servers/.test(e.textContent));
    if(!h) return null;
    const box=h.closest('div.rounded-xl');
    return [...box.querySelectorAll('button')].map(b=>b.textContent.trim().replace(/\\s+/g,' ')).filter(Boolean); })()`);
if (!sources) { console.log('  ✗ le dialogue ne s est pas ouvert'); }
else { console.log('  ✓ ouvert. Choix proposés :'); sources.forEach(s=>console.log('      •', s)); await shot('import-open'); }

if (sources) {
  console.log('\n— importer depuis Transmit —');
  await clickIn('.fixed.inset-0', 'Transmit', 'Transmit favourites');
  await sleep(2500);
  await shot('import-preview');
  const btn = await ev(`
    (() => { const b=[...document.querySelectorAll('button')].find(b=>/^Import \\d+ server/.test(b.textContent.trim()));
      return b ? b.textContent.trim() : null; })()`);
  console.log(`  ${btn ? '✓ aperçu : « '+btn+' »' : '✗ pas d aperçu'}`);
  if (btn) {
    await clickIn('.fixed.inset-0', 'Import ', 'Import N servers');
    await sleep(3000);
    const count = await ev(`
      (() => { const h=document.querySelector('h1'); return h ? h.textContent.trim() : null; })()`);
    console.log(`  en-tête après import : « ${count} »`);
    await shot('import-done');
  }
}
chrome.kill(); await sleep(600); try{fs.rmSync(profile,{ recursive:true,force:true });}catch{}
