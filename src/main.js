/* ============================== [MAIN] ==============================
   Input handling, the main loop, boot/deploy wiring, and the window.HVH
   debug/test surface.  This module imports everything and ties it together. */
import * as THREE from 'three';
import { scene, camera, renderer } from './core.js';
import { WEAPONS, TEAM, INACC, LAND_RECOVER, JUMP_VEL, BHOP_GAIN, BHOP_MAX, ECON, computeDamage } from './data.js';
import { agents, refs, GAME, vm, clock, keys, input } from './state.js';
import { WALLS, NODES, EDGES, segAABB, losClear, penetrate, clearWorld } from './world.js';
import { updateEffects, nadeProjectiles, shotLines } from './effects.js';
import { setViewmodel, updateAgentVisual, updateBacktrackGhosts, hitboxCenter, eyePos, updateViewmodel } from './agents.js';
import { manualFire, aimbotFire, canShoot, fireWeaponCommon, fireDoubleTap, meleeAttack, moveAgent, computeBloom, startReload, finishReload, switchTo, selectBest, visibleTo, autoStopScale, autoStopNow, baseMoveSpeed, recordTick, updateTickbase, beginSimFrame, applyFakeDuck } from './combat.js';
import { botThink } from './ai.js';
import { verifyCheats } from './selftest.js';
import {
  openBuy, closeBuy, beginBuyToLive, awardWin, endRoundAdvance, startRound, buildTeams,
  updateHostages, updateNades, updateAreas, tryRescueInteract, equipGrenade, throwNade, liveHostages,
} from './game.js';
import {
  updateAllHUD, updateTopHUD, updatePlayerHUD, updateTeamStatus, updateHUDWeapons, drawRadar,
  updateESP, updateReloadRing, updateBloomRing, updateHitChanceHUD, updateScopeOverlay, updateR8Hammer,
  renderScoreboard, centerMessage, showHint, showHintOnce, formatTime, buildCrosshair, anyPanelOpen, audio, setBeepMute, playBeep,
} from './hud.js';
import { toggleCheatMenu, buildCheatMenu, loadConfig, saveConfig, syncCheatUI, syncWeaponSel, optimizedCheats } from './cheats.js';
import { buildDefaultMap } from './map.js';
import { loadSourceMap } from './sourcemap_load.js';
import { meshBackend } from './sourcemap.js';
import { setListener, sfxScope, unlockAudio, sfxRevolverCock, setSfxMute } from './sfx.js';
import { toggleEditor, isEditorOpen, editorUpdate, editorRender, editorKey, loadPatches, editorDebug } from './editor.js';
import { preloadModels, MODELS, ASSET_V } from './models.js';
import { applyNightMode } from './visuals.js';
import { initMenu, menuReady, menuVisible, renderMenu } from './menu.js';
import { buildPracticeMap, markPracticeAgents, practiceThink, updatePractice } from './practice.js';
import { defaultCheats } from './agents.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './mobile.js';   // <-- ADDED: touch controls — self-installs on touch devices only, no-op on desktop

const $ = s => document.querySelector(s);

