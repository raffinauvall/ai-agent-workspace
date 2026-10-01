// Build first: npm run build:mobile-scene. No Android, tunnel or dev server needed.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const executablePath = process.env.OFFICEAI_BROWSER ?? (existsSync('/opt/brave-bin/brave') ? '/opt/brave-bin/brave' : undefined);
const browser = await chromium.launch({executablePath, headless:true});
try {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => {if (request.url().startsWith('http')) requests.push(request.url());});
  await page.addInitScript(() => {
    window.sceneReady = {postMessage:() => window.__ready = true};
    window.sceneError = {postMessage:message => window.__error = message};
    window.agentSelected = {postMessage:id => window.__selected = id};
  });
  await page.goto(pathToFileURL(fileURLToPath(new URL('mobile/assets/office_scene/index.html', root))).href);
  await page.waitForFunction(() => window.__ready || window.__error, null, {timeout:30000});
  assert.equal(await page.evaluate(() => window.__error), undefined);
  const agents = Array.from({length:6}, (_, i) => ({id:`demo-${i}`,name:['Tech freak','Hoodie','Headphones','Streetwear','Cap','Beanie'][i],
    model:'isolated preview',status:i<3?'tool_use':'idle',tokensIn:0,tokensOut:0,tier:'middle',role:'developer',subAgents:[],
    lastActivity:new Date().toISOString(),startedAt:new Date().toISOString(),source:'cli'}));
  await page.evaluate(states => window.syncAgents(states), agents);
  await page.waitForFunction(() => window.officeSceneDiagnostics().drawCalls > 0);
  await page.evaluate(() => window.pauseOfficeScene(true));
  const before = await page.evaluate(() => window.officeSceneDiagnostics());
  assert.equal(before.riggedAvatars, 6); assert.equal(before.avatarError, null);
  assert(before.drawCalls < 400, `draw calls: ${before.drawCalls}`);
  await page.screenshot({path:fileURLToPath(new URL('images/office-3d.png', root))});
  await page.setViewportSize({width:390,height:700});
  await page.evaluate(() => {window.focusOfficeAgent('demo-1'); window.pauseOfficeScene(false);});
  await page.waitForTimeout(400);
  let target = await page.evaluate(() => {window.pauseOfficeScene(true);return window.officeSceneDiagnostics().targets.find(t => t.id === 'demo-1');});
  await page.mouse.click(target.x, target.y);
  assert.equal(await page.evaluate(() => window.__selected), 'demo-1');
  await page.evaluate(() => window.__selected = null);
  await page.mouse.move(target.x,target.y); await page.mouse.down();
  await page.mouse.move(target.x+90,target.y+20,{steps:8}); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__selected), null, 'Orbit gesture must not select an agent');
  for(let i=0;i<4;i++) {
    await page.evaluate(states => {window.syncAgents([]); window.syncAgents(states); window.pauseOfficeScene(false);}, agents);
    await page.waitForTimeout(100);
  }
  const after = await page.evaluate(() => {window.pauseOfficeScene(true);return window.officeSceneDiagnostics();});
  assert(after.geometries <= before.geometries + 15, `geometry leak: ${before.geometries} -> ${after.geometries}`);
  assert.deepEqual(errors, []); assert.deepEqual(requests, [], 'Local scene must work without HTTP asset requests');
  console.log(JSON.stringify({offline:true,riggedAvatars:after.riggedAvatars,drawCalls:after.drawCalls,geometries:after.geometries,selection:true,orbitDoesNotSelect:true,errors},null,2));
} finally {await browser.close();}
