// NILCODE AI authentication. Deliberately tiny — no workspace code is loaded here.
(() => {
  const $ = (id) => document.getElementById(id);
  let mode = 'signin'; // existing users sign in; new users create an account

  function render() {
    const signin = mode === 'signin';
    $('authTitle').textContent = signin ? 'Sign in to NILCODE AI' : 'Create your NILCODE AI account';
    $('authSub').textContent = signin
      ? 'Use your account to access your NILCODE AI workspace.'
      : 'A few details and your workspace is ready.';
    $('authSubmit').textContent = signin ? 'Sign in' : 'Create account';
    $('authName').classList.toggle('hidden', signin);
    $('authSwitchLabel').classList.toggle('hidden', !signin);
    $('authSwitch').classList.toggle('hidden', !signin);
    $('authSwitchLabel2').classList.toggle('hidden', signin);
    $('authSwitch2').classList.toggle('hidden', signin);
    $('authEmail').focus();
  }

  function setMode(m) {
    mode = m;
    $('authError').textContent = '';
    render();
  }

  // Google sign-in (only rendered when the server has it configured).
  document.addEventListener('nc-google-credential', async () => {
    const credential = window.__ncGoogleCredential;
    if (!credential) return;
    const err = $('authError');
    err.textContent = '';
    const submit = $('authSubmit');
    submit.disabled = true;
    try {
      const res = await fetch('api/auth/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Google sign-in failed.');
      localStorage.setItem('nc_token', data.token);
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
    }
  });

  $('authSwitch').addEventListener('click', (e) => { e.preventDefault(); setMode('signup'); });
  $('authSwitch2').addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); });

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('authError');
    err.textContent = '';
    const email = $('authEmail').value.trim();
    const password = $('authPass').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    const submit = $('authSubmit');
    submit.disabled = true;
    try {
      const res = await fetch(`api/auth/${mode === 'signin' ? 'login' : 'signup'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'signin' ? { email, password } : { email, password, name: $('authName').value.trim() }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Authentication failed.');
      localStorage.setItem('nc_token', data.token);
      location.reload(); // boot script now loads the workspace bundle
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
    }
  });

  render();
})();