// spectator camera: lock onto a player (first/third person) or free-fly (Space toggles)
const spec = { free: false, target: null, tp: false, pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
function specAliveList() { return agents.filter(a => a.alive); }
function cycleSpec(dir) { const l = specAliveList(); if (!l.length) { spec.target = null; return; } let i = l.indexOf(spec.target); i = (i < 0 ? 0 : i + dir); spec.target = l[((i % l.length) + l.length) % l.length]; }
function ensureSpec() { if (!spec.target || !spec.target.alive) cycleSpec(1); }
function specUpdate() {
  if (!spec.free) { ensureSpec(); return; }
  const sp = (keys["ShiftLeft"] ? 18 : 8), cp = Math.cos(spec.pitch);
  const fwd = new THREE.Vector3(-Math.sin(spec.yaw) * cp, Math.sin(spec.pitch), -Math.cos(spec.yaw) * cp);
  const right = new THREE.Vector3(Math.cos(spec.yaw), 0, -Math.sin(spec.yaw));
  if (keys["KeyW"]) spec.pos.addScaledVector(fwd, sp);
  if (keys["KeyS"]) spec.pos.addScaledVector(fwd, -sp);
  if (keys["KeyA"]) spec.pos.addScaledVector(right, -sp);
  if (keys["KeyD"]) spec.pos.addScaledVector(right, sp);
}
let _specBanner = null;
function updateSpecBanner() {
  if (!_specBanner) { _specBanner = document.createElement('div'); _specBanner.id = 'specBanner'; _specBanner.style.cssText = 'position:fixed;left:0;right:0;bottom:84px;text-align:center;font:bold 17px "Trebuchet MS",sans-serif;color:#fff;text-shadow:0 2px 6px #000,0 0 2px #000;pointer-events:none;z-index:50;'; document.body.appendChild(_specBanner); }
  const h = refs.human;
  if (h && !h.alive && GAME.phase !== "warmup") {
    if (spec.free) _specBanner.innerHTML = '<span style="opacity:.85">◉ FREE CAMERA</span> &nbsp;·&nbsp; <span style="font-weight:normal;opacity:.7">WASD fly · Space to lock onto a player</span>';
    else if (spec.target) _specBanner.innerHTML = 'Spectating <span style="color:' + (spec.target.team === TEAM.CT ? '#7fb4ff' : '#ffb46a') + '">' + spec.target.name + '</span>' + (spec.tp ? ' <span style="opacity:.7">(3rd person)</span>' : '') + ' &nbsp;<span style="font-weight:normal;opacity:.6">click=switch · V=3rd person · Space=free cam</span>';
    else _specBanner.textContent = '';
    _specBanner.style.display = 'block';
  } else _specBanner.style.display = 'none';
}

/* ============================== admin-gated map editor ============================== */
const ADMIN_PW = "neo8755";   // change this to your own password
let adminUnlocked = false;
function adminLogin() {
  if (document.getElementById("adminLogin")) return;
  document.exitPointerLock();
  const ov = document.createElement("div"); ov.id = "adminLogin";
  ov.style.cssText = "position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;";
  ov.innerHTML = '<div style="background:#161b24;border:1px solid #2a3340;border-radius:10px;padding:22px 26px;text-align:center;font:14px \'Trebuchet MS\',sans-serif;color:#cfd6e2;min-width:240px;">'
    + '<div style="font-weight:bold;color:#ffd54a;margin-bottom:12px;">🔒 Admin login</div>'
    + '<input id="admPw" type="password" placeholder="password" autocomplete="off" style="padding:7px 10px;border-radius:6px;border:1px solid #3a4452;background:#0e131b;color:#e6ecf5;outline:none;width:200px;">'
    + '<div style="margin-top:12px;"><button id="admGo" style="padding:6px 16px;cursor:pointer;">Enter</button> <button id="admX" style="padding:6px 16px;cursor:pointer;">Cancel</button></div>'
    + '<div id="admErr" style="color:#ff6464;margin-top:8px;height:14px;font-size:12px;"></div></div>';
  document.body.appendChild(ov);
  const pw = ov.querySelector("#admPw"), err = ov.querySelector("#admErr"); pw.focus();
  const close = () => ov.remove();
  const submit = () => { if (pw.value === ADMIN_PW) { adminUnlocked = true; close(); toggleEditor(); } else { err.textContent = "Wrong password"; pw.value = ""; } };
  ov.querySelector("#admGo").onclick = submit; ov.querySelector("#admX").onclick = close;
  pw.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.code === "Enter") submit(); else if (ev.code === "Escape") close(); });
}

