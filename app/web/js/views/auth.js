import { h, replace, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { play } from '../lib/sound.js';

/** Live clock: real time, updated every 15 s while the screen exists. */
function clockFace() {
  const time = h('div.auth-time.num');
  const date = h('div.auth-date');
  const draw = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  draw();
  const timer = setInterval(() => (time.isConnected ? draw() : clearInterval(timer)), 15_000);
  return h('div.auth-clock', time, date);
}

/** Feedback for a refused credential: the card shakes once and a low tone plays. */
function refuse(card) {
  play('error');
  card.classList.remove('shake');
  void card.offsetWidth;
  card.classList.add('shake');
}

/** The sign-in screens open on the brand: the logo large, the name beside it (stacked on a phone). */
function brandHero() {
  return h('div.auth-brand',
    h('img.auth-logo', { src: '/brand/logo-256.webp', width: 88, height: 88, alt: '', decoding: 'async', draggable: false }),
    h('div.auth-wordmark',
      h('div.auth-name', 'Flint', h('span', 'Bench')),
      h('div.auth-tag', 'Local control center')));
}

/** Labelled field with an inline error slot right under it. */
function field(label, input, { hint, id, control = input } = {}) {
  const error = h('span.field-msg', { id: `${id}-msg`, role: 'alert' });
  input.id = id;
  input.setAttribute('aria-describedby', `${id}-msg`);
  const el = h('div.field', h('label', { for: id }, label), control, hint ? h('span.hint', hint) : null, error);
  return {
    el,
    input,
    error(text) {
      error.textContent = text ?? '';
      input.setAttribute('aria-invalid', text ? 'true' : 'false');
    },
  };
}

/** Password input with a visible show/hide control. */
function secret(attrs) {
  const input = h('input.input', { type: 'password', ...attrs });
  const toggle = h('button.reveal', { type: 'button', 'aria-label': 'Show password', title: 'Show password', 'aria-pressed': 'false' }, icon('eye', 15));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.title = toggle.getAttribute('aria-label');
    input.focus();
  });
  return { wrap: h('div.secret', input, toggle), input };
}

function busy(form, on) {
  form.querySelectorAll('button, input').forEach((el) => { el.disabled = on; });
  form.setAttribute('aria-busy', String(on));
  form.querySelector('button[type=submit]')?.classList.toggle('busy', on);
}

/** First run: create the local owner. PIN is optional and revealed only on request. */
export function renderSetup(root, onDone) {
  const username = field('Username', h('input.input', { name: 'username', autocomplete: 'username', maxLength: 40 }), { id: 'su-user' });
  const pw = secret({ name: 'password', autocomplete: 'new-password' });
  const password = field('Password', pw.input, { id: 'su-pass', control: pw.wrap, hint: 'At least 8 characters. Stored only as an Argon2id hash.' });
  const cf = secret({ name: 'confirm', autocomplete: 'new-password' });
  const confirm = field('Confirm password', cf.input, { id: 'su-confirm', control: cf.wrap });
  const pin = field('PIN', h('input.input.mono', { name: 'pin', inputMode: 'numeric', maxLength: 8, autocomplete: 'off' }), { id: 'su-pin', hint: '4–8 digits. Unlocks this browser after you have signed in with the password.' });
  pin.input.addEventListener('input', () => { pin.input.value = pin.input.value.replace(/\D/g, ''); });
  const wantPin = h('input', { type: 'checkbox', name: 'wantPin' });
  pin.el.hidden = true;
  wantPin.addEventListener('change', () => {
    pin.el.hidden = !wantPin.checked;
    if (wantPin.checked) pin.input.focus();
    else pin.error('');
  });
  const formError = h('p.field-error', { role: 'alert' });

  const form = h('form', { novalidate: true },
    username.el,
    password.el,
    confirm.el,
    h('label.check', wantPin, 'Also set a PIN for quick unlock'),
    pin.el,
    formError,
    h('button.btn.primary', { type: 'submit' }, 'Create account', icon('chevron', 14)));

  function validate() {
    let first = null;
    const fail = (f, msg) => { f.error(msg); first ??= f; };
    [username, password, confirm, pin].forEach((f) => f.error(''));
    if (!username.input.value.trim()) fail(username, 'Choose a username.');
    if (password.input.value.length < 8) fail(password, 'Use at least 8 characters.');
    if (confirm.input.value !== password.input.value) fail(confirm, 'The passwords do not match.');
    if (wantPin.checked && !/^\d{4,8}$/.test(pin.input.value)) fail(pin, 'The PIN is 4 to 8 digits.');
    first?.input.focus();
    return !first;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.textContent = '';
    if (!validate()) {
      refuse(card);
      return;
    }
    busy(form, true);
    try {
      const state = await api.post('/api/auth/setup', {
        username: username.input.value.trim(),
        password: password.input.value,
        confirm: confirm.input.value,
        pin: wantPin.checked ? pin.input.value : undefined,
      });
      play('unlock');
      onDone(state);
    } catch (err) {
      formError.textContent = err.message;
      busy(form, false);
      refuse(card);
    }
  });

  const card = h('div.auth-card',
    h('h1', 'Create your console'),
    h('p.dim', 'One local owner. No cloud account, no telemetry: everything stays in the FlintBench data folder.'),
    form);
  replace(root, h('main.auth', brandHero(), card));
  username.input.focus();
}

