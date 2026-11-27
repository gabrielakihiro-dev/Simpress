// Gerado por scripts/gerar_tipos_api.py a partir do OpenAPI do FastAPI. Não edite à mão:
// rode `python scripts/gerar_tipos_api.py` depois de mudar uma rota ou um modelo pydantic.

export type AgendamentoDashboardPayload = {
  "ativo": boolean;
  "intervalo_minutos"?: 30 | 60 | 90 | 120 | null;
};

export type AgendamentoDashboardResumo = {
  "bloqueio": unknown;
  "ativo": boolean;
  "intervalo_minutos": number;
  "proxima_execucao": unknown;
  "ultimo_disparo": unknown;
  "aviso": string;
};

export type AgendamentoPayload = {
  "ativo": boolean;
};

export type AgendamentoSebraeInfo = {
  "ativo": boolean;
  "pronta": unknown;
  "horario": string;
  "fuso": string;
  "proxima_execucao": string | null;
  "ultimo_disparo": Record<string, unknown> | null;
  "aviso": string;
};

export type ApelidoUndoPayload = {
  "evento_id": string;
};

export type ApelidoUpdatePayload = {
  "serial": string;
  "apelido": string;
};

export type AssistentePayload = {
  "openrouter_api_key"?: string | null;
  "deepseek_api_key"?: string | null;
};

export type AtualizarLembretePayload = {
  "descricao"?: string | null;
  "concluido"?: boolean | null;
  "data_agendada"?: string | null;
  "hora_agendada"?: string | null;
};

export type AtualizarModeloPayload = {
  "nome"?: string | null;
  "conta"?: string | null;
  "para"?: string | null;
  "cc"?: string | null;
  "assunto"?: string | null;
  "corpo"?: string | null;
};

export type AtualizarPayload = {
  "chamados"?: ChamadoManual[];
  "edicoes"?: ChamadoManual[];
  "versao_importacao"?: string;
  "finalizar_softexpert"?: boolean;
  "enviar_sharepoint"?: boolean;
  "confirmar_outro_tecnico"?: string[];
};

export type BloqueioCobertura = {
  "serie": unknown;
  "motivo": string;
  "id": string;
};

export type Body_anexar_pdf_api_sebrae_chamados__numero__anexo_post = {
  "file": Blob;
};

export type Body_atualizar_planilhas_endpoint_api_planilhas_atualizar_post = {
  "endpoint_file": Blob;
  "details_file": Blob;
  "preview_token": string;
};

export type Body_import_file_api_usuarios_entra_importar_post = {
  "file": Blob;
};

export type Body_import_model_api_modelos__tipo__importar_post = {
  "file": Blob;
};

export type Body_import_ticket_workbooks_api_operacoes_chamados_importar_post = {
  "simpress_file": Blob;
  "oracle_file": Blob;
};

export type Body_importar_dashboard_api_sebrae_dashboard_post = {
  "file": Blob;
};

export type Body_previsualizar_planilhas_endpoint_api_planilhas_previsualizar_post = {
  "endpoint_file": Blob;
  "details_file": Blob;
};

export type BuscaWebPayload = {
  "ativa": boolean;
};

export type CancelamentoAutomacao = {
  "metodo"?: string;
  "mensagem"?: string;
  "estado"?: EstadoAutomacao | null;
};

export type CancelarControleRemotoPayload = {
  "pedido": string;
};

export type CancelarPayload = {
  "session_id": string;
};

export type CapturaAutomacao = {
  "nome"?: string;
  "url"?: string;
};

export type CasoCobertura = {
  "secao": string;
  "arquivado": boolean;
  "registro": RegistroCobertura;
};

export type CasosCobertura = {
  "disponibilidade"?: Record<string, DisponibilidadeCaso>;
  "demandas"?: Record<string, RegistroCobertura>;
  "devolucoes"?: Record<string, DevolucaoCaso>;
  "reservas"?: Record<string, ReservaCaso>;
  "movimentacoes"?: Record<string, RegistroCobertura>;
  "vinculos"?: Record<string, RegistroCobertura>;
  "rejeicoes"?: Record<string, RegistroCobertura>;
};

export type ChamadoManual = {
  "numero": string;
  "A"?: string;
  "B"?: string;
  "D"?: string;
  "J"?: string;
  "R"?: string;
  "S"?: string;
  "G"?: string;
};

export type ClienteConfigPayload = {
  "contrato"?: string;
  "cnpj_faturamento"?: string;
  "series_sebrae_fora"?: string[] | null;
};

export type Cobertura = {
  "hoje": string;
  "vagas": VagaCobertura[];
  "contagens": ContagensCobertura;
  "disponiveis": DisponivelCobertura[];
  "bloqueios": BloqueioCobertura[];
  "reservas_vencidas": string[];
  "manutencao": ManutencaoCobertura;
  "sinais": Record<string, unknown>[];
  "casos": CasosCobertura;
  "equipamentos"?: Record<string, EquipamentoCobertura>;
};

export type CodigoPowerShellPayload = {
  "id"?: string | null;
  "titulo": string;
  "modo": string;
  "comando": string;
};

export type CodigosPowerShellPayload = {
  "codigos": CodigoPowerShellPayload[];
};

export type ComparisonAnnotationPayload = {
  "anotacao": string;
  "revisao_id"?: string | null;
  "base_revisoes"?: string[];
  "resolver_conflito"?: boolean;
};

export type ComparisonRestorePayload = {
  "preview_token": string;
};