/* ============================== input ============================== */
addEventListener('keydown', e => {
  if (e.code === "Backquote") { if (adminUnlocked) toggleEditor(); else adminLogin(); e.preventDefault(); return; }
  if (isEditorOpen()) { keys[e.code] = true; editorKey(e.code); e.preventDefault(); return; }
  if (e.code === "KeyI" && GAME.phase !== "editor") { if (!GAME.injected) { showHint("No cheat loaded — INJECT it from the main menu first"); e.preventDefault(); return; } toggleCheatMenu(); e.preventDefault(); return; }
  if (GAME.phase === "warmup" || GAME.phase === "editor") return;
  if (e.code === "Escape") { togglePause(); e.preventDefault(); return; }
  const human = refs.human;
  keys[e.code] = true;
  if (e.code === "KeyB") { const p = $("#buyPanel"); p.classList.contains("show") ? closeBuy() : openBuy(); }
  if (e.code === "Tab") { $("#sbPanel").classList.add("show"); renderScoreboard(); e.preventDefault(); }
  if (e.code === "Digit1") { human.equippedNade = null; if (human.slotPrimary) switchTo(human, human.slotPrimary); }
  if (e.code === "Digit2") { human.equippedNade = null; if (human.slotSecondary) switchTo(human, human.slotSecondary); }
  if (e.code === "Digit3") { human.equippedNade = null; switchTo(human, 'knife'); }
  if (/^Digit[123]$/.test(e.code)) syncWeaponSel();
  if (e.code === "Digit4" || e.code === "KeyG") { equipGrenade(); }
  {
    const aaK = human.cheats.antiaim || {};
    if (aaK.fakeduck && aaK.fakeduckMode === "toggle" && e.code === (aaK.fakeduckKey || "KeyX") && !e.repeat) {
      human._fdToggle = !human._fdToggle;
      showHint("Fake duck " + (human._fdToggle ? "ON — you are ducked" : "OFF"));
    }
  }
  if (e.code === "KeyR") { startReload(human); }
  if (e.code === "KeyE") { tryRescueInteract(human); }
  if (e.code === "KeyV") {
    if (human.alive) { GAME.thirdPerson = !GAME.thirdPerson; showHint("Third person " + (GAME.thirdPerson ? "ON" : "OFF")); }
    else { spec.tp = !spec.tp; showHint("Spectator " + (spec.tp ? "third" : "first") + " person"); }
  }
  if (e.code === "Space" && !human.alive && !e.repeat) {
    spec.free = !spec.free;
    if (spec.free) { spec.pos.copy(camera.position); const t = spec.target; if (t) { spec.yaw = t.yaw; spec.pitch = t.pitch; } }
    showHint(spec.free ? "Free cam — WASD/Shift to fly, mouse to look, Space to lock onto a player" : "Locked — click to switch player, V for third person");
  }
  const c = human.cheats;
  if (e.code === "F1") { c.aimbot.on = !c.aimbot.on; showHint("Aimbot " + (c.aimbot.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F2") { c.aimbot.forceBody = !c.aimbot.forceBody; showHint("Force baim " + (c.aimbot.forceBody ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F3") { c.aimbot.autoShoot = !c.aimbot.autoShoot; showHint("Triggerbot " + (c.aimbot.autoShoot ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F4") { c.autowall.on = !c.autowall.on; showHint("Autowall " + (c.autowall.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F5") { c.antiaim.on = !c.antiaim.on; showHint("Anti-aim " + (c.antiaim.on ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F6") { c.aimbot.autoStop = !c.aimbot.autoStop; showHint("Auto stop " + (c.aimbot.autoStop ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F7") { c.visuals.esp = !c.visuals.esp; showHint("ESP " + (c.visuals.esp ? "ON" : "OFF")); syncCheatUI(); }
  if (e.code === "F8") { c.visuals.chams = !c.visuals.chams; showHint("Chams " + (c.visuals.chams ? "ON" : "OFF")); syncCheatUI(); }
  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "KeyC", "Tab"].includes(e.code)) e.preventDefault();
  if (e.ctrlKey) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === "Tab") $("#sbPanel").classList.remove("show"); });

renderer.domElement.addEventListener('mousedown', e => { if (isEditorOpen()) return; if (e.button === 0) { input.mouseDown = true; if (refs.human && refs.human.cur === "r8") refs.human.fireMode = "primary"; } if (e.button === 2) { input.rmbDown = true; onRMB(); } });
addEventListener('mouseup', e => { if (isEditorOpen()) return; if (e.button === 0) input.mouseDown = false; if (e.button === 2) input.rmbDown = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (isEditorOpen() || document.pointerLockElement !== renderer.domElement || !refs.human) return;
  const sens = 0.0022;
  if (refs.human.alive) { refs.human.yaw -= e.movementX * sens; refs.human.pitch = THREE.MathUtils.clamp(refs.human.pitch - e.movementY * sens, -1.5, 1.5); }
  else if (spec.free) { spec.yaw -= e.movementX * sens; spec.pitch = THREE.MathUtils.clamp(spec.pitch - e.movementY * sens, -1.5, 1.5); }
});
function onRMB() {
  const human = refs.human; if (!human.alive) return;
  const w = WEAPONS[human.cur];
  if (w.scope) { human.scoped = !human.scoped; sfxScope(); }
  else if (human.cur === "glock") { human.glockBurst = !human.glockBurst; showHint("Glock " + (human.glockBurst ? "burst" : "semi")); }
  else if (human.cur === "r8") human.fireMode = "fan";
}
renderer.domElement.addEventListener('click', () => {
  unlockAudio();
  if (isEditorOpen()) return;
  if (GAME.phase === "warmup" || GAME.phase === "editor" || anyPanelOpen()) return;
  if (refs.human && !refs.human.alive && !spec.free) cycleSpec(1);
  renderer.domElement.requestPointerLock();   // no-ops on touch (see mobile.js)
});

/* ============================== human control ============================== */
function humanMove(dt) {
  const human = refs.human;
  human.crouch = !!keys["KeyC"];
  const aaH = human.cheats.antiaim || {};
  human._fdActive = (aaH.fakeduckMode === "toggle") ? !!human._fdToggle : !!keys[aaH.fakeduckKey || "KeyX"];
  applyFakeDuck(human);
  human.walk = !!keys["ShiftLeft"];
  let f = 0, s = 0; if (keys["KeyW"]) f++; if (keys["KeyS"]) f--; if (keys["KeyA"]) s--; if (keys["KeyD"]) s++;
  const fwd = new THREE.Vector3(-Math.sin(human.yaw), 0, -Math.cos(human.yaw));
  const right = new THREE.Vector3(Math.cos(human.yaw), 0, -Math.sin(human.yaw));
  const dir = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
  if (keys["Space"] && human.onGround) {
    human.vel.y = JUMP_VEL;
    human.bhopBoost = human._landedThisFrame ? Math.min(BHOP_MAX, (human.bhopBoost || 1) + BHOP_GAIN) : Math.max(1, human.bhopBoost || 1);
  }
  if (human.onGround && !keys["Space"]) human.bhopBoost = 1;
  if (human.crouch) human.bhopBoost = 1;
  human.realYaw = human.yaw;
  human.speedScale = 1;
  const c = human.cheats;
  if (c.aimbot.autoStop && human.onGround) {
    const w = WEAPONS[human.cur];
    const fireReady = human.fireCd <= 0;
    if (fireReady && (c.aimbot.autoShoot || input.mouseDown) && autoStopNow(human)) human.speedScale = 0;
  }
  moveAgent(human, dir, dt, false);
}

function humanShoot(dt) {
  const human = refs.human;
  if (!human.alive) return;
  const md = input.mouseDown, rmb = input.rmbDown;
  if (human.equippedNade) {
    if (md && human.fireCd <= 0) {
      const key = human.equippedNade;
      if (throwNade(human, key)) {
        human.fireCd = 0.8; input.mouseDown = false;
        human.equippedNade = human.nades[key] > 0 ? key : null;
        if (!human.equippedNade) { selectBest(human); setViewmodel(human.cur, false); } else setViewmodel(human.equippedNade, true);
        updateHUDWeapons();
      }
    }
    return;
  }
  if (WEAPONS[human.cur] && WEAPONS[human.cur].melee) {
    const c2 = human.cheats;
    if (c2.aimbot.on && c2.aimbot.autoKnife) { if (human.fireCd <= 0) meleeAttack(human, false, true); return; }
    if (human.fireCd <= 0) { if (md) meleeAttack(human, false); else if (rmb) meleeAttack(human, true); }
    return;
  }
  if (human.cur === "r8" && human.reloadT <= 0) {
    const wp8 = human.weapons.r8; if (!wp8) return; const c8 = human.cheats; const COCK = WEAPONS.r8.cockTime || 0.25;
    if (rmb) {
      human.r8Charge = 0;
      if (human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "fan"; sfxRevolverCock(); fireWeaponCommon(human); manualFire(human); updateHUDWeapons(); }
      return;
    }
    if (c8.aimbot.on && c8.aimbot.autoRevolver) {
      const AUTO_COCK = 0.25;
      human.r8Charge = (human.r8Charge || 0) + dt / AUTO_COCK;
      while (human.r8Charge >= 1) {
        human.r8Charge -= 1;
        sfxRevolverCock();
        if (wp8.ammo <= 0) { startReload(human); human.r8Charge = 0; break; }
        human.fireMode = "primary";
        if (aimbotFire(human)) human.fireCd = 0;
      }
      updateHUDWeapons();
      return;
    }
    if (c8.aimbot.on) {
      if (md || c8.aimbot.autoShoot) {
        human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
        if (human.r8Charge >= 0.95 && !human.r8Cocked) { human.r8Cocked = true; sfxRevolverCock(); }
        if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); return; } human.fireMode = "primary"; if (aimbotFire(human)) { human.r8Charge = 0; human.r8Cocked = false; } updateHUDWeapons(); }
      } else { human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2); human.r8Cocked = false; }
      return;
    }
    if (md) {
      human.r8Charge = Math.min(1, (human.r8Charge || 0) + dt / COCK);
      if (human.r8Charge >= 0.95 && !human.r8Cocked) { human.r8Cocked = true; sfxRevolverCock(); }
      if (human.r8Charge >= 1 && human.fireCd <= 0) { if (wp8.ammo <= 0) { startReload(human); human.r8Charge = 0; human.r8Cocked = false; return; } human.fireMode = "primary"; fireWeaponCommon(human); manualFire(human); human.r8Charge = 0; human.r8Cocked = false; updateHUDWeapons(); }
    } else { human.r8Charge = Math.max(0, (human.r8Charge || 0) - dt / COCK * 2); human.r8Cocked = false; }
    return;
  }
  if (human.fireCd > 0 || human.reloadT > 0) return;
  const wp = human.weapons[human.cur]; if (!wp) return;
  const c = human.cheats;
  if (c.aimbot.on && (md || c.aimbot.autoShoot)) {
    if (wp.ammo <= 0) { startReload(human); return; }
    if (aimbotFire(human)) { updateHUDWeapons(); return; }
    if (canShoot(human).have) return;
  }
  const r8fan = human.cur === "r8" && rmb;
  const glockBurst = human.cur === "glock" && human.glockBurst;
  if (md || r8fan || (glockBurst && human.burstQ > 0)) {
    if (wp.ammo <= 0) { startReload(human); return; }
    human.fireMode = r8fan ? "fan" : "primary";
    fireWeaponCommon(human); manualFire(human);
    fireDoubleTap(human, () => manualFire(human));
    if (glockBurst) {
      human.burstQ = human.burstQ > 0 ? human.burstQ - 1 : 2;
      human.fireCd = human.burstQ > 0 ? 0.07 : 0.4;
      input.mouseDown = false;
    } else if (!WEAPONS[human.cur].auto && !r8fan) input.mouseDown = false;
    updateHUDWeapons();
  }
}