/**
 * Lock / sign-in screen. The PIN is offered only when one was set and this browser already
 * holds a session; otherwise the password is asked. Never asks for the username again.
 */
export function renderLock(root, state, onDone) {
  let mode = state.pinAvailable ? 'pin' : 'password';
  const card = h('div.auth-card');
  replace(root, h('main.auth', brandHero(), clockFace(), card));

  const draw = () => {
    const usePin = mode === 'pin';
    let input;
    let control;
    if (usePin) {
      input = h('input.input.pin-input', { name: 'pin', type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: 8 });
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, ''); });
      control = input;
    } else {
      const s = secret({ name: 'password', autocomplete: 'current-password' });
      input = s.input;
      control = s.wrap;
    }
    const f = field(usePin ? 'PIN' : 'Password', input, { id: usePin ? 'lk-pin' : 'lk-pass', control });

    const form = h('form', { novalidate: true },
      f.el,
      h('button.btn.primary', { type: 'submit' }, state.authenticated ? 'Unlock' : 'Sign in', icon('chevron', 14)),
      state.pinAvailable
        ? h('button.btn.ghost', { type: 'button', onclick: () => { mode = usePin ? 'password' : 'pin'; draw(); } }, usePin ? 'Use password instead' : 'Use PIN instead')
        : null);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value) {
        f.error(usePin ? 'Enter your PIN.' : 'Enter your password.');
        input.focus();
        return;
      }
      f.error('');
      busy(form, true);
      try {
        const next = await api.post('/api/auth/unlock', usePin ? { pin: input.value } : { password: input.value });
        play('unlock');
        card.classList.add('is-unlocked');
        onDone(next);
      } catch (err) {
        busy(form, false);
        refuse(card);
        input.value = '';
        if (err.status === 403) {
          // too many PIN failures: the password is required from now on
          mode = 'password';
          state.pinAvailable = false;
          draw();
          card.querySelector('.field-msg').textContent = err.message;
          return;
        }
        f.error(err.message);
        input.focus();
      }
    });

    replace(card,
      h('h1', `Welcome back, ${state.username}.`),
      h('p.dim', state.authenticated
        ? (usePin ? 'FlintBench is locked. Enter your PIN.' : 'FlintBench is locked. Enter your password.')
        : 'Sign in on this browser with your password.'),
      form);
    input.focus();
  };
  draw();
}
