/**
 * Pontes entre o código antigo (app.js, data-on-*, ações chamadas por outras features) e os painéis React.
 * Cada entrada da tabela só encaminha: não tem regra, não lê DOM, não chama a API. A regra mora no painel
 * (frontend/src/paineis/<painel>/) e `app.js` publica o que `criarPonte` devolve no `window`.
 *
 * - `sincronas`: devolvem no mesmo turno (ponteReactSincrona); sem o painel, o erro sobe para quem chamou.
 * - `assincronas`: esperam o painel React carregar (ponteReact); sem o painel, a rejeição vai ao console como "nome: mensagem"
 *   (LGPD: nunca o objeto de erro inteiro) e a ação resolve com undefined.
 * - `silenciosa`: igual às assíncronas, mas sem console, porque o que passa por elas pode ter dado pessoal.
 * - `semArgumentos`: a ação é chamada sem repassar os argumentos do chamador.
 * A ordem das chaves devolvidas é a das listas (sincronas primeiro): é a ordem em que o app.js publica no `window`.
 */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export type EspecificacaoPonte = {
  painel: string;
  sincronas?: string[];
  assincronas: string[];
  silenciosa?: boolean;
  semArgumentos?: boolean;
};

// Sem o painel a tela segue funcionando, só sem a ação: o erro vai ao console como "nome: mensagem".
export const registrar = (nome: string, promessa: Promise<Qualquer>): Promise<Qualquer> => promessa.catch((erro: Qualquer) => { console.error(`${nome}: ${erro?.message}`); });

export function registrarRejeicoes(ponte: Acoes, semArgumentos = false): Acoes {
  return Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos: Qualquer[]) => registrar(nome, semArgumentos ? acao() : acao(...argumentos)),
  ]));
}

// Os chamadores antigos não tratam erro: nunca rejeita. Sem console: o que passa por estas ações pode ter dado pessoal.
export function silenciarRejeicoes(ponte: Acoes): Acoes {
  return Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos: Qualquer[]) => acao(...argumentos).catch(() => {}),
  ]));
}