/* ============================== main loop ============================== */
let last = performance.now();
const ff = { accum: 0, banner: null, RATE: 2.5 };
function ffShouldRun() { const h = refs.human; return GAME.phase === "live" && !GAME.practice && h && !h.alive; }
function updateFFBanner() {
  if (!ff.banner) {
    ff.banner = document.createElement('div'); ff.banner.id = 'ffBanner';
    ff.banner.style.cssText = 'position:fixed;left:0;right:0;bottom:128px;text-align:center;font:bold 15px "Trebuchet MS",sans-serif;color:#ffd86b;text-shadow:0 2px 6px #000;letter-spacing:.4px;pointer-events:none;z-index:50;';
    ff.banner.textContent = '⏩ FAST-FORWARD 2.5× — simulating the round (all players dead)';
    document.body.appendChild(ff.banner);
  }
  ff.banner.style.display = ffShouldRun() ? 'block' : 'none';
}
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min(0.05, (now - last) / 1000); last = now; clock.t += dt;
  if (GAME.phase !== "warmup" && GAME.phase !== "editor") {
    step(dt);
    if (ffShouldRun()) {
      ff.accum += (ff.RATE - 1);
      setSfxMute(true); setBeepMute(true);
      try { while (ff.accum >= 1 && ffShouldRun()) { step(dt, true); ff.accum -= 1; } }
      finally { setSfxMute(false); setBeepMute(false); }
      if (GAME.phase === "end" && GAME.winner != null) playBeep(GAME.winner === GAME.humanTeam ? 660 : 200, 0.25);
    } else ff.accum = 0;
  } else if (isEditorOpen()) editorUpdate();
  updateFFBanner();
  if (GAME.phase === "warmup" && menuVisible()) renderMenu(); else render();
}
export function step(dt, extra) {
  beginSimFrame();
  if (GAME.phase === "buy") { GAME.freeze -= dt; if (GAME.freeze <= 0) beginBuyToLive(); }
  else if (GAME.phase === "live") { GAME.timer -= dt; if (GAME.timer <= 0) awardWin(TEAM.T, "time"); }
  else if (GAME.phase === "end") { GAME.timer -= dt; if (GAME.timer <= 0) endRoundAdvance(); }
  if (GAME.buyTimer > 0 && (GAME.phase === "buy" || GAME.phase === "live")) { GAME.buyTimer -= dt; if (GAME.buyTimer <= 0 && $("#buyPanel").classList.contains("show")) closeBuy(); }

  for (const a of agents) {
    if (a.fireCd > 0) a.fireCd -= dt;
    if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
    if (a.flashT > 0) a.flashT -= dt;
    if (a.firePenalty > 0) { const I = INACC[a.cur]; const rec = I ? (a.crouch ? I.recov * 0.7 : I.recov) : 0.35; a.firePenalty *= Math.pow(0.5, dt / rec); if (a.firePenalty < 0.05) a.firePenalty = 0; }
    if (a.hurtBloom > 0) { a.hurtBloom *= Math.pow(0.5, dt / 0.18); if (a.hurtBloom < 0.05) a.hurtBloom = 0; }
    if (a.landBloom > 0) { a.landBloom = Math.max(0, a.landBloom - LAND_RECOVER * dt); }
    updateTickbase(a, dt);
    if (a.alive && a.reloadT <= 0 && a.cur && a.weapons[a.cur] && a.weapons[a.cur].ammo <= 0 && a.weapons[a.cur].reserve > 0 && !(a.isHuman && a.equippedNade)) startReload(a);
  }

  const human = refs.human;
  if (!extra) {
    if (human.alive && GAME.phase !== "end") {
      humanMove(dt);
      if (GAME.phase === "live") humanShoot(dt);
    } else if (!human.alive) specUpdate();
  }
  const canAct = GAME.phase === "live";
  for (const a of agents) {
    if (a.isHuman) continue;
    if (GAME.phase === "buy") a.body.g.position.copy(a.pos);
    else if (canAct) { if (GAME.practice && a.room) practiceThink(a, dt); else botThink(a, dt); }
  }
  for (const a of agents) recordTick(a, dt);
  updateHostages(dt); updateNades(dt); updateAreas(dt); updateEffects(dt); updatePractice(dt);
  for (const a of agents) updateAgentVisual(a);
  updateBacktrackGhosts(dt);
  updateESP(); updateReloadRing(); updateBloomRing(); updateHitChanceHUD(); updateScopeOverlay(); updateR8Hammer(); updateViewmodel(); applyNightMode(refs.human && refs.human.cheats.visuals); updateSpecBanner();
  updateCamera();
  updateTopHUD(); updatePlayerHUD(); updateTeamStatus(); updateHUDWeapons();
  $("#roundTimer").textContent = formatTime(GAME.phase === "buy" ? GAME.freeze : GAME.timer);
  $("#phaseBanner").textContent = GAME.phase === "buy" ? "BUY" : (GAME.phase === "end" ? "ROUND OVER" : "");
  if (human.alive && human.team === TEAM.CT && !human.carrying) { for (const h of liveHostages()) { if (human.pos.distanceTo(h.pos) < 70) { showHintOnce("Press E to grab hostage"); break; } } }
  drawRadar();
}
function updateCamera() {
  const human = refs.human;
  if (human.alive) {
    vm._specKey = null;
    if (GAME.practice) spec.free = false;
    setListener(human.pos.x, human.eye, human.pos.z, human.yaw, human);
    const scopedNow = human.scoped && WEAPONS[human.cur] && WEAPONS[human.cur].scope;
    const tp = GAME.thirdPerson;
    const fov = (scopedNow && !tp) ? 40 : (human.cheats.visuals.fov || 74);
    if (Math.abs(camera.fov - fov) > 0.5) { camera.fov += (fov - camera.fov) * 0.4; camera.updateProjectionMatrix(); }
    if (tp) {
      const dist = 150, ex = human.pos.x, ey = human.eye, ez = human.pos.z;
      const cp = Math.cos(human.pitch);
      let ux = Math.sin(human.yaw) * cp, uy = -Math.sin(human.pitch) + 0.18, uz = Math.cos(human.yaw) * cp;
      const vl = Math.hypot(ux, uy, uz); ux /= vl; uy /= vl; uz /= vl;
      let allow = dist;
      if (meshBackend.active && meshBackend.bvh) {
        const h = meshBackend.bvh.raycast(ex, ey, ez, ux, uy, uz, dist); if (h) allow = Math.max(18, h.t - 12);
      } else {
        const o = new THREE.Vector3(ex, ey, ez), d = new THREE.Vector3(ux, uy, uz);
        for (const wl of WALLS) { if (!wl.block) continue; const r = segAABB(o, d, dist, wl); if (r && r.enter > 1 && r.enter < allow) allow = Math.max(18, r.enter - 12); }
      }
      camera.position.set(ex + ux * allow, ey + uy * allow, ez + uz * allow);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = false;
    } else {
      camera.position.set(human.pos.x, human.eye, human.pos.z);
      camera.rotation.set(human.pitch, human.yaw, 0, 'YXZ');
      if (vm.current) vm.current.visible = !scopedNow;
    }
  } else {
    if (vm.current) vm.current.visible = false;
    if (Math.abs(camera.fov - 74) > 0.5) { camera.fov = 74; camera.updateProjectionMatrix(); }
    if (GAME.practice && !spec.free) { spec.free = true; spec.pos.copy(camera.position); spec.yaw = human.yaw; spec.pitch = human.pitch; }
    if (spec.free) {
      setListener(spec.pos.x, spec.pos.y, spec.pos.z, spec.yaw, null);
      camera.position.copy(spec.pos); camera.rotation.set(spec.pitch, spec.yaw, 0, 'YXZ');
    } else {
      ensureSpec(); const t = spec.target;
      if (t) {
        setListener(t.pos.x, t.eye, t.pos.z, t.yaw, t);
        t.body.g.visible = spec.tp;
        if (spec.tp) {
          const dist = 150, ex = t.pos.x, ey = t.eye, ez = t.pos.z, cp = Math.cos(t.pitch);
          let ux = Math.sin(t.yaw) * cp, uy = -Math.sin(t.pitch) + 0.18, uz = Math.cos(t.yaw) * cp; const vl = Math.hypot(ux, uy, uz); ux /= vl; uy /= vl; uz /= vl;
          let allow = dist; if (meshBackend.active && meshBackend.bvh) { const h = meshBackend.bvh.raycast(ex, ey, ez, ux, uy, uz, dist); if (h) allow = Math.max(18, h.t - 12); }
          camera.position.set(ex + ux * allow, ey + uy * allow, ez + uz * allow); camera.rotation.set(t.pitch, t.yaw, 0, 'YXZ');
        } else {
          camera.position.set(t.pos.x, t.eye, t.pos.z); camera.rotation.set(t.pitch, t.yaw, 0, 'YXZ');
          const wkey = t.equippedNade || t.cur;
          if (wkey && wkey !== vm._specKey) { setViewmodel(t.equippedNade || t.cur, !!t.equippedNade); vm._specKey = wkey; }
          const scopedT = t.scoped && WEAPONS[t.cur] && WEAPONS[t.cur].scope;
          if (vm.current) vm.current.visible = !scopedT;
        }
      }
    }
  }
}
function render() { if (isEditorOpen()) { editorRender(); return; } renderer.render(scene, camera); }

