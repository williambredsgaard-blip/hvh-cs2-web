/* ============================== [MOBILE] ==============================
   Touch controls. Only activates on touch-capable devices — desktops are
   entirely unaffected (nothing below runs, no listeners are added).

   Everything here writes into the SAME `keys` / `input` objects the
   keyboard and mouse handlers use, or dispatches the SAME synthetic key
   events those handlers listen for, so no game system (movement, combat,
   aimbot, spectator, cheat menu, buy menu, pause) needs to know mobile
   exists.

   Layout:
     · Left half     — floating joystick for movement (write keys.WASD)
     · Right half    — drag to look (write human.yaw / human.pitch)
     · Bottom-right  — action buttons (dispatch synthetic keyboard events)
     · Tap (no drag) on the look side is forwarded to the game canvas, so
       the spectate-cycle / audio-unlock click handler still fires.       */

import { keys, input, refs } from './state.js';
import { unlockAudio } from './sfx.js';

const IS_TOUCH =
  ('ontouchstart' in window) ||
  (navigator.maxTouchPoints > 0) ||
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

if (IS_TOUCH) {
  window.__MOBILE__ = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}

/* ---------- tunables ---------- */
const LOOK_SENS    = 0.0055;   // rad per CSS pixel dragged on the look side
const DEAD_ZONE    = 10;       // px the stick must travel before it registers
const KNOB_TRAVEL  = 55;       // px of visual knob travel at full deflection
const MAX_PITCH    = 1.5;
const TAP_TIME     = 220;      // ms  — under this, a look-side touch is a tap, not a drag
const TAP_TRAVEL   = 10;       // px  — under this total travel, a touch is a tap

/* ---------- boot ---------- */
function boot() {
  if (window.__HVH_MOBILE__) return;
  window.__HVH_MOBILE__ = true;
  document.documentElement.classList.add('is-touch');

  // Neutralise requestPointerLock on touch devices. The game calls it from
  // deploy(), deploySource(), deployPractice(), closeBuy(), togglePause() and
  // the canvas click handler; on a phone pointer lock either no-ops or throws.
  // No-op it here so none of those call-sites need to be guarded individually.
  const origLock = Element.prototype.requestPointerLock;
  Element.prototype.requestPointerLock = function () {
    if (window.__MOBILE__) { try { return Promise.resolve(); } catch (e) { return undefined; } }
    return origLock.apply(this, arguments);
  };

  wireJoystick();
  wireLook();
  wireButtons();
  blockGestures();
  requestFullscreenOnFirstTap();

  console.info('[mobile] touch controls active');
}

/* ---------- key synthesis ---------- */
const KEY_NAMES = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  KeyR: 'r', KeyC: 'c', KeyB: 'b', KeyG: 'g', KeyI: 'i',
  Space: ' ', Tab: 'Tab', Escape: 'Escape',
  Digit1: '1', Digit2: '2', Digit3: '3',
};
function synthKey(code, down) {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    code, key: KEY_NAMES[code] ?? code, bubbles: true, cancelable: true,
  }));
}
function tapKey(code) { synthKey(code, true); setTimeout(() => synthKey(code, false), 70); }

/* ---------- joystick (left half, appears where you touch) ---------- */
function wireJoystick() {
  const zone = document.getElementById('mJoystickZone');
  const base = document.getElementById('mJoystickBase');
  const knob = document.getElementById('mJoystickKnob');
  if (!zone || !base || !knob) return;

  let id = null, cx = 0, cy = 0;

  function move(dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < DEAD_ZONE) {
      keys.KeyW = false; keys.KeyA = false; keys.KeyS = false; keys.KeyD = false;
      knob.style.transform = 'translate(0,0)';
      return;
    }
    const nx = dx / d, ny = dy / d;
    keys.KeyW = ny < -0.35;
    keys.KeyS = ny >  0.35;
    keys.KeyA = nx < -0.35;
    keys.KeyD = nx >  0.35;
    const k = Math.min(d, KNOB_TRAVEL);
    knob.style.transform = `translate(${nx * k}px, ${ny * k}px)`;
  }
  function release() {
    id = null;
    keys.KeyW = false; keys.KeyA = false; keys.KeyS = false; keys.KeyD = false;
    knob.style.transform = 'translate(0,0)';
    base.classList.remove('active');
  }

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    unlockAudio();                              // a touch is a user gesture — let WebAudio start
    const t = e.changedTouches[0];
    id = t.identifier; cx = t.clientX; cy = t.clientY;
    base.style.left = cx + 'px';
    base.style.top  = cy + 'px';
    base.classList.add('active');
    move(0, 0);
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === id) move(t.clientX - cx, t.clientY - cy);
  }, { passive: false });

  const end = e => { for (const t of e.changedTouches) if (t.identifier === id) release(); };
  zone.addEventListener('touchend', end);
  zone.addEventListener('touchcancel', end);
}