export type ConflitosPayload = {
  "escolhas": Record<string, "sharepoint" | "site">;
  "enviar"?: boolean;
  "versao_importacao"?: string;
};

export type ConsultaEndpointPayload = {
  "serial": string;
};

export type ContagensCobertura = {
  "atendivel": number;
  "condicionada": number;
  "sem_cobertura": number;
  "entregue": number;
};

export type ContasPayload = {
  "conta_simpress"?: string;
  "conta_sebrae"?: string;
  "usuario_endpoint"?: string;
  "usar_no_outlook_simpress"?: boolean | null;
  "usar_no_outlook_sebrae"?: boolean | null;
  "links"?: Record<string, string>;
};

export type ContatoOrigemPayload = {
  "contato"?: string;
  "email"?: string;
  "telefone"?: string;
};

export type ContextoUXPayload = {
  "serial": string;
  "descricao": string;
  "revisao": number;
};

export type ControleRemotoPayload = {
  "serial": string;
  "pedido"?: string | null;
};

export type DemandaPayload = {
  "data": string;
  "cidade": string;
  "quantidade": number;
  "perfil"?: string;
  "monitor"?: boolean;
  "observacao"?: string;
};

export type DescricaoEditadaPayload = {
  "descricao"?: string;
};

export type DescricaoPayload = {
  "descricao_finalizacao"?: string;
};

export type DesfazerOutroTecnicoPayload = {
  "numero": string;
  "confirmado"?: boolean;
};

export type DestaquePayload = {
  "destaque": boolean;
};

export type DevolucaoCaso = {
  "rev": number;
  "situacao": string;
};

export type DevolucaoPayload = {
  "serie": string;
  "data_prevista": string;
  "cidade"?: string | null;
  "observacao"?: string;
};

export type DisponibilidadeCaso = {
  "rev": number;
  "estado_efetivo": string;
};

export type DisponibilidadePayload = {
  "serie": string;
  "estado": "disponivel" | "em_manutencao" | "indisponivel";
  "cidade"?: string | null;
  "rev"?: number | null;
};

export type DisponivelCobertura = {
  "serie": unknown;
  "cidade": unknown;
  "confirmada_em": unknown;
  "valida_ate": unknown;
  "sinal": string | null;
};

export type DivergenciaPayload = {
  "tipo": "serie_diferente" | "item_faltando" | "avaria";
  "descricao"?: string;
  "serie_recebida"?: string | null;
};

export type EnviarEmailPayload = {
  "conta": string;
  "para"?: string;
  "cc"?: string;
  "assunto"?: string;
  "corpo"?: string;
  "nome"?: string;
  "setor"?: string;
  "modo": "abrir" | "enviar";
  "confirmado"?: boolean;
};

export type EnviarPayload = {
  "serial": string;
  "session_id": string;
  "solicitante"?: SolicitantePayload | null;
  "problema": string;
  "descricao": string;
  "enviar"?: boolean;
  "confirmado"?: boolean;
};

export type EnviarTicketPayload = {
  "serial": string;
  "session_id": string;
  "descricao": string;
  "solicitante": SolicitanteTicketPayload;
  "chamado_interno"?: string;
  "enviar"?: boolean;
  "confirmado"?: boolean;
};

export type EquipamentoCobertura = {
  "modelo": string;
  "tipo": string;
};

export type EquipamentoPublico = {
  "serial"?: unknown;
  "modelo"?: unknown;
  "tipo"?: unknown;
  "apelido"?: unknown;
  "idCliente"?: unknown;
  "revisao"?: unknown;
};

export type EquipamentoSalvo = {
  "sucesso": boolean;
  "mensagem": string;
  "equipamento": EquipamentoPublico;
  "total_modificados": number;
};

export type EquipamentoUpdatePayload = {
  "serial": string;
  "novo"?: boolean;
  "modelo"?: string | null;
  "tipo"?: string | null;
  "apelido"?: string | null;
  "idCliente"?: string | null;
  "revisao"?: string | null;
  "endereco"?: string | null;
  "cidade"?: string | null;
  "uf"?: string | null;
  "cep"?: string | null;
  "cnpj_instalacao"?: string | null;
};

export type EscolherEnderecoPayload = {
  "serial": string;
  "session_id": string;
  "endereco": string;
};

export type EstadoAutomacao = {
  "estado"?: string;
  "rotina"?: unknown;
  "inicio"?: unknown;
  "origem"?: unknown;
  "pid"?: unknown;
  "cancelamento_pedido"?: unknown;
  "aguardando_login"?: unknown;
  "login_origem"?: string;
  "log"?: LogParcialAutomacao | null;
  "ultima"?: ExecucaoAutomacao | null;
};

export type EstadoMovimentacaoPayload = {
  "estado": "coletada" | "em_transito" | "recebida" | "recebida_com_divergencia" | "cancelada";
  "rev": number;
  "recebido_por"?: string | null;
  "data"?: string | null;
  "comprovante"?: string | null;
  "divergencia"?: DivergenciaPayload | null;
};

export type ExecucaoAutomacao = {
  "id"?: string;
  "rotina"?: string;
  "origem"?: unknown;
  "inicio"?: unknown;
  "fim"?: unknown;
  "status"?: string;
  "codigo"?: unknown;
  "mensagem"?: string;
  "lotes"?: LoteAutomacao[];
  "capturas"?: CapturaAutomacao[];
  "log"?: string;
};

export type ExportarPayload = {
  "chamados": ChamadoManual[];
};