/* ============================== boot / deploy ============================== */
function assignHumanTeam() { const pick = GAME.humanTeamPick; const ct = pick === "CT" ? true : pick === "T" ? false : Math.random() < 0.5; GAME.humanTeam = ct ? TEAM.CT : TEAM.T; GAME.ctIsHuman = ct; }
function applyCheatState() { if (GAME.injected) { if (!loadConfig()) refs.human.cheats = optimizedCheats(); } else refs.human.cheats = defaultCheats(false); buildCheatMenu(); }
function deploy() {
  $("#startPanel").classList.remove("show"); document.body.classList.remove("menu");
  GAME.customMap = null; GAME.sourceMap = null;
  GAME.phase = "idle";
  buildDefaultMap();
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  assignHumanTeam();
  buildTeams();
  applyCheatState();
  startRound();
  renderer.domElement.requestPointerLock();   // no-op on touch (mobile.js monkey-patch)
  audio();
}

function deploySource(glb, spawns, texturedScene, nav) {
  $("#startPanel").classList.remove("show"); document.body.classList.remove("menu");
  GAME.customMap = null; GAME.sourceMap = spawns.name || "imported"; GAME.phase = "idle";
  const info = loadSourceMap(glb, spawns, texturedScene, nav);
  loadPatches(GAME.sourceMap, texturedScene);
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  assignHumanTeam();
  buildTeams(); applyCheatState(); startRound();
  renderer.domElement.requestPointerLock(); audio();
  showHint(`Imported ${GAME.sourceMap}: ${info.triangles | 0} tris · ${info.navNodes} nav nodes`);
  return info;
}
function deployPractice() {
  $("#startPanel").classList.remove("show"); document.body.classList.remove("menu");
  buildPracticeMap();
  GAME.customMap = null; GAME.sourceMap = "aim_practice"; GAME.phase = "idle"; GAME.practice = true;
  GAME.round = 1; GAME.half = 1; GAME.scoreCT = 0; GAME.scoreT = 0; GAME.lossStreak = { CT: 0, T: 0 };
  GAME.humanTeamPick = "CT"; assignHumanTeam();
  buildTeams(); markPracticeAgents(); applyCheatState(); startRound();
  renderer.domElement.requestPointerLock(); audio();
  showHint("aim_practice — targets respawn · B buys anything · the guard at the end of the lane shoots back");
}
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  if (GAME.phase === "warmup" || GAME.phase === "editor" || GAME.phase === "idle") return;
  if (anyPanelOpen() || $("#sbPanel").classList.contains("show") || document.getElementById("adminLogin")) return;
  if (window.__MOBILE__) return;   // touch devices never enter pointer lock — don't treat "no lock" as Esc
  togglePause(true);
});
function togglePause(force) {
  const p = $("#pausePanel"); const show = force !== undefined ? force : !p.classList.contains("show");
  p.classList.toggle("show", show);
  if (show) document.exitPointerLock(); else if (!anyPanelOpen()) renderer.domElement.requestPointerLock();
}
function returnToMenu() {
  togglePause(false); closeBuy(); $("#cheatPanel").classList.remove("show"); $("#sbPanel").classList.remove("show");
  for (const a of agents) scene.remove(a.body.g); agents.length = 0; refs.human = null;
  GAME.hostages.forEach(h => scene.remove(h.mesh)); GAME.hostages = [];
  clearWorld(); setViewmodel(null, false);
  GAME.phase = "warmup"; GAME.practice = false; GAME.customMap = null; GAME.sourceMap = null;
  document.exitPointerLock(); $("#startPanel").classList.add("show");
  preloadMainMap().catch(() => {});
}
function startFromMenu(opts) {
  GAME.botsPerTeam = Math.max(1, Math.min(12, opts.bots | 0 || 12));
  GAME.humanTeamPick = opts.team || "random"; GAME.injected = !!opts.injected; GAME.practice = false;
  if (opts.map === "practice") deployPractice(); else deployMainMap();
}

