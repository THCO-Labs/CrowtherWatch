const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const views = ['consentView', 'loginView', 'dashView'];
const showView = (id) => views.forEach(v => (v === id ? show($(v)) : hide($(v))));

const naira = (n) => Number(n || 0).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });

let email = '';

// WAT (UTC+1, no DST) weekday with Monday = 0, matching the policy's day_of_week.
function watMondayZeroToday() {
  const wat = new Date(Date.now() + 60 * 60 * 1000);
  return (wat.getUTCDay() + 6) % 7;
}

function expectedHoursToday(policy) {
  if (!policy || !Array.isArray(policy.days)) return 0;
  const today = watMondayZeroToday();
  const day = policy.days.find(d => d.day_of_week === today);
  return day && day.is_working_day ? day.expected_hours : 0;
}

function setError(el, msg) {
  if (!msg) { hide(el); return; }
  el.textContent = msg; show(el);
}

async function renderDashboard() {
  const s = await window.cw.getStatus();
  $('who').textContent = s.email || '';
  $('intMins').textContent = s.captureIntervalMinutes;
  if (s.policy) {
    $('rate').textContent = `${naira(s.policy.amount_per_hour)}/hr`;
    $('expToday').textContent = `${expectedHoursToday(s.policy)}h`;
  }
  setRecordingUi(s.recording);
  $('lastShot').textContent = s.lastShotAt ? `Last screenshot: ${new Date(s.lastShotAt).toLocaleTimeString()}` : '';
  showView('dashView');
}

function setRecordingUi(on) {
  const dot = $('recDot'), banner = $('recBanner'), btn = $('toggleBtn');
  if (on) { show(dot); show(banner); btn.textContent = 'Stop working'; btn.classList.remove('btn-start'); btn.classList.add('btn-stop'); }
  else { hide(dot); hide(banner); btn.textContent = 'Start working'; btn.classList.add('btn-start'); btn.classList.remove('btn-stop'); }
}

// ── Consent ──────────────────────────────────────────────────────────────────────────────────
$('consentBox').addEventListener('change', (e) => { $('consentBtn').disabled = !e.target.checked; });
$('consentBtn').addEventListener('click', async () => { await window.cw.acceptConsent(); showView('loginView'); });

// ── Login ────────────────────────────────────────────────────────────────────────────────────
$('sendCodeBtn').addEventListener('click', async () => {
  setError($('loginError'), '');
  email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) { setError($('loginError'), 'Enter your email and password.'); return; }
  $('sendCodeBtn').disabled = true;
  try {
    await window.cw.initAuth(email, password);
    hide($('loginStep')); show($('codeStep'));
  } catch (e) { setError($('loginError'), e.message); }
  finally { $('sendCodeBtn').disabled = false; }
});

$('verifyBtn').addEventListener('click', async () => {
  setError($('loginError'), '');
  const code = $('code').value.trim();
  if (!code) { setError($('loginError'), 'Enter the code from your email.'); return; }
  $('verifyBtn').disabled = true;
  try {
    await window.cw.verifyAuth(email, code);
    await renderDashboard();
  } catch (e) { setError($('loginError'), e.message); }
  finally { $('verifyBtn').disabled = false; }
});

$('backBtn').addEventListener('click', () => { show($('loginStep')); hide($('codeStep')); setError($('loginError'), ''); });

// ── Dashboard ────────────────────────────────────────────────────────────────────────────────
$('toggleBtn').addEventListener('click', async () => {
  setError($('dashError'), '');
  const s = await window.cw.getStatus();
  $('toggleBtn').disabled = true;
  try {
    if (s.recording) { await window.cw.stopTracking(); setRecordingUi(false); }
    else { await window.cw.startTracking(); setRecordingUi(true); }
  } catch (e) { setError($('dashError'), e.message); }
  finally { $('toggleBtn').disabled = false; }
});

window.cw.onUpdateReady(() => { show($('updateBar')); });
$('updateBtn').addEventListener('click', () => window.cw.installUpdate());

window.cw.onRecordingChanged(setRecordingUi);
window.cw.onShotTaken((at) => { $('lastShot').textContent = `Last screenshot: ${new Date(at).toLocaleTimeString()}`; });
window.cw.onCaptureError((msg) => setError($('dashError'), `Screenshot issue: ${msg}`));

// ── Boot ─────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const consented = await window.cw.getConsent();
  showView(consented ? 'loginView' : 'consentView');
})();
