#!/usr/bin/env node
/**
 * What somebody sees the first time, driven by mouse.
 *
 * Needs a control plane with an empty vault, which is the whole point — the
 * introduction only appears when there is nothing configured:
 *
 *   SSH_MANAGER_HOME=$(mktemp -d) SSH_MANAGER_KEY_SOURCE=file \
 *     node cli/control.js --port 7316 &
 *   node scripts/test-first-run.mjs <url-with-token> /tmp/shots
 *
 * Clicks are scoped to the modal when one is up. The page behind it has its own
 * "Add a server" button, it comes first in the DOM, and clicking that instead
 * reports three failures that are all the test's fault — which is exactly what
 * happened the first time this ran.
 */
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
/* global WebSocket */
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9345; const OUT=process.argv[3]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'wz-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--window-size=1400,900','about:blank'],{ stdio:'ignore' });
let t; for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl); if(p){t=p.webSocketDebuggerUrl;break;}}catch{} await sleep(250);}
const ws=new WebSocket(t); await new Promise(r=>ws.addEventListener('open',r,{ once:true }));
let id=1; const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); const w=pend.get(m.id); if(w){pend.delete(m.id); w(m.result);}});
const send=(me,pa={})=>{const i=id++; ws.send(JSON.stringify({ id:i,method:me,params:pa })); return new Promise(r=>pend.set(i,r));};
const ev=async e=>(await send('Runtime.evaluate',{ expression:e,returnByValue:true })).result?.value;
const shot=async n=>{const s=await send('Page.captureScreenshot',{ format:'png' });
  fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(s.data,'base64'));};
// Scoped to the modal when one is up: the page behind it has its own
// "Add a server", it comes first in the DOM, and clicking that instead is a
// test failure dressed up as a product failure.
const centre = async (text, scope) => ev(`
  (() => { const root = ${scope ? JSON.stringify(scope) : 'null'}
      ? document.querySelector(${scope ? JSON.stringify(scope) : '\'body\''}) : document;
    if (!root) return null;
    const e=[...root.querySelectorAll('button')]
      .find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent);
    if(!e) return null; const r=e.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
const click = async (text, label, scope) => {
  const c = await centre(text, scope);
  if (!c) { console.log(`  ✗ ${label} introuvable`); return false; }
  await send('Input.dispatchMouseEvent',{ type:'mousePressed',x:c.x,y:c.y,button:'left',clickCount:1 });
  await send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:c.x,y:c.y,button:'left',clickCount:1 });
  console.log(`  ✓ clic « ${label} »`); await sleep(700); return true;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride',{ width:1400,height:900,deviceScaleFactor:1,mobile:false });
await send('Page.navigate',{ url:process.argv[2] }); await sleep(3500);

console.log('\n— le wizard s affiche-t-il sur un coffre vide ? —');
const step1 = await ev(`
  (() => { const h=[...document.querySelectorAll('h2')].find(e=>/shell|watch|Decide/.test(e.textContent));
    return h ? h.textContent.trim() : null; })()`);
console.log(step1 ? `  ✓ « ${step1} »` : '  ✗ pas de wizard');
if (step1) {
  await shot('wizard-1');
  await click('Next', 'Next', '.fixed.inset-0');
  console.log('   →', await ev('document.querySelector(\'h2\').textContent.trim()'));
  await click('Next', 'Next', '.fixed.inset-0');
  const s3 = await ev('document.querySelector(\'h2\').textContent.trim()');
  console.log('   →', s3);
  await shot('wizard-3');
  await click('Add a server', 'Add a server (dans le wizard)', '.fixed.inset-0');
  const onServers = await ev('document.body.innerText.includes(\'Add your first server\') || document.body.innerText.includes(\'Servers\')');
  console.log(`  ${onServers ? '✓' : '✗'} il mène bien à l écran Servers`);
  const gone = await ev('![...document.querySelectorAll(\'h2\')].some(e=>/shell|Decide/.test(e.textContent))');
  console.log(`  ${gone ? '✓' : '✗'} le wizard s est fermé`);
  await send('Page.navigate',{ url:process.argv[2] }); await sleep(3200);
  const again = await ev('[...document.querySelectorAll(\'h2\')].some(e=>/shell|Decide/.test(e.textContent))');
  console.log(`  ${again ? '✗ il revient — il ne devrait pas' : '✓ il ne revient pas au rechargement'}`);
}

console.log('\n— Waiting mène-t-il quelque part ? —');
await ev('document.querySelector(\'button[aria-label="Waiting"]\').click()'); await sleep(1200);
await shot('waiting-empty');
const hasAction = await ev('[...document.querySelectorAll(\'button\')].some(b=>/Set it up on a server/.test(b.textContent))');
console.log(`  ${hasAction ? '✓' : '✗'} le bouton « Set it up on a server » est là`);
if (hasAction) {
  await click('Set it up on a server', 'Set it up on a server');
  const landed = await ev('document.body.innerText.includes(\'Add a server\')');
  console.log(`  ${landed ? '✓' : '✗'} il ouvre l écran Servers`);
}
chrome.kill(); await sleep(600); try{fs.rmSync(profile,{ recursive:true,force:true });}catch{}
