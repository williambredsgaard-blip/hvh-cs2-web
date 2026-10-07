/* ============================================================================
   mobile.js — touch controls for hvh
   Drop-in. Does not modify any existing game logic.
   ============================================================================ */

/* --- CONFIG: change these if your keybinds differ ------------------------- */
const BIND = {
  reload:  'KeyR',
  jump:    'Space',
  crouch:  'KeyC',
  weapon:  'KeyQ',
  grenade: 'KeyG',
  buy:     'KeyB',
  score:   'Tab',
  menu:    'Escape',
};

const LOOK_SENS   = 0.0045;  // radians per pixel dragged
const DEAD_ZONE   = 12;      // px before joystick registers
const KNOB_RADIUS = 52;      // px knob travel
const MAX_PITCH   = 1.5;

/* --- state bridge (optional) ---------------------------------------------- */
let keys = null, input = null, refs = null;
let bridgeLoaded = false;

export function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

async function loadBridge() {
  if (bridgeLoaded) return;
  bridgeLoaded = true;
  try {
    const s = await import('./state.js');
    keys  = s.keys  ?? null;
    input = s.input ?? null;
    refs  = s.refs  ?? s.state ?? null;
  } catch {
    console.info('[mobile] state.js not bridged — using synthetic events only');
  }
}

/* --- low-level input dispatch --------------------------------------------- */
const KEY_NAMES = {
  KeyW:'w', KeyA:'a', KeyS:'s', KeyD:'d', KeyR:'r', KeyC:'c',
  KeyQ:'q', KeyG:'g', KeyB:'b', Space:' ', Tab:'Tab', Escape:'Escape',
};

function synthKey(code, down) {
  document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    code, key: KEY_NAMES[code] ?? code, bubbles: true, cancelable: true,
  }));
}

function setKey(code, down) {
  if (keys && code in keys) { keys[code] = down; return; }
  synthKey(code, down);
}

function tapKey(code) {
  synthKey(code, true);
  setTimeout(() => synthKey(code, false), 60);
}

function getCanvas() {
  return document.querySelector('canvas');
}

function setFire(down) {
  if (input && 'mouseDown' in input) { input.mouseDown = down; return; }
  const c = getCanvas();
  if (c) c.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', {
    button: 0, bubbles: true, cancelable: true,
  }));
}

function getHuman() {
  if (refs?.human) return refs.human;
  const g = window.GAME || window.game;
  return g?.human ?? null;
}

/* --- init ------------------------------------------------------------------ */
export async function initMobileControls() {
  if (!isTouchDevice()) return;

  const ui = document.getElementById('mobileUI');
  if (!ui) { console.warn('[mobile] #mobileUI missing from DOM'); return; }

  ui.classList.remove('mobile-hidden');
  document.documentElement.classList.add('is-touch');
  window.__MOBILE__ = true;

  await loadBridge();

  /* ---------- FLOATING JOYSTICK (left half) ---------- */
  const zone = document.getElementById('joystickZone');
  const base = document.getElementById('joystickBase');
  const knob = document.getElementById('joystickKnob');

  let joyId = null, cx = 0, cy = 0;

  function moveKnob(dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < DEAD_ZONE) {
      setKey('KeyW', false); setKey('KeyA', false);
      setKey('KeyS', false); setKey('KeyD', false);
      knob.style.transform = 'translate(0,0)';
      return;
    }
    const nx = dx / d, ny = dy / d;
    setKey('KeyW', ny < -0.35);
    setKey('KeyS', ny >  0.35);
    setKey('KeyA', nx < -0.35);
    setKey('KeyD', nx >  0.35);

    const k = Math.min(d, KNOB_RADIUS);
    knob.style.transform = `translate(${nx * k}px, ${ny * k}px)`;
  }

  function releaseJoy() {
    joyId = null;
    setKey('KeyW', false); setKey('KeyA', false);
    setKey('KeyS', false); setKey('KeyD', false);
    knob.style.transform = 'translate(0,0)';
    base.classList.remove('active');
  }

  zone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyId = t.identifier;
    cx = t.clientX; cy = t.clientY;
    base.style.left = cx + 'px';
    base.style.top  = cy + 'px';
    base.style.bottom = 'auto';
    base.classList.add('active');
    moveKnob(0, 0);
  }, { passive: false });

  zone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) moveKnob(t.clientX - cx, t.clientY - cy);
    }
  }, { passive: false });

  const joyEnd = e => {
    for (const t of e.changedTouches) if (t.identifier === joyId) releaseJoy();
  };
  zone.addEventListener('touchend', joyEnd);
  zone.addEventListener('touchcancel', joyEnd);

  /* ---------- LOOK (right half) ---------- */
  const lookZone = document.getElementById('lookZone');
  let lookId = null, lx = 0, ly = 0;

  lookZone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    lookId = t.identifier;
    lx = t.clientX; ly = t.clientY;
  }, { passive: false });

  lookZone.addEventListener('touchmove', e => {
    e.preventDefault();
    const h = getHuman();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lx;
      const dy = t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
      if (!h) continue;
      h.yaw -= dx * LOOK_SENS;
      if (typeof h.pitch === 'number') {
        h.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, h.pitch - dy * LOOK_SENS));
      }
    }
  }, { passive: false });

  const lookEnd = e => {
    for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null;
  };
  lookZone.addEventListener('touchend', lookEnd);
  lookZone.addEventListener('touchcancel', lookEnd);

  /* ---------- BUTTONS ---------- */
  const hold = (id, code) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      el.classList.add('down');
      setKey(code, true);
    }, { passive: false });
    const up = e => {
      e.preventDefault();
      el.classList.remove('down');
      setKey(code, false);
    };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
  };

  const tap = (id, code) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      el.classList.add('down');
      tapKey(code);
    }, { passive: false });
    const up = () => el.classList.remove('down');
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
  };

  // Fire: hold-to-shoot
  const fireBtn = document.getElementById('btnFire');
  if (fireBtn) {
    fireBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      fireBtn.classList.add('down');
      setFire(true);
    }, { passive: false });
    const stop = e => {
      e.preventDefault();
      fireBtn.classList.remove('down');
      setFire(false);
    };
    fireBtn.addEventListener('touchend', stop, { passive: false });
    fireBtn.addEventListener('touchcancel', stop, { passive: false });
  }

  hold('btnJump',   BIND.jump);
  hold('btnCrouch', BIND.crouch);
  tap('btnReload',  BIND.reload);
  tap('btnWeapon',  BIND.weapon);
  tap('btnNade',    BIND.grenade);
  tap('btnBuy',     BIND.buy);
  tap('btnScore',   BIND.score);
  tap('btnMenu',    BIND.menu);

  /* ---------- kill browser gestures ---------- */
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#mobileUI')) e.preventDefault();
  }, { passive: false });

  document.addEventListener('gesturestart', e => e.preventDefault());

  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 320) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  /* ---------- fullscreen + landscape on first tap ---------- */
  const goFullscreen = () => {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    if (screen.orientation?.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
    window.removeEventListener('touchstart', goFullscreen);
  };
  window.addEventListener('touchstart', goFullscreen, { once: true });

  console.info('[mobile] touch controls active');
}
