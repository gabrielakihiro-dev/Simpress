const assert = require('node:assert/strict');
const test = require('node:test');
const { criarImportacaoPlanilhas } = require('../../frontend/src/paineis/importacao-planilhas/estado.ts');

const CONFIRMACAO_UX = {
  titulo: 'Enviar ao UX Simpress?',
  mensagem: 'Atualiza apelidos e IdCliente no UX Simpress (sistema externo).',
  confirmar: 'Enviar ao UX',
  cancelar: 'Cancelar',
  destrutiva: false,
};

function prepararAmbiente({ button, downloads = [], eventos = [] } = {}) {
  global.document = {
    getElementById: () => button || { innerHTML: '', setAttribute() {}, removeAttribute() {} },
    body: { appendChild() {} },
    createElement: () => ({ click() { downloads.push(this.download); eventos.push('download'); }, remove() {} }),
  };
  global.lucide = { createIcons() {} };
  global.window = { URL: { createObjectURL: () => 'blob:download', revokeObjectURL() {} }, setTimeout() {} };
}

test('F7 mantém o download e envia o mesmo Blob e nome depois da confirmação; erro UX não invalida exportação', async () => {
  const blob = new Blob(['bytes da exportação']);
  const button = { innerHTML: 'Exportar Excel', setAttribute() {}, removeAttribute() {} };
  const downloads = [], chamadas = [], toasts = [], confirmacoes = [];
  prepararAmbiente({ button, downloads });
  const app = {
    showToast: (...args) => toasts.push(args),
    confirmarAcao: async opcoes => { confirmacoes.push(opcoes); return true; },
    apiFetch: async (url, options) => {
      chamadas.push([url, options]);
      if (url === '/api/exportar-equipamentos') return { headers: { get: () => 'attachment; filename="nome-gerado.xlsx"' }, blob: async () => blob };
      throw new Error('Chrome ocupado');
    },
  };
  await criarImportacaoPlanilhas({ app, appState: {}, apiFetch: app.apiFetch }).exportarEquipamentosAtualizados();
  assert.deepEqual(downloads, ['nome-gerado.xlsx']);
  assert.deepEqual(confirmacoes, [CONFIRMACAO_UX]);
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
  prepararAmbiente();
  const app = {
    showToast: (...args) => toasts.push(args),
    confirmarAcao: async () => true,
    apiFetch: async url => {
      if (url === '/api/exportar-equipamentos') return { headers: { get: () => '' }, blob: async () => new Blob(['xlsx']) };
      throw Object.assign(new Error('Chrome ocupado'), { status: 409 });
    },
  };
  await criarImportacaoPlanilhas({ app, appState: {}, apiFetch: app.apiFetch }).exportarEquipamentosAtualizados();
  assert.match(toasts.at(-1)[0], /não iniciada/i);
  assert.doesNotMatch(toasts.at(-1)[0], /resultado incerto|F4/i);
});

test('F7 entrega a execução aceita ao acompanhamento existente', async () => {
  const aceito = { estado: 'em_andamento', rotina: 'ux_apelidos', inicio: '2026-11-03T12:00:00' };
  let acompanhado;
  prepararAmbiente();
  const app = {
    showToast() {},
    confirmarAcao: async () => true,
    acompanharExecucaoAutomacao: dados => { acompanhado = dados; },
    apiFetch: async url => url === '/api/exportar-equipamentos' ? { headers: { get: () => '' }, blob: async () => new Blob(['xlsx']) } : aceito,
  };
  await criarImportacaoPlanilhas({ app, appState: {}, apiFetch: app.apiFetch }).exportarEquipamentosAtualizados();
  assert.equal(acompanhado, aceito);
});

// Confirmar envia uma vez; Cancelar (false) e Esc (null) só baixam a planilha. O download vem antes do diálogo nos três.
for (const [rotulo, resposta, postsEsperados] of [['Enviar ao UX (true)', true, 1], ['Cancelar (false)', false, 0], ['Esc (null)', null, 0]]) {
  test(`F7 Exportar Excel: ${rotulo} baixa antes de perguntar e faz ${postsEsperados} POST para /api/automacao/ux-apelidos`, async () => {
    const eventos = [], toasts = [], posts = [], downloads = [];
    prepararAmbiente({ downloads, eventos });
    const app = {
      showToast: (mensagem, tipo) => { eventos.push(`toast:${mensagem}`); toasts.push([mensagem, tipo]); },
      confirmarAcao: async opcoes => { eventos.push('confirmacao'); assert.deepEqual(opcoes, CONFIRMACAO_UX); return resposta; },
      apiFetch: async (url, options = {}) => {
        if (url === '/api/exportar-equipamentos') return { headers: { get: () => 'attachment; filename="atualizada.xlsx"' }, blob: async () => new Blob(['xlsx']) };
        posts.push([options.method, url]);
        eventos.push('post');
        return { estado: 'em_andamento' };
      },
    };
    await criarImportacaoPlanilhas({ app, appState: {}, apiFetch: app.apiFetch }).exportarEquipamentosAtualizados();

    assert.deepEqual(downloads, ['atualizada.xlsx'], 'o download acontece nos três casos');
    assert.equal(posts.length, postsEsperados);
    if (postsEsperados) assert.deepEqual(posts[0], ['POST', '/api/automacao/ux-apelidos']);
    assert.deepEqual(eventos.slice(0, 3), ['download', 'toast:Planilha Exportada com Sucesso!', 'confirmacao'], 'baixa e avisa antes de perguntar');
    assert.deepEqual(eventos.slice(3), postsEsperados ? ['post', 'toast:Atualização no UX Simpress iniciada. Acompanhe o resultado e o login em Automação (F4).'] : []);
  });
}

test('F7 Exportar Excel: falha no download não pergunta nem envia ao UX', async () => {
  const toasts = [], posts = [];
  let perguntou = false;
  const botao = { innerHTML: 'Exportar Excel', setAttribute() {}, removeAttribute() {} };
  prepararAmbiente({ button: botao });
  const consoleError = console.error;
  console.error = () => {};
  try {
    const app = {
      showToast: (...args) => toasts.push(args),
      confirmarAcao: async () => { perguntou = true; return true; },
      apiFetch: async url => {
        if (url === '/api/exportar-equipamentos') throw new Error('Falha ao exportar a planilha de equipamentos.');
        posts.push(url);
        return {};
      },
    };
    await criarImportacaoPlanilhas({ app, appState: {}, apiFetch: app.apiFetch }).exportarEquipamentosAtualizados();
  } finally {
    console.error = consoleError;
  }
  assert.equal(perguntou, false);
  assert.deepEqual(posts, []);
  assert.deepEqual(toasts, [['Falha ao exportar a planilha de equipamentos.', 'error']]);
  assert.equal(botao.disabled, false);
});
