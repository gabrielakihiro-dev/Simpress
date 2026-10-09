'use strict';
const form = document.getElementById('login-form');
const status = document.getElementById('status');
SimpressAuth.ready.then(session => {
  if (!session.enabled || session.authenticated) window.location.replace('/');
}).catch(error => { status.textContent = error.message; document.getElementById('submit').disabled = true; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('submit');
  button.disabled = true;
  status.textContent = 'Validando acesso…';
  try { await SimpressAuth.login(document.getElementById('email').value, document.getElementById('password').value); }
  catch (error) { status.textContent = error.message; }
  finally { document.getElementById('password').value = ''; button.disabled = false; }
});
