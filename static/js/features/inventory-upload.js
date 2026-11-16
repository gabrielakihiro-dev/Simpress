// Arquivos de inventário (troca Simpress + Endpoint com prévia, importação de modelos, exportação): ações migradas para frontend/src/paineis/importacao-planilhas/.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).inventoryUpload = factory;
})(typeof window !== "undefined" ? window : globalThis, function createInventoryUpload(context) {
  "use strict";

  // Síncronas: abrir e fechar modais e limpar a prévia são chamadas por outros módulos e atalhos no mesmo turno.
  const ponteSincrona = context.ponteReactSincrona("importacao-planilhas", [
    "abrirImportacaoModelo", "fecharImportacaoModelo", "limparPreviaUploadPlanilhas",
    "abrirModalAtualizarPlanilhas", "fecharModalAtualizarPlanilhas",
  ]);
  // Assíncronas: espere o painel React. As duas inicializações entram aqui porque app.js as chama antes do evento
  // simpress:react-pronto; esperar pelo painel garante uma única execução, depois do bundle.
  const ponte = context.ponteReact("importacao-planilhas", [
    "inicializarExportacaoAutomaticaHistorico", "inicializarArquivosAtualizacaoPlanilhas", "enviarModeloLocal",
    "previsualizarPlanilhas", "enviarPlanilhas", "exportarEquipamentosAtualizados",
  ]);

  const registrar = promessa => promessa.catch(erro => { console.error(erro); });
  const ponteRegistrada = Object.fromEntries(Object.entries(ponte).map(([nome, acao]) => [
    nome, (...argumentos) => registrar(acao(...argumentos)),
  ]));
  return { ...ponteSincrona, ...ponteRegistrada };
});