export type FichaPayload = {
  "ficha": Record<string, unknown>;
};

export type FinalizarPayload = {
  "numero": string;
  "versao_importacao"?: string;
  "confirmado"?: boolean;
  "encerramento"?: string;
  "chamados"?: ChamadoManual[];
  "edicoes"?: ChamadoManual[];
  "confirmar_outro_tecnico"?: boolean;
};

export type HTTPValidationError = {
  "detail"?: ValidationError[];
};

export type HistoricoAutomacao = {
  "execucoes": ExecucaoAutomacao[];
  "total": number;
  "pagina": number;
  "paginas": number;
  "limite": number;
};

export type HostnameRemovalPayload = {
  "serie": string;
  "hostname": string;
};

export type InstrucoesPayload = {
  "texto": string;
};

export type KitPayload = {
  "item": "notebook" | "carregador" | "monitor" | "preparacao";
  "marcado": boolean;
  "rev": number;
};

export type Lembrete = {
  "id": string;
  "descricao": string;
  "criado_em": string;
  "alterado_em": string | null;
  "concluido": boolean;
  "concluido_em": string | null;
  "origem": string | null;
  "termo": Record<string, unknown> | null;
  "data_agendada": string | null;
  "hora_agendada": string | null;
};

export type LembretesReagendados = {
  "lembretes": Lembrete[];
  "reagendados": number;
};

export type LinkEndpoint = {
  "url": string;
};

export type ListaLembretes = {
  "lembretes": Lembrete[];
};

export type ListaModelos = {
  "modelos": Record<string, ModeloSalvo>;
};

export type LogExecucaoAutomacao = {
  "execucao": ExecucaoAutomacao;
  "arquivo": string;
  "linhas": string[];
  "limitado": boolean;
};

export type LogParcialAutomacao = {
  "arquivo"?: string;
  "offset"?: unknown;
  "linhas"?: string[];
  "reiniciado"?: unknown;
};

export type LoteAutomacao = {
  "id"?: string;
  "status"?: string;
};

export type ManualAliasConflictResolutionPayload = {
  "acao": string;
};

export type ManualPersonNamePayload = {
  "serial": string;
  "login_atual"?: string;
  "nome"?: string;
};

export type ManutencaoCobertura = {
  "verificada": boolean;
  "aviso": string;
};

export type MensagemPayload = {
  "texto": string;
  "contexto_ux"?: ContextoUXPayload | null;
};

export type ModeloSalvo = {
  "rotulo"?: string;
  "texto"?: string;
};

export type MovimentacaoPayload = {
  "reserva_id": string;
  "rev": number;
  "tipo"?: "transporte" | "local";
};

export type MovimentacaoPreparada = {
  "id": unknown;
  "serie": unknown;
  "destino_cidade": unknown;
  "chave": unknown;
  "rev": number;
};

export type NotaPayload = {
  "concluida": boolean;
};

export type NovoLembretePayload = {
  "descricao": string;
  "origem"?: string | null;
  "data_agendada"?: string | null;
  "hora_agendada"?: string | null;
  "termo"?: unknown;
};

export type NovoModeloPayload = {
  "nome"?: string | null;
  "copiar_de"?: string | null;
};

export type ObservacaoPayload = {
  "observacao"?: string;
};

export type OsMarcaPayload = {
  "serie": string;
  "os": string;
  "chamado": string;
  "acao": string;
};

export type OsObservacaoPayload = {
  "serie": string;
  "os": string;
  "observacao"?: string;
};

export type OsRecusadaPayload = {
  "os": string;
};

export type PainelResposta = {
  "base_importada"?: unknown;
  "total_equipamentos"?: unknown;
  "total_unidades"?: unknown;
  "por_categoria"?: Record<string, unknown>[];
  "sem_categoria"?: unknown;
  "cidades_principais"?: Record<string, unknown>[];
  "cidades_por_categoria"?: Record<string, Record<string, unknown>[]>;
  "total_cidades"?: unknown;
  "sem_cidade"?: unknown;
  "ultima_atualizacao"?: unknown;
  "arquivo_origem"?: unknown;
  "ultima_comparacao"?: Record<string, unknown> | null;
  "base_desatualizada"?: Record<string, unknown> | null;
  "os_paradas"?: Record<string, unknown> | null;
  "chamados_outro_tecnico"?: Record<string, unknown> | null;
  "falhas_finalizacao_softexpert"?: Record<string, unknown> | null;
  "divergencias_novas"?: unknown;
  "sem_acesso_60_dias"?: unknown;
  "backups_regionais"?: Record<string, unknown> | null;
  "lembretes_agendados"?: Record<string, unknown> | null;
};

export type PendenciaSebrae = {
  "numero": string;
  "motivo": string;
};

export type PendenciaUsuarioPayload = {
  "decisao": string;
};

export type PowerShellPayload = {
  "hostname": string;
  "modo": "sistema" | "usuario";
  "comando": string;
  "usuario"?: string | null;
};

export type PrepararAlterarEnderecoPayload = {
  "serial": string;
  "conferido"?: boolean;
};

export type PrepararPayload = {
  "serial": string;
  "conferido"?: boolean;
};