const TABELA = {
  // Nomes do Microsoft Entra (modal Atualizar planilhas): importa o CSV local do Entra, separado das duas planilhas.
  // Migrado para React no Dia 2 (G4): a seção vive em frontend/src/paineis/entra-users/.
  // Quem chama (inicialização em frontend/src/aplicacao/app.ts, data-on-*) não trata erro: como no módulo antigo, nunca rejeita.
  entraUsers: {
    painel: "entra-users",
    assincronas: ["carregarEstadoEntra", "importarNomesEntra", "exportarNomesEntra"],
  },
  // Relatório mensal do contrato (diálogo do mês e download do XLSX; docs/operacao/relatorio-mensal.md).
  // Migrado para React no Dia 3 (G9): o formulário vive em frontend/src/paineis/relatorio-mensal/.
  // O ícone data-lucide="download" do botão agora é desenhado pelo React; este literal o mantém no subset do lucide
  // (scripts/build/lucide-subset.cjs lê static/, frontend/partials/ e frontend/src/).
  // Quem chama (data-on-*, cockpit-tool-panels) não trata erro: como no módulo antigo, nunca rejeita.
  monthlyReport: {
    painel: "relatorio-mensal",
    assincronas: ["abrirRelatorioMensal", "fecharRelatorioMensal", "exportarRelatorioMensal"],
  },
  // Home e-mail por modelo: modal "E-mail pelo Outlook" (modelos com autosave, contatos do Entra, abrir ou enviar pelo backend local).
  // Migrado para React no Dia 3 (G7): o modal vive em frontend/src/paineis/outlook-email/.
  // Quem chama (data-on-*, fechar do modal) não trata erro: como no módulo antigo, nunca rejeita.
  outlookEmail: {
    painel: "outlook-email",
    assincronas: [
      "abrirEmailOutlook", "fecharEmailOutlook", "atualizarEmailOutlook", "trocarModeloEmail", "novoModeloEmail",
      "duplicarModeloEmail", "excluirModeloEmail", "restaurarModeloEmail", "copiarTextoEmail", "abrirEmailNoOutlook",
      "enviarEmailPeloOutlook",
    ],
  },
  // Aba Automação: inicia as rotinas do Chrome e mostra estado, log ao vivo e histórico (docs/operacao/automacao-chrome.md).
  // Migrado para React no Dia 3 (G7): a aba vive em frontend/src/paineis/chrome-automation/.
  // Quem chama (data-on-*, app.ts, inventory-upload) não trata erro: como no módulo antigo, nunca rejeita.
  chromeAutomation: {
    painel: "chrome-automation",
    assincronas: [
      "inicializarAutomacao", "alterarAgendamentoDashboard", "carregarAgendamentoDashboard", "iniciarRotinaAutomacao",
      "acompanharExecucaoAutomacao", "cancelarRotinaAutomacao", "atualizarEstadoAutomacao", "carregarHistoricoAutomacao",
      "filtrarHistoricoAutomacao", "limparFiltrosAutomacao", "mudarPaginaHistoricoAutomacao",
      "carregarExecucoesLogAutomacao", "mudarPaginaLogAutomacao", "selecionarLogAutomacao", "abrirLogExecucaoAutomacao",
      "voltarAoVivoAutomacao", "alterarLimiteLogAutomacao",
    ],
  },
  // Assistente: conversa com a IA do Simpress (OpenRouter, chamada pelo servidor local) pelas rotas /api/assistente/*, no chat flutuante (F9).
  // Migrado para React no Dia 3 (G7b): o painel vive em frontend/src/paineis/assistant-chat/.
  // Quem chama (F9, #btn-assistente, data-on-*) não trata erro: como no módulo antigo, nunca rejeita.
  assistantChat: {
    painel: "assistant-chat",
    assincronas: [
      "carregarAssistente", "alternarAssistente", "minimizarAssistente", "maximizarAssistente",
      "voltarConversaAssistente", "enviarMensagemAssistente", "confirmarPendenteAssistente", "cancelarPendenteAssistente",
      "cancelarEnvioAssistente", "novaConversaAssistente", "contarMensagemAssistente", "preencherAtalhoAssistente",
      "teclaAssistente", "alternarGravacaoAssistente", "alternarVozAssistente", "alternarInstrucoesAssistente",
      "alternarBuscaWebAssistente", "contarInstrucoesAssistente", "salvarInstrucoesAssistente",
      "limparInstrucoesAssistente", "anexarArquivoAssistente", "removerAnexoAssistente", "alternarHistoricoAssistente",
      "abrirConversaHistoricoAssistente", "abrirConversaLateralAssistente", "fecharConversaHistoricoAssistente",
      "exportarPdfHistoricoAssistente", "pedirApagarConversaHistoricoAssistente",
      "cancelarApagarConversaHistoricoAssistente", "apagarConversaHistoricoAssistente", "alternarLembretesAssistente",
      "marcarLembreteAssistente", "pedirApagarLembreteAssistente", "cancelarApagarLembreteAssistente",
      "apagarLembreteAssistente",
    ],
  },
  // Catálogo de unidades: ponte para o painel React em frontend/src/paineis/unidades/.
  // carregarUnidades grava appState.unidadesList (lido pelo Transporte e pelo ticket UX); recarregarUnidadesCockpit
  // é chamado pelo roteador do Cockpit ao abrir o painel "unidades".
  // Os data-on-* chamam sem esperar: a falha do bundle vira console.error, nunca rejeição solta.
  unitsCatalog: {
    painel: "unidades",
    assincronas: [
      "carregarUnidades", "abrirModalGerenciarUnidades", "copiarDadoUnidade", "editarUnidade", "toggleFormNovaUnidade",
      "salvarUnidadeForm", "recarregarUnidadesCockpit",
    ],
  },
  // Configuração local (Prontidão da base): ponte para o painel React em frontend/src/paineis/configuracao-local/.
  // Contrato da API e regras: docs/cockpit-prompts/19-configuracao-local.md.
  // Os data-on-* chamam sem esperar: a falha do bundle vira console.error, nunca rejeição solta.
  configuracaoLocal: {
    painel: "configuracao-local",
    assincronas: [
      "abrirConfiguracaoLocal", "fecharConfiguracaoLocal", "salvarContasConfiguracaoLocal",
      "salvarLinksConfiguracaoLocal", "salvarClienteConfiguracaoLocal", "salvarAssistenteConfiguracaoLocal",
      "removerChaveAssistenteConfiguracaoLocal",
    ],
  },
  // Resumo (painel de ferramenta "comparacao"): ativos por regional, com filtro por categoria.
  // Migrado para React no Bloco 3 (piloto): o cartão vive em frontend/src/paineis/resumo-ativos/.
  // Chamado ao abrir o painel (cockpit-tool-panels espera por ele): como no cartão antigo, nunca rejeita.
  resumoAtivos: {
    painel: "resumo-ativos",
    assincronas: ["carregarResumoAtivos"],
    semArgumentos: true,
  },
  // Cobertura de equipamentos (F10): necessidades, disponíveis, reservas, movimentações e devoluções por cidade.
  // Migrado para React no Grupo 6: o painel vive em frontend/src/paineis/cobertura/ (regras de tela em paineis/cobertura/modelo.ts).
  // Chamado ao abrir o painel (cockpit-tool-panels espera por ele sem tratar erro): nunca rejeita.
  coverage: {
    painel: "cobertura",
    assincronas: ["carregarCobertura"],
    semArgumentos: true,
  },
  // Chamados (F5) → conflitos de edição do Dashboard: escolha por célula entre o SharePoint e o site, e reenvio.
  // Migrado para React no G1 (Sebrae): a seção vive em frontend/src/paineis/sebrae-conflitos/.
  // sebrae-dashboard chama sem esperar nem tratar erro: como na seção antiga, nunca rejeita.
  sebraeConflitos: {
    painel: "sebrae-conflitos",
    assincronas: ["carregarConflitosSebrae"],
    semArgumentos: true,
  },
  // Automação → resumo das últimas entradas do histórico do Dashboard Sebrae (mini-lista no cartão).
  // Migrado para React no G1 (Sebrae): a lista vive em frontend/src/paineis/sebrae-historico/.
  // sebrae-dashboard chama sem esperar nem tratar erro: como no resumo antigo, nunca rejeita.
  sebraeHistorico: {
    painel: "sebrae-historico",
    assincronas: ["carregarResumoHistoricoSebrae"],
    semArgumentos: true,
  },
  // Contatos e representantes: ações migradas para frontend/src/paineis/contatos-regionais/.
  regionalContacts: {
    painel: "contatos-regionais",
    sincronas: [
      "formatarTelefoneBrasileiro", "entregaAlmocoNaoFecha", "abrirConfiguracaoContatoOrigem",
      "fecharConfiguracaoContatoOrigem", "obterDadosCliente", "fecharConfiguracaoCliente",
      "abrirImportacaoModeloTransferencia", "atualizarObrigatoriedadeDuracaoPausaEntrega",
      "popularSeletoresRepresentantesRegionais", "preencherRepresentanteRegional", "handleRepresentanteRegionalChange",
      "inicializarMascarasTelefone", "abrirEdicaoRepresentanteRegional", "fecharEdicaoRepresentanteRegional",
      "alternarAlmocoRepresentanteRegional",
    ],
    assincronas: [
      "carregarConfiguracaoTransferencia", "salvarConfiguracaoContatoOrigem", "abrirConfiguracaoCliente",
      "salvarConfiguracaoCliente", "carregarRepresentantesRegionais", "salvarRepresentanteRegional",
      "restaurarRepresentanteRegional",
    ],
  },
  // Comportamento da Home e do Transporte migrado para frontend/src/paineis/transporte/.
  transferForm: {
    painel: "transporte",
    sincronas: [
      "atualizarResumoSerieTransferencia", "ativarAbaTransferencia", "abrirAbaTransporteDoEquipamento",
      "abrirHomeParaPesquisarEquipamento", "controlarAbasTransferencia", "forcarSedePradoVelho",
      "atualizarEstadoCopiaCnpjEntrega", "atualizarChipsUnidade", "trocarEquipamentoTransporte",
      "handleUnidadeDestinoChange", "selecionarUnidadePorCidade", "adicionarObsChamado", "alternarVisualizacaoModelo",
      "recolherVisualizacoesModelosChamado", "alternarChamadosManuais", "abrirModalPreview", "fecharModalPreview",
      "copiarTextoDoModal", "montarTextoSolicitacaoTransporte", "gerarTextoSolicitacaoTransporte",
      "montarTextoAlterarEndereco", "serialAlterarEndereco", "atualizarBotaoAlterarEndereco",
      "atualizarPreviaTransporteCockpit", "fecharModalTextoTransporte", "validarCamposObrigatoriosPlanilha",
    ],
    assincronas: [
      "copiarModeloChamado", "prepararTransporte", "copiarSerieAtual", "copiarDadoLocalAtual", "copiarDadoEntrega",
      "copiarTextoSolicitacaoTransporte", "gerarPlanilhaExcel", "resetarFormulario",
    ],
  },
  // Busca, lista da Home e Endpoint migrados para frontend/src/paineis/pesquisa-equipamento/.
  equipmentSearch: {
    painel: "pesquisa-equipamento",
    sincronas: [
      "definirEquipamentoAtual", "limparSelecaoEquipamento", "invalidarBuscasEquipamento",
      "invalidarDadosEquipamentoAposRestauracao", "handleSerialInput", "handleSerialKeydown",
      "selecionarItemAutocomplete", "aplicarSugestaoBusca", "fecharAutocomplete", "limparSerial", "exibirEquipamento",
      "formatarLocalAtual", "limparPesquisasRecentes", "renderHomeList", "highlightHomeListItem", "filtrarListaHome",
      "inicializarListaHome", "aplicarCodigoProntoPowerShell", "adicionarCodigoPowerShell",
    ],
    assincronas: [
      "consultarEndpoint", "controleRemotoEndpoint", "abrirPowerShellEndpoint", "carregarCodigosPowerShell",
      "alternarEditorCodigosPowerShell", "salvarCodigosPowerShell", "atualizarSelecaoAposSubstituirInventarios",
      "buscarSerial", "abrirPesquisaRecente", "carregarMaisItensHome", "carregarListaHome",
    ],
  },
  // Arquivos de inventário (troca Simpress + Endpoint com prévia, importação de modelos, exportação): ações migradas para frontend/src/paineis/importacao-planilhas/.
  // Síncronas: abrir e fechar modais e limpar a prévia são chamadas por outros módulos e atalhos no mesmo turno.
  // Assíncronas: espere o painel React. As duas inicializações entram aqui porque app.ts as chama antes do evento
  // simpress:react-pronto; esperar pelo painel garante uma única execução, depois do bundle.
  inventoryUpload: {
    painel: "importacao-planilhas",
    sincronas: [
      "abrirImportacaoModelo", "fecharImportacaoModelo", "limparPreviaUploadPlanilhas", "abrirModalAtualizarPlanilhas",
      "fecharModalAtualizarPlanilhas",
    ],
    assincronas: [
      "inicializarExportacaoAutomaticaHistorico", "inicializarArquivosAtualizacaoPlanilhas", "enviarModeloLocal",
      "previsualizarPlanilhas", "enviarPlanilhas", "exportarEquipamentosAtualizados",
    ],
  },
  // Equipment-card actions delegated to the React panel.
  equipmentEditor: {
    painel: "cartao-equipamento",
    sincronas: [
      "atualizarUsuarioLogadoCard", "editarNomePessoa", "editarUsuarioLogado", "editarDadosCadastrais",
      "cancelarDadosCadastrais",
    ],
    assincronas: [
      "abrirModalEditarEquipamento", "cadastrarNovoSerialPesquisado", "fecharModalEditarEquipamento",
      "abrirModalEditarApelido", "fecharModalEditarApelido", "salvarApelido", "salvarDadosEquipamento",
      "salvarUsuarioLogado", "limparUsuarioLogado", "salvarNomePessoa", "salvarDadosCadastrais",
    ],
  },
  // Automação -> "Chamados novos do SoftExpert": ações migradas para frontend/src/paineis/sebrae-dashboard/.
  // mostrarChamadoSebrae devolve o cartão no mesmo turno (cockpit-chamados abre a linha e espera a animação): não pode esperar o boot do React.
  sebraeDashboard: {
    painel: "sebrae-dashboard",
    sincronas: [
      "mostrarChamadoSebrae",
    ],
    assincronas: [
      "carregarNovosSebrae", "lerAntigosSebrae", "importarDashboardSebrae", "atualizarDashboardSebrae",
      "descartarRascunhoSebrae", "cartaoChamadoSebraeLeitura",
    ],
  },
  // Lembretes (Ferramentas): lista local de tarefas em /api/lembretes. A descrição tem dado pessoal: nunca vai para log nem para storage.
  // Migrado para React no Grupo 6: junto com os Termos, o painel vive em frontend/src/paineis/lembretes/ (regras puras em
  // lembretes-puro.ts, ações em lembretes-acoes.ts). Esta entrada é só a ponte que mantém as ações publicadas para o código antigo
  // (carregarLembretes ao abrir o painel e as funções que os diálogos acessíveis chamam em data-close-function).
  // Os chamadores antigos não tratam erro: a ponte nunca rejeita. Sem console aqui: o que passa por estas ações pode ter dado pessoal.
  lembretes: {
    painel: "lembretes",
    assincronas: [
      "carregarLembretes", "lembretesAdicionar", "lembretesAoDigitar", "lembretesAlternar", "lembretesEditar",
      "lembretesCancelarEdicao", "lembretesTeclaEdicao", "lembretesSalvarEdicao", "lembretesAlternarConcluidos",
      "lembretesExcluir", "lembretesCancelarExclusao", "lembretesConfirmarExclusao", "lembretesCriarDoTermo",
      "lembretesCancelarCriar", "lembretesConfirmarCriar", "lembretesVerLembretes", "lembretesSelecionarVista",
      "lembretesTeclaVista", "lembretesMudarSemana", "lembretesIrParaDia", "lembretesAdicionarNoDia",
      "lembretesReagendarAtrasados", "lembretesAlternarPainelData", "lembretesTeclaPainelData", "lembretesAtalhoData",
      "lembretesAoMudarData", "lembretesRemoverData", "lembretesGerarPdfTermo", "lembretesPreencherTermo",
    ],
    silenciosa: true,
  },
  // Termos de entrega e devolução (Ferramentas): formulários na tela, folha de PDF montada na hora; nada é guardado.
  // Migrado para React no Grupo 6: junto com os Lembretes, o painel vive em frontend/src/paineis/lembretes/ (regras puras em
  // termos-puro.ts, ações em termos-acoes.ts). Esta entrada é só a ponte que mantém as ações publicadas para o código antigo
  // (cockpit-tool-panels abre a aba; equipment-search preenche o termo com o equipamento buscado).
  // Os chamadores antigos (Home, abas das ferramentas) não tratam erro: a ponte nunca rejeita.
  // Sem console aqui: nome, unidade e série do termo podem estar na mensagem do erro.
  termos: {
    painel: "lembretes",
    assincronas: [
      "termosSelecionarAba", "termosTeclaAba", "termosGerarPdf", "termosLimpar", "termosPreencherDoEquipamento",
      "termosGerarPdfDoLembrete", "termosPreencherDoLembrete",
    ],
    silenciosa: true,
  },
} satisfies Record<string, EspecificacaoPonte>;

export type NomePonte = keyof typeof TABELA;

export const NOMES_PONTES = Object.keys(TABELA) as NomePonte[];

export function criarPonte(nome: NomePonte, context: ContextoApp): Acoes {
  const { painel, sincronas, assincronas, silenciosa, semArgumentos }: EspecificacaoPonte = TABELA[nome];
  const sincrona = sincronas ? context.ponteReactSincrona(painel, sincronas) : {};
  const ponte = context.ponteReact(painel, assincronas);
  return { ...sincrona, ...(silenciosa ? silenciarRejeicoes(ponte) : registrarRejeicoes(ponte, semArgumentos)) };
}
