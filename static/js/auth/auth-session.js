(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.SimpressAuth = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (window) {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  let session;
  const loginPage = window.location.pathname === '/login';
  function goLogin() { if (!loginPage) window.location.assign('/login'); }
  const ready = nativeFetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'})
    .then(async response => {
      if (!response.ok) throw new Error('Não foi possível verificar o acesso. Atualize a página.');
      session = await response.json();
      if (session.enabled && !session.authenticated) goLogin();
      const button = window.document.getElementById('btn-auth-logout');
      if (button && session.enabled && session.authenticated) {
        button.hidden = false;
        button.classList.remove('hidden');
        button.addEventListener('click', () => logout().catch(error => window.alert(error.message)));
      }
      return session;
    });
  window.fetch = async function (input, options) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) return nativeFetch(input, options);
    await ready;
    if (!session.enabled) return nativeFetch(input, options);
    if (!session.authenticated) throw new Error('Entre na sua conta para continuar.');
    const method = ((options && options.method) || (input && input.method) || 'GET').toUpperCase();
    const headers = new Headers(options && options.headers || input && input.headers || {});
    if (!['GET', 'HEAD'].includes(method)) headers.set('X-CSRF-Token', session.csrf_token);
    const response = await nativeFetch(input, {...options, headers, credentials: 'same-origin', cache: 'no-store'});
    // Never repeat a mutation after an expired session.
    if (response.status === 401) goLogin();
    return response;
  };
  async function login(email, password) {
    await ready;
    const response = await nativeFetch('/api/auth/login', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token}, body: JSON.stringify({email, password})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || 'Não foi possível entrar.');
    window.location.replace('/');
  }
  async function logout(all = false) {
    const response = await window.fetch('/api/auth/' + (all ? 'logout-all' : 'logout'), {method: 'POST'});
    if (!response.ok) throw new Error('Não foi possível encerrar a sessão. Tente novamente.');
    window.location.assign('/login');
  }
  // All callers await ready, and the login page displays a controlled error.
  ready.catch(() => {});
  return {ready, login, logout};
});