export type PrepararTicketPayload = {
  "serial": string;
  "descricao_equipamento"?: string;
  "razao_social"?: string;
  "contrato"?: string;
  "retirada_cidade"?: string;
  "retirada_cnpj"?: string;
  "retirada_endereco"?: string;
  "retirada_horario"?: string;
  "retirada_almoco"?: string;
  "retirada_pausa_duracao"?: string;
  "retirada_tipo_acesso"?: string;
  "retirada_acesso_obs"?: string;
  "retirada_contato"?: string;
  "retirada_email"?: string;
  "retirada_telefone"?: string;
  "retirada_obs"?: string;
  "retirada_voltagem"?: string;
  "entrega_cidade"?: string;
  "entrega_cnpj": string;
  "entrega_endereco": string;
  "entrega_horario"?: string;
  "entrega_almoco"?: string;
  "entrega_pausa_duracao"?: string;
  "entrega_tipo_acesso"?: string;
  "entrega_acesso_obs"?: string;
  "entrega_contato": string;
  "entrega_email"?: string;
  "entrega_telefone"?: string;
  "entrega_obs"?: string;
  "entrega_voltagem"?: string;
  "entrega_cep": string;
  "conferido"?: boolean;
};

export type RecuperacaoEnvioPayload = {
  "envio_id": string;
  "acao": "limpar" | "confirmar_recebimento" | "declarar_nao_enviado" | "concluir_legado";
  "confirmacao"?: string;
};

export type ReenvioSnapshotPayload = {
  "envio_id": string;
  "sha256": string;
  "confirmado"?: boolean;
};

export type RegistrarTransferenciaPayload = {
  "payload": TransferenciaPayload;
  "chave": string;
  "rev": number;
};

export type RegistroCobertura = {
  "rev": number;
};

export type RepresentanteRegionalPayload = {
  "nome"?: string;
  "email"?: string;
  "telefone"?: string;
  "horario"?: string;
  "almoco"?: string;
  "pausaDuracao"?: string;
};

export type ReprogramarPayload = {
  "rev": number;
  "data_prevista": string;
};

export type ReservaCaso = {
  "rev": number;
  "vencida": boolean;
  "kit_pronto": boolean;
};

export type ReservaPayload = {
  "demanda_id": string;
  "serie"?: string | null;
  "devolucao_id"?: string | null;
  "manutencao_conferida"?: boolean;
};

export type ResolverDivergenciaPayload = {
  "resolucao": "aceitar" | "corrigir" | "cancelar";
  "serie_recebida"?: string | null;
  "rev": number;
};

export type ResolverPayload = {
  "tokens": string[];
};

export type ResumoSebrae = {
  "agendamento": AgendamentoSebraeInfo;
  "ultima_execucao": Record<string, unknown> | null;
  "pendencias": PendenciaSebrae[];
  "login_necessario": boolean;
};

export type RevPayload = {
  "rev": number;
};

export type RotinaPayload = {
  "rotina": "os" | "inventarios" | "usuarios" | "ambas" | "login" | "sebrae" | "dashboard" | "enviar" | "fechar" | "antigos";
  "confirmado"?: boolean;
};

export type SalvarModeloPayload = {
  "rotulo": string;
  "texto": string;
};

export type SolicitantePayload = {
  "nome": string;
  "email": string;
  "telefone": string;
  "departamento_cargo": string;
};

export type SolicitanteTicketPayload = {
  "nome": string;
  "email": string;
  "telefone": string;
};

export type TicketExportPayload = {
  "snapshot_id"?: string;
  "series": string[];
  "search"?: string;
  "relation"?: string;
  "attention_only"?: boolean;
};

export type TicketOsLinkPayload = {
  "fonte": "simpress" | "oracle";
  "serie": string;
  "os": string;
  "ano": number;
  "numero"?: string;
};

export type TicketTimelineAnnotationPayload = {
  "anotacao": string;
  "revisao_id"?: string | null;
  "base_revisoes"?: string[];
  "resolver_conflito"?: boolean;
};

export type TransferenciaPayload = {
  "serial": string;
  "descricao_equipamento"?: string;
  "razao_social"?: string;
  "contrato"?: string;
  "retirada_cidade"?: string;
  "retirada_cnpj"?: string;
  "retirada_endereco"?: string;
  "retirada_horario"?: string;
  "retirada_almoco"?: string;
  "retirada_pausa_duracao"?: string;
  "retirada_tipo_acesso"?: string;
  "retirada_acesso_obs"?: string;
  "retirada_contato"?: string;
  "retirada_email"?: string;
  "retirada_telefone"?: string;
  "retirada_obs"?: string;
  "retirada_voltagem"?: string;
  "entrega_cidade"?: string;
  "entrega_cnpj": string;
  "entrega_endereco": string;
  "entrega_horario"?: string;
  "entrega_almoco"?: string;
  "entrega_pausa_duracao"?: string;
  "entrega_tipo_acesso"?: string;
  "entrega_acesso_obs"?: string;
  "entrega_contato": string;
  "entrega_email"?: string;
  "entrega_telefone"?: string;
  "entrega_obs"?: string;
  "entrega_voltagem"?: string;
};

export type TransferenciaRegistrada = {
  "movimentacao": RegistroCobertura;
  "historico_id": unknown;
  "transferencia": unknown;
  "repetido": boolean;
};

export type UltimasAutomacao = {
  "ultimas": Record<string, ExecucaoAutomacao | null>;
};

export type UnidadePayload = {
  "id"?: number | null;
  "cidade": string;
  "endereco": string;
  "uf"?: string | null;
  "cep"?: string;
  "cnpj": string;
};

export type UsuarioUpdatePayload = {
  "serial": string;
  "usuario"?: string;
};