/* ---------- look (right half, drag; tap cycles spectators) ---------- */
function wireLook() {
  const zone = document.getElementById('mLookZone');
  if (!zone) return;

  let id = null, lx = 0, ly = 0, startT = 0, travel = 0;

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    unlockAudio();
    const t = e.changedTouches[0];
    id = t.identifier; lx = t.clientX; ly = t.clientY;
    startT = performance.now(); travel = 0;
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    const h = refs.human;
    for (const t of e.changedTouches) {
      if (t.identifier !== id) continue;
      const dx = t.clientX - lx, dy = t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
      travel += Math.hypot(dx, dy);
      if (!h || !h.alive) continue;
      h.yaw -= dx * LOOK_SENS;
      h.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, h.pitch - dy * LOOK_SENS));
    }
  }, { passive: false });

  const end = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== id) continue;
      id = null;
      // Short, near-stationary touch → forward it as a canvas click so the
      // game's own click handler runs (spectate-cycle on death, audio unlock).
      if ((performance.now() - startT) < TAP_TIME && travel < TAP_TRAVEL) {
        const cvs = document.querySelector('#app canvas');
        if (cvs) cvs.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      }
    }
  };
  zone.addEventListener('touchend', end);
  zone.addEventListener('touchcancel', end);
}

/* ---------- action buttons ---------- */
function wireButtons() {
  // hold buttons: keydown on touchstart, keyup on touchend — the game reads
  // keys["Space"] / keys["KeyC"] / keys["Tab"] every frame, so this is exactly
  // the same "held" state a physical key produces
  const hold = (id, code) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); unlockAudio(); el.classList.add('down'); synthKey(code, true); }, { passive: false });
    const up = e => { e.preventDefault(); el.classList.remove('down'); synthKey(code, false); };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  };
  // tap buttons: one keydown + keyup ~70 ms later
  const tap = (id, code) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); unlockAudio(); el.classList.add('down'); tapKey(code); }, { passive: false });
    const up = () => el.classList.remove('down');
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  };

  // fire: write input.mouseDown directly — humanShoot() reads it every frame
  const fire = document.getElementById('mBtnFire');
  if (fire) {
    fire.addEventListener('touchstart', e => { e.preventDefault(); unlockAudio(); fire.classList.add('down'); input.mouseDown = true; }, { passive: false });
    const stop = e => { e.preventDefault(); fire.classList.remove('down'); input.mouseDown = false; };
    fire.addEventListener('touchend', stop, { passive: false });
    fire.addEventListener('touchcancel', stop, { passive: false });
  }

  hold('mBtnJump',   'Space');
  hold('mBtnCrouch', 'KeyC');
  hold('mBtnScore',  'Tab');
  tap('mBtnReload',  'KeyR');
  tap('mBtnNade',    'KeyG');
  tap('mBtnBuy',     'KeyB');
  tap('mBtnMenu',    'KeyI');
  tap('mBtnPause',   'Escape');

  // weapon cycle: read what we're holding from refs.human and advance 1→2→3→1
  const wep = document.getElementById('mBtnWeapon');
  if (wep) {
    wep.addEventListener('touchstart', e => {
      e.preventDefault(); unlockAudio(); wep.classList.add('down');
      const h = refs.human;
      let code = 'Digit3';
      if (h) {
        if (h.cur === h.slotPrimary)      code = h.slotSecondary ? 'Digit2' : 'Digit3';
        else if (h.cur === h.slotSecondary) code = 'Digit3';
        else                                code = h.slotPrimary ? 'Digit1' : (h.slotSecondary ? 'Digit2' : 'Digit3');
      }
      tapKey(code);
    }, { passive: false });
    const up = () => wep.classList.remove('down');
    wep.addEventListener('touchend', up);
    wep.addEventListener('touchcancel', up);
  }
}

/* ---------- block browser gestures ---------- */
function blockGestures() {
  // pinch-zoom (Safari's non-standard gestures)
  document.addEventListener('gesturestart',  e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());
  document.addEventListener('gestureend',    e => e.preventDefault());

  // double-tap zoom — a second tap inside 320 ms is swallowed
  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 320) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  // long-press context menu on the control surface
  document.addEventListener('contextmenu', e => { if (e.target.closest('#mobileUI')) e.preventDefault(); });
}

/* ---------- fullscreen + landscape lock on the first touch ---------- */
function requestFullscreenOnFirstTap() {
  const go = () => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    window.removeEventListener('touchstart', go);
  };
  window.addEventListener('touchstart', go, { once: true, passive: true });
}