const MAIN_MAP = { glb: "./maps/cs_office.glb?v=" + ASSET_V, spawns: "./maps/cs_office.spawns.json?v=" + ASSET_V, name: "cs_office" };
let mainMapAssets = null;
function preloadMainMap() {
  mainMapAssets = Promise.all([
    fetch(MAIN_MAP.glb).then(r => { if (!r.ok) throw new Error("map geometry " + r.status); return r.arrayBuffer(); }),
    fetch(MAIN_MAP.spawns).then(r => r.ok ? r.json() : {}),
    fetch("./maps/cs_office.nav.json?v=" + ASSET_V).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  return mainMapAssets;
}
async function loadTexturedMap(url) {
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return await new Promise(res => new GLTFLoader().parse(buf, '', g => res(g.scene), () => res(null)));
  } catch (e) { return null; }
}
async function deployMainMap() {
  const ls = $("#loadStat");
  try {
    if (ls) ls.textContent = "Loading cs_office…";
    const [glb, spawns, nav] = await (mainMapAssets || preloadMainMap());
    spawns.name = spawns.name || MAIN_MAP.name;
    const tex = await loadTexturedMap("./maps/cs_office.tex.glb?v=" + ASSET_V);
    deploySource(glb, spawns, tex, nav);
  } catch (e) {
    console.warn("cs_office mesh map unavailable, using procedural layout:", e);
    if (ls) ls.textContent = "";
    deploy();
  }
}

function boot() {
  buildCrosshair();
  initMenu({ onDeploy: startFromMenu }); menuReady();
  $("#pauseResume").onclick = () => togglePause(false); $("#pauseMenu").onclick = returnToMenu;
  preloadMainMap().catch(() => {});
}

preloadModels().then(m => { if (m.ready) console.log('[models] loaded:', ['player', 'weapons', 'nades'].filter(k => m[k]).join(', ')); }).catch(() => {});
window.HVH = {
  get GAME() { return GAME; }, get agents() { return agents; }, get human() { return refs.human; }, MODELS,
  WEAPONS, ECON, computeDamage, WALLS, NODES, EDGES, segAABB, losClear, penetrate, camera, scene, renderer, meshBackend,
  get shotLines() { return shotLines; },
  deploy, deploySource, editorDebug, verifyCheats,
  fastForward(secs) { const dt = 1 / 60; let t = 0; while (t < secs) { step(dt); t += dt; } return { phase: GAME.phase, score: [GAME.scoreCT, GAME.scoreT] }; },
  computeBloom(a) { return computeBloom(a || refs.human); },
  baseMoveSpeed(a, combat) { return baseMoveSpeed(a || refs.human, combat); },
  testGrenade() { refs.human.nades = { he: 1, flash: 1 }; equipGrenade(); const eq = refs.human.equippedNade; const before = nadeProjectiles.length; const ok = throwNade(refs.human, eq); return { equipped: eq, threw: ok, projectilesBefore: before, projectilesAfter: nadeProjectiles.length, remaining: refs.human.nades[eq] }; },
  testPenetration() {
    const saved = WALLS.splice(0, WALLS.length);
    const o = new THREE.Vector3(0, 40, 0), tgt = new THREE.Vector3(0, 40, 400);
    WALLS.push({ minX: -50, maxX: 50, minZ: 190, maxZ: 204, bottom: 0, top: 200, mat: 0.45, block: true });
    const thin = penetrate(o, tgt, 'deagle');
    WALLS.length = 0;
    WALLS.push({ minX: -50, maxX: 50, minZ: 150, maxZ: 350, bottom: 0, top: 200, mat: 0.70, block: true });
    const thick = penetrate(o, tgt, 'deagle');
    WALLS.length = 0; for (const w of saved) WALLS.push(w);
    return { thinFactor: thin.factor, thinBlocked: thin.blocked, thickFactor: thick.factor, thickBlocked: thick.blocked };
  },
  topdown() { GAME.phase = "frozen"; camera.fov = 60; camera.position.set(1700, 3600, 40); camera.rotation.set(-Math.PI / 2, 0, 0); camera.updateProjectionMatrix(); document.getElementById('hud').style.display = 'none'; return 'topdown set'; },
  checkNav() {
    const blocked = [], seen = new Set();
    for (const a in EDGES) for (const b of EDGES[a]) {
      const key = Math.min(a, b) + '-' + Math.max(a, b); if (seen.has(key)) continue; seen.add(key);
      const pa = NODES[+a].p.clone(); pa.y = 40; const pb = NODES[b].p.clone(); pb.y = 40;
      if (!losClear(pa, pb, false)) blocked.push(key);
    }
    return blocked;
  },
};
boot();
loop(performance.now());