export type UsuariosConsultaPayload = {
  "series"?: string[];
};

export type VagaCobertura = {
  "id": string;
  "demanda_id": unknown;
  "indice": number;
  "data": unknown;
  "cidade": unknown;
  "perfil": unknown;
  "monitor": boolean;
  "situacao": string;
  "serie": unknown;
  "reserva_id": unknown;
  "devolucao_id": unknown;
  "movimentacao_id"?: unknown;
  "selos": string[];
  "motivo": string | null;
};

export type ValidationError = {
  "loc": (string | number)[];
  "msg": string;
  "type": string;
  "input"?: unknown;
  "ctx"?: Record<string, unknown>;
};

export type VincularHistoricoPayload = {
  "historico_id": string;
  "rev": number;
};

export type routers__assistant__ConfirmacaoPayload = {
  "confirmado": boolean;
  "contexto_ux"?: ContextoUXPayload | null;
};

export type routers__backups_regionais__ConfirmacaoPayload = {
  "serie": string;
  "cidade": string;
};

/** Cada rota da API: parâmetros de consulta (?a=b), corpo enviado e resposta. */

export interface Rotas {
  "GET /": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assinatura-tecnico": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/assistente/anexo": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/assistente/anexo/{anexo_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/anexos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/assistente/audio": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/busca-web": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/assistente/busca-web": {
    consulta: never;
    corpo: BuscaWebPayload;
    resposta: unknown;
  };
  "POST /api/assistente/confirmar": {
    consulta: never;
    corpo: routers__assistant__ConfirmacaoPayload;
    resposta: unknown;
  };
  "GET /api/assistente/conversas": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/conversas/{conversa_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/assistente/conversas/{conversa_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/estado": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/instrucoes": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/assistente/instrucoes": {
    consulta: never;
    corpo: InstrucoesPayload;
    resposta: unknown;
  };
  "POST /api/assistente/limpar": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/assistente/mensagem": {
    consulta: never;
    corpo: MensagemPayload;
    resposta: unknown;
  };
  "GET /api/assistente/notas": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PATCH /api/assistente/notas/{nota_id}": {
    consulta: never;
    corpo: NotaPayload;
    resposta: unknown;
  };
  "DELETE /api/assistente/notas/{nota_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/assistente/relatorio/{relatorio_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/automacao/cancelar": {
    consulta: never;
    corpo: never;
    resposta: CancelamentoAutomacao;
  };
  "GET /api/automacao/capturas/{nome}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/automacao/dashboard/agendamento": {
    consulta: never;
    corpo: never;
    resposta: AgendamentoDashboardResumo;
  };
  "PUT /api/automacao/dashboard/agendamento": {
    consulta: never;
    corpo: AgendamentoDashboardPayload;
    resposta: AgendamentoDashboardResumo;
  };
  "GET /api/automacao/estado": {
    consulta: { "offset"?: number; "arquivo"?: string; };
    corpo: never;
    resposta: EstadoAutomacao;
  };
  "GET /api/automacao/execucoes/{execucao_id}/log": {
    consulta: { "linhas"?: number; };
    corpo: never;
    resposta: LogExecucaoAutomacao;
  };
  "POST /api/automacao/executar": {
    consulta: never;
    corpo: RotinaPayload;
    resposta: EstadoAutomacao;
  };
  "GET /api/automacao/historico": {
    consulta: { "limite"?: number; "pagina"?: number; "data_inicio"?: string | null; "data_fim"?: string | null; "rotina"?: "os" | "inventarios" | "usuarios" | "ambas" | "login" | "sebrae" | "dashboard" | "enviar" | "fechar" | "antigos" | "ux_apelidos" | null; "status"?: "em_andamento" | "concluido" | "falha" | "cancelado" | "ocupada" | "interrompido" | null; };
    corpo: never;
    resposta: HistoricoAutomacao;
  };
  "GET /api/automacao/historico/ultimas": {
    consulta: { "rotina": ("os" | "inventarios" | "usuarios" | "ambas" | "login" | "sebrae" | "dashboard" | "enviar" | "fechar" | "antigos" | "ux_apelidos")[]; };
    corpo: never;
    resposta: UltimasAutomacao;
  };
  "PUT /api/automacao/sebrae/agendamento": {
    consulta: never;
    corpo: AgendamentoPayload;
    resposta: ResumoSebrae;
  };
  "GET /api/automacao/sebrae/resumo": {
    consulta: never;
    corpo: never;
    resposta: ResumoSebrae;
  };
  "POST /api/automacao/ux-apelidos": {
    consulta: never;
    corpo: never;
    resposta: EstadoAutomacao;
  };
  "POST /api/backups-regionais/confirmar": {
    consulta: never;
    corpo: routers__backups_regionais__ConfirmacaoPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/backups-regionais/desfazer": {
    consulta: never;
    corpo: routers__backups_regionais__ConfirmacaoPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/backups-regionais/excluir": {
    consulta: never;
    corpo: routers__backups_regionais__ConfirmacaoPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/backups-regionais/manter": {
    consulta: never;
    corpo: routers__backups_regionais__ConfirmacaoPayload;
    resposta: Record<string, unknown>;
  };
  "GET /api/buscar": {
    consulta: { "q": string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/buscar-expandida": {
    consulta: { "q"?: string; "offset"?: number; "limit"?: number; "categoria"?: string | null; "tipo"?: string | null; "cidade"?: string | null; "usuario"?: string | null; "serie"?: string[] | null; "include_filters"?: boolean; "listar_todos"?: boolean; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/cobertura": {
    consulta: never;
    corpo: never;
    resposta: Cobertura;
  };
  "GET /api/cobertura/casos/{caso_id}": {
    consulta: never;
    corpo: never;
    resposta: CasoCobertura;
  };
  "POST /api/cobertura/demandas": {
    consulta: never;
    corpo: DemandaPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/demandas/{demanda_id}/cancelar": {
    consulta: never;
    corpo: RevPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/devolucoes": {
    consulta: never;
    corpo: DevolucaoPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/devolucoes/{devolucao_id}/cancelar": {
    consulta: never;
    corpo: RevPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/devolucoes/{devolucao_id}/receber": {
    consulta: never;
    corpo: RevPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/devolucoes/{devolucao_id}/reprogramar": {
    consulta: never;
    corpo: ReprogramarPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/disponibilidade": {
    consulta: never;
    corpo: DisponibilidadePayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/movimentacoes": {
    consulta: never;
    corpo: MovimentacaoPayload;
    resposta: MovimentacaoPreparada;
  };
  "POST /api/cobertura/movimentacoes/{movimentacao_id}/estado": {
    consulta: never;
    corpo: EstadoMovimentacaoPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/movimentacoes/{movimentacao_id}/registrar-transferencia": {
    consulta: never;
    corpo: RegistrarTransferenciaPayload;
    resposta: TransferenciaRegistrada;
  };
  "POST /api/cobertura/movimentacoes/{movimentacao_id}/resolver-divergencia": {
    consulta: never;
    corpo: ResolverDivergenciaPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/movimentacoes/{movimentacao_id}/vincular-historico": {
    consulta: never;
    corpo: VincularHistoricoPayload;
    resposta: TransferenciaRegistrada;
  };
  "POST /api/cobertura/reservas": {
    consulta: never;
    corpo: ReservaPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/reservas/{reserva_id}/cancelar": {
    consulta: never;
    corpo: RevPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/reservas/{reserva_id}/kit": {
    consulta: never;
    corpo: KitPayload;
    resposta: RegistroCobertura;
  };
  "POST /api/cobertura/reservas/{reserva_id}/renovar": {
    consulta: never;
    corpo: RevPayload;
    resposta: RegistroCobertura;
  };
  "GET /api/config/cliente": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/config/cliente": {
    consulta: never;
    corpo: ClienteConfigPayload;
    resposta: unknown;
  };
  "GET /api/config/local": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/config/local/assistente": {
    consulta: never;
    corpo: AssistentePayload;
    resposta: unknown;
  };
  "DELETE /api/config/local/assistente/{chave}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/config/local/contas": {
    consulta: never;
    corpo: ContasPayload;
    resposta: unknown;
  };
  "GET /api/config/local/endpoint/{tela}": {
    consulta: never;
    corpo: never;
    resposta: LinkEndpoint;
  };
  "GET /api/config/representantes-regionais": {
    consulta: never;
    corpo: never;
    resposta: Record<string, unknown>;
  };
  "PUT /api/config/representantes-regionais/{cidade}": {
    consulta: never;
    corpo: RepresentanteRegionalPayload;
    resposta: Record<string, unknown>;
  };
  "DELETE /api/config/representantes-regionais/{cidade}": {
    consulta: never;
    corpo: never;
    resposta: Record<string, unknown>;
  };
  "GET /api/config/transferencia": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/config/transferencia/contato-origem": {
    consulta: never;
    corpo: ContatoOrigemPayload;
    resposta: unknown;
  };
  "POST /api/endpoint/consultar": {
    consulta: never;
    corpo: ConsultaEndpointPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/endpoint/controle-remoto": {
    consulta: never;
    corpo: ControleRemotoPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/endpoint/controle-remoto/cancelar": {
    consulta: never;
    corpo: CancelarControleRemotoPayload;
    resposta: Record<string, unknown>;
  };
  "GET /api/endpoint/hostnames-removidos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/endpoint/hostnames-removidos": {
    consulta: never;
    corpo: HostnameRemovalPayload;
    resposta: unknown;
  };
  "POST /api/endpoint/hostnames-removidos/restaurar": {
    consulta: never;
    corpo: HostnameRemovalPayload;
    resposta: unknown;
  };
  "POST /api/endpoint/powershell": {
    consulta: never;
    corpo: PowerShellPayload;
    resposta: Record<string, unknown>;
  };
  "GET /api/endpoint/powershell/codigos": {
    consulta: never;
    corpo: never;
    resposta: Record<string, unknown>;
  };
  "PUT /api/endpoint/powershell/codigos": {
    consulta: never;
    corpo: CodigosPowerShellPayload;
    resposta: Record<string, unknown>;
  };
  "POST /api/equipamento/apelido/desfazer": {
    consulta: never;
    corpo: ApelidoUndoPayload;
    resposta: unknown;
  };
  "GET /api/equipamento/apelidos-modificados": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/equipamento/atualizar-apelido": {
    consulta: never;
    corpo: ApelidoUpdatePayload;
    resposta: unknown;
  };
  "POST /api/equipamento/atualizar-usuario": {
    consulta: never;
    corpo: UsuarioUpdatePayload;
    resposta: unknown;
  };
  "POST /api/equipamento/nome-pessoa": {
    consulta: never;
    corpo: ManualPersonNamePayload;
    resposta: unknown;
  };
  "POST /api/equipamento/salvar": {
    consulta: never;
    corpo: EquipamentoUpdatePayload;
    resposta: EquipamentoSalvo;
  };
  "GET /api/equipamento/{serial}": {
    consulta: never;
    corpo: never;
    resposta: EquipamentoPublico;
  };
  "GET /api/equipamento/{serial}/dossie": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/equipamentos/usuarios-logados": {
    consulta: never;
    corpo: UsuariosConsultaPayload;
    resposta: unknown;
  };
  "GET /api/exportar-equipamentos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/gerar-planilha": {
    consulta: never;
    corpo: TransferenciaPayload;
    resposta: unknown;
  };
  "GET /api/historico-alteracoes": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/historico-alteracoes/{evento_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/historico-apelidos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/historico-apelidos/{evento_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/historico-comparacoes": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/historico-comparacoes/exportar/excel": {
    consulta: { "data": string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/historico-comparacoes/{evento_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/historico-comparacoes/{evento_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/historico-comparacoes/{evento_id}/anotacoes/{item_id}": {
    consulta: never;
    corpo: ComparisonAnnotationPayload;
    resposta: unknown;
  };
  "POST /api/historico-comparacoes/{evento_id}/apelido-manual/{serial}": {
    consulta: never;
    corpo: ManualAliasConflictResolutionPayload;
    resposta: unknown;
  };
  "GET /api/historico-comparacoes/{evento_id}/restauracao": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/historico-comparacoes/{evento_id}/restaurar": {
    consulta: never;
    corpo: ComparisonRestorePayload;
    resposta: unknown;
  };
  "GET /api/historico-transferencias": {
    consulta: { "limite"?: number; "busca"?: string; };
    corpo: never;
    resposta: unknown;
  };
  "POST /api/historico-transferencias": {
    consulta: never;
    corpo: TransferenciaPayload;
    resposta: unknown;
  };
  "GET /api/lembretes": {
    consulta: never;
    corpo: never;
    resposta: ListaLembretes;
  };
  "POST /api/lembretes": {
    consulta: never;
    corpo: NovoLembretePayload;
    resposta: Lembrete;
  };
  "POST /api/lembretes/reagendar-atrasados": {
    consulta: never;
    corpo: never;
    resposta: LembretesReagendados;
  };
  "PATCH /api/lembretes/{lembrete_id}": {
    consulta: never;
    corpo: AtualizarLembretePayload;
    resposta: Lembrete;
  };
  "DELETE /api/lembretes/{lembrete_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/modelos-chamado": {
    consulta: never;
    corpo: never;
    resposta: ListaModelos;
  };
  "PUT /api/modelos-chamado/{slug}": {
    consulta: never;
    corpo: SalvarModeloPayload;
    resposta: ListaModelos;
  };
  "POST /api/modelos/{tipo}/importar": {
    consulta: never;
    corpo: Body_import_model_api_modelos__tipo__importar_post;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/evolucao": {
    consulta: { "anterior": string; "atual": string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/exportar": {
    consulta: { "snapshot_id"?: string; "relation"?: string; "status"?: string; "queue"?: string; "city"?: string; "provider"?: string; "search"?: string; "stale_days"?: number; "age_filter"?: string; "attention_only"?: boolean; };
    corpo: never;
    resposta: unknown;
  };
  "POST /api/operacoes/chamados/exportar": {
    consulta: never;
    corpo: TicketExportPayload;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/historico": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "DELETE /api/operacoes/chamados/historico/antigas": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/operacoes/chamados/importar": {
    consulta: { "automatic_import_id"?: string | null; };
    corpo: Body_import_ticket_workbooks_api_operacoes_chamados_importar_post;
    resposta: unknown;
  };
  "PUT /api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id}": {
    consulta: never;
    corpo: TicketTimelineAnnotationPayload;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/linha-do-tempo/{serial}": {
    consulta: { "snapshot_id"?: string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/marcas-finalizacao": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/operacoes/chamados/marcas-finalizacao": {
    consulta: never;
    corpo: OsMarcaPayload;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/observacoes": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/operacoes/chamados/observacoes": {
    consulta: never;
    corpo: OsObservacaoPayload;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/snapshot/{snapshot_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/operacoes/chamados/vinculos-os": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/operacoes/chamados/vinculos-os": {
    consulta: never;
    corpo: TicketOsLinkPayload;
    resposta: unknown;
  };
  "GET /api/operacoes/evolucao": {
    consulta: { "anterior": string; "atual": string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/operacoes/pendencias": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/outlook/contatos": {
    consulta: { "q"?: string; };
    corpo: never;
    resposta: unknown;
  };
  "POST /api/outlook/contatos/resolver": {
    consulta: never;
    corpo: ResolverPayload;
    resposta: unknown;
  };
  "POST /api/outlook/email": {
    consulta: never;
    corpo: EnviarEmailPayload;
    resposta: unknown;
  };
  "GET /api/outlook/email/configuracao": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/outlook/email/modelos": {
    consulta: never;
    corpo: NovoModeloPayload;
    resposta: unknown;
  };
  "PUT /api/outlook/email/modelos/{modelo_id}": {
    consulta: never;
    corpo: AtualizarModeloPayload;
    resposta: unknown;
  };
  "DELETE /api/outlook/email/modelos/{modelo_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/outlook/email/modelos/{modelo_id}/restaurar": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/painel": {
    consulta: never;
    corpo: never;
    resposta: PainelResposta;
  };
  "POST /api/planilhas/atualizar": {
    consulta: never;
    corpo: Body_atualizar_planilhas_endpoint_api_planilhas_atualizar_post;
    resposta: unknown;
  };
  "POST /api/planilhas/previsualizar": {
    consulta: never;
    corpo: Body_previsualizar_planilhas_endpoint_api_planilhas_previsualizar_post;
    resposta: unknown;
  };
  "GET /api/prontidao": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/recarregar-base": {
    consulta: never;
    corpo: never;
    resposta: Record<string, unknown>;
  };
  "GET /api/relatorio-mensal": {
    consulta: { "mes": string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/relatorio-mensal/dados": {
    consulta: { "mes": string; };
    corpo: never;
    resposta: Record<string, unknown>;
  };
  "GET /api/sebrae/antigos/ler": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/antigos/ler": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/chamados/{numero}/anexo": {
    consulta: never;
    corpo: Body_anexar_pdf_api_sebrae_chamados__numero__anexo_post;
    resposta: unknown;
  };
  "DELETE /api/sebrae/chamados/{numero}/anexo": {
    consulta: { "somente_pendentes"?: boolean; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/sebrae/chamados/{numero}/credenciais": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/descricao": {
    consulta: never;
    corpo: DescricaoEditadaPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/destaque": {
    consulta: never;
    corpo: DestaquePayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/ficha": {
    consulta: never;
    corpo: FichaPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/finalizacao": {
    consulta: never;
    corpo: DescricaoPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/observacao": {
    consulta: never;
    corpo: ObservacaoPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/os-manter": {
    consulta: never;
    corpo: OsRecusadaPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/os-recusada": {
    consulta: never;
    corpo: OsRecusadaPayload;
    resposta: unknown;
  };
  "PUT /api/sebrae/chamados/{numero}/os-remover": {
    consulta: never;
    corpo: OsRecusadaPayload;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard": {
    consulta: { "automatico"?: boolean; };
    corpo: Body_importar_dashboard_api_sebrae_dashboard_post;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard/atualizar": {
    consulta: never;
    corpo: AtualizarPayload;
    resposta: unknown;
  };
  "GET /api/sebrae/dashboard/conflitos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard/conflitos": {
    consulta: never;
    corpo: ConflitosPayload;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard/envio/recuperar": {
    consulta: never;
    corpo: RecuperacaoEnvioPayload;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard/envio/reenviar-snapshot": {
    consulta: never;
    corpo: ReenvioSnapshotPayload;
    resposta: unknown;
  };
  "GET /api/sebrae/dashboard/envio/{envio_id}/snapshot": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/dashboard/pendente/reenviar": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/exportar": {
    consulta: never;
    corpo: ExportarPayload;
    resposta: unknown;
  };
  "POST /api/sebrae/finalizacao/desfazer-outro-tecnico": {
    consulta: never;
    corpo: DesfazerOutroTecnicoPayload;
    resposta: unknown;
  };
  "GET /api/sebrae/finalizar-softexpert": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/sebrae/finalizar-softexpert": {
    consulta: never;
    corpo: FinalizarPayload;
    resposta: unknown;
  };
  "GET /api/sebrae/historico": {
    consulta: { "limite"?: number; "pagina"?: number; "tipo"?: string; };
    corpo: never;
    resposta: unknown;
  };
  "GET /api/sebrae/historico/{entrada_id}": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/sebrae/novos": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/sebrae/observacoes": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/stats": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/unidade/salvar": {
    consulta: never;
    corpo: UnidadePayload;
    resposta: unknown;
  };
  "GET /api/unidades": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/usuarios-entra/estado": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "GET /api/usuarios-entra/exportar": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/usuarios-entra/importar": {
    consulta: never;
    corpo: Body_import_file_api_usuarios_entra_importar_post;
    resposta: unknown;
  };
  "GET /api/usuarios/pendencias": {
    consulta: never;
    corpo: never;
    resposta: unknown;
  };
  "POST /api/usuarios/pendencias/{pendencia_id}/decidir": {
    consulta: never;
    corpo: PendenciaUsuarioPayload;
    resposta: unknown;
  };
  "POST /api/ux/abrir-chamado/cancelar": {
    consulta: never;
    corpo: CancelarPayload;
    resposta: unknown;
  };
  "POST /api/ux/abrir-chamado/enviar": {
    consulta: never;
    corpo: EnviarPayload;
    resposta: unknown;
  };
  "POST /api/ux/abrir-chamado/preparar": {
    consulta: never;
    corpo: PrepararPayload;
    resposta: unknown;
  };
  "POST /api/ux/gerar-ticket/cancelar": {
    consulta: never;
    corpo: CancelarPayload;
    resposta: unknown;
  };
  "POST /api/ux/gerar-ticket/enviar": {
    consulta: never;
    corpo: EnviarTicketPayload;
    resposta: unknown;
  };
  "POST /api/ux/gerar-ticket/escolher-endereco": {
    consulta: never;
    corpo: EscolherEnderecoPayload;
    resposta: unknown;
  };
  "POST /api/ux/gerar-ticket/preparar": {
    consulta: never;
    corpo: PrepararTicketPayload;
    resposta: unknown;
  };
  "POST /api/ux/gerar-ticket/preparar-alterar-endereco": {
    consulta: never;
    corpo: PrepararAlterarEnderecoPayload;
    resposta: unknown;
  };
  "GET /api/ux/gerar-ticket/solicitante": {
    consulta: never;
    corpo: never;
    resposta: Record<string, string>;
  };
}
