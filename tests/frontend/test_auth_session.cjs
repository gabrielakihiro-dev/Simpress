const test = require('node:test');
const assert = require('node:assert/strict');
const factory = require('../../static/js/auth/auth-session.js');
function setup(session, response = {ok:true,status:200}) {
  const calls = [], navigation = [];
  const window = {location:{pathname:'/',href:'http://127.0.0.1:8000/',origin:'http://127.0.0.1:8000',assign:x=>navigation.push(x),replace:x=>navigation.push(x)},
    document:{getElementById:()=>null},fetch:async (input,options) => {
      calls.push({input,options});
      return input === '/api/auth/session' ? {ok:true,json:async()=>session} : response;
    }};
  return {window,calls,navigation,auth:factory(window)};
}
test('file mode keeps fetch options unchanged',async()=>{
  const s = setup({enabled:false}); const options = {method:'POST',body:'fixture'};
  await s.window.fetch('/api/unidade/salvar',options);
  assert.equal(s.calls[1].options,options);
});
test('authenticated mutations include CSRF and server cookie, never JWT',async()=>{
  const s = setup({enabled:true,authenticated:true,csrf_token:'synthetic-csrf'});
  await s.window.fetch('/api/unidade/salvar',{method:'POST',headers:{'Idempotency-Key':'fixture'}});
  const options = s.calls[1].options;
  assert.equal(options.headers.get('X-CSRF-Token'),'synthetic-csrf');
  assert.equal(options.headers.get('Authorization'),null);
  assert.equal(options.headers.get('Idempotency-Key'),'fixture');
  assert.equal(options.credentials,'same-origin');
});
test('does not forward csrf to another origin',async()=>{
  const s = setup({enabled:true,authenticated:true,csrf_token:'synthetic-csrf'});
  await s.window.fetch('https://outside.example.org/api/test',{method:'POST'});
  assert.equal(s.calls.at(-1).options.headers,undefined);
});
test('expired session redirects once without repeating mutation',async()=>{
  const s = setup({enabled:true,authenticated:true,csrf_token:'synthetic-csrf'},{ok:false,status:401});
  await s.window.fetch('/api/test',{method:'POST'});
  assert.equal(s.calls.length,2); assert.deepEqual(s.navigation,['/login']);
});
test('anonymous session blocks application requests',async()=>{
  const s = setup({enabled:true,authenticated:false});
  await assert.rejects(s.window.fetch('/api/stats'),/Entre/);
  assert.equal(s.calls.length,1); assert.deepEqual(s.navigation,['/login']);
});
