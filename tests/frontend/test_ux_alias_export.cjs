const assert = require('node:assert/strict');
const test = require('node:test');
const createUpload = require('../../static/js/features/inventory-upload.js');

test('F7 mantém o download e envia o mesmo Blob e nome; erro UX não invalida exportação', async () => {
  const blob = new Blob(['bytes da exportação']);
  const button = { innerHTML: 'Exportar Excel', setAttribute() {}, removeAttribute() {} };
  const downloads = [], chamadas = [], toasts = [];
  global.document = { getElementById: () => button, body: { appendChild() {} }, createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }) };
  global.lucide = { createIcons() {} };
  global.window = { URL: { createObjectURL: () => 'blob:download', revokeObjectURL() {} }, setTimeout() {} };
  const app = { showToast: (...args) => toasts.push(args), apiFetch: async (url, options) => {
    chamadas.push([url, options]);
    if (url === '/api/exportar-equipamentos') return { headers: { get: () => 'attachment; filename="nome-gerado.xlsx"' }, blob: async () => blob };
    throw new Error('Chrome ocupado');
  } };
  await createUpload({ app, appState: {} }).exportarEquipamentosAtualizados();
  assert.deepEqual(downloads, ['nome-gerado.xlsx']);
  assert.equal(chamadas[1][0], '/api/automacao/ux-apelidos');
  const arquivo = chamadas[1][1].body.get('file');
  assert.equal(arquivo.name, 'nome-gerado.xlsx');
  assert.equal(await arquivo.text(), await blob.text());
  assert.deepEqual(toasts[0], ['Planilha Exportada com Sucesso!', 'success']);
  assert.match(toasts[1][0], /não foi possível confirmar o início/i);
  assert.match(toasts[1][0], /F4/);
  assert.equal(button.disabled, false);
});

test('F7 identifica respostas HTTP que comprovam que o envio não foi iniciado', async () => {
  const toasts = [];
  global.document = { getElementById: () => ({ innerHTML: '', setAttribute() {}, removeAttribute() {} }), body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) };
  global.lucide = { createIcons() {} };
  global.window = { URL: { createObjectURL: () => 'blob:download', revokeObjectURL() {} }, setTimeout() {} };
  const app = { showToast: (...args) => toasts.push(args), apiFetch: async url => {
    if (url === '/api/exportar-equipamentos') return { headers: { get: () => '' }, blob: async () => new Blob(['xlsx']) };
    throw Object.assign(new Error('Chrome ocupado'), { status: 409 });
  } };
  await createUpload({ app, appState: {} }).exportarEquipamentosAtualizados();
  assert.match(toasts.at(-1)[0], /não iniciada/i);
  assert.doesNotMatch(toasts.at(-1)[0], /resultado incerto|F4/i);
});

test('F7 entrega a execução aceita ao acompanhamento existente', async () => {
  const aceito = { estado: 'em_andamento', rotina: 'ux_apelidos', inicio: '2026-11-03T12:00:00' };
  let acompanhado;
  const app = { showToast() {}, acompanharExecucaoAutomacao: dados => { acompanhado = dados; }, apiFetch: async url =>
    url === '/api/exportar-equipamentos' ? { headers: { get: () => '' }, blob: async () => new Blob(['xlsx']) } : aceito };
  await createUpload({ app, appState: {} }).exportarEquipamentosAtualizados();
  assert.equal(acompanhado, aceito);
});
