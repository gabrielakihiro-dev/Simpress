import { createRoot } from "react-dom/client";
import {
  adicionar, adicionarNoDia, alternar, alternarConcluidos, alternarPainelData, aoDigitar, aoMudarData, atalhoData, cancelarCriar,
  cancelarEdicao, cancelarExclusao, carregarLembretes, confirmarCriar, confirmarExclusao, criarDoTermo, editar, excluir, gerarPdfTermo,
  irParaDia, mudarSemana, preencherTermo, reagendarAtrasados, removerData, salvarEdicao, selecionarVista, teclaEdicao,
  teclaPainelData, teclaVista, verLembretes,
} from "./lembretes-acoes";
import { Painel } from "./painel";
import { gerarPdf, gerarPdfDoLembrete, limpar, preencherDoEquipamento, preencherDoLembrete, selecionarAba, teclaAba } from "./termos-acoes";

// Os nomes são os mesmos que as pontes de frontend/src/aplicacao/pontes.ts e o antigo lembretes.js já usavam em window.
export function montar(container: HTMLElement) {
  createRoot(container).render(<Painel />);
  return {
    termosSelecionarAba: selecionarAba,
    termosTeclaAba: teclaAba,
    termosGerarPdf: gerarPdf,
    termosLimpar: limpar,
    termosPreencherDoEquipamento: preencherDoEquipamento,
    termosGerarPdfDoLembrete: gerarPdfDoLembrete,
    termosPreencherDoLembrete: preencherDoLembrete,
    carregarLembretes,
    lembretesAdicionar: adicionar,
    lembretesAoDigitar: aoDigitar,
    lembretesAlternar: alternar,
    lembretesEditar: editar,
    lembretesCancelarEdicao: cancelarEdicao,
    lembretesTeclaEdicao: teclaEdicao,
    lembretesSalvarEdicao: salvarEdicao,
    lembretesAlternarConcluidos: alternarConcluidos,
    lembretesExcluir: excluir,
    lembretesCancelarExclusao: cancelarExclusao,
    lembretesConfirmarExclusao: confirmarExclusao,
    lembretesCriarDoTermo: criarDoTermo,
    lembretesCancelarCriar: cancelarCriar,
    lembretesConfirmarCriar: confirmarCriar,
    lembretesVerLembretes: verLembretes,
    lembretesSelecionarVista: selecionarVista,
    lembretesTeclaVista: teclaVista,
    lembretesMudarSemana: mudarSemana,
    lembretesIrParaDia: irParaDia,
    lembretesAdicionarNoDia: adicionarNoDia,
    lembretesReagendarAtrasados: reagendarAtrasados,
    lembretesAlternarPainelData: alternarPainelData,
    lembretesTeclaPainelData: teclaPainelData,
    lembretesAtalhoData: atalhoData,
    lembretesAoMudarData: aoMudarData,
    lembretesRemoverData: removerData,
    lembretesGerarPdfTermo: gerarPdfTermo,
    lembretesPreencherTermo: preencherTermo,
  };
}
