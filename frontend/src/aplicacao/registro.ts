/**
 * Fábricas das features do cockpit, uma por nome (a ordem de publicação é a de FEATURE_ORDER em frontend/src/aplicacao/app.ts).
 * As 12 com regra própria têm arquivo próprio nesta pasta; as demais só encaminham para o painel React e saem da
 * tabela de pontes.ts.
 */
import { createAliasHistory } from "./alias-history.ts";
import { createShell } from "./app-shell.ts";
import { createBackupsRegionais } from "./backups-regionais.ts";
import { createCockpitChamados } from "./cockpit-chamados.ts";
import { createCockpitToolPanels } from "./cockpit-tool-panels.ts";
import { createComparisonHistory } from "./comparison-history.ts";
import { createComparisonResult } from "./comparison-result.ts";
import { createDashboard } from "./dashboard.ts";
import { createEquipmentDossier } from "./equipment-dossier.ts";
import { createFullEquipmentSearch } from "./full-equipment-search.ts";
import { criarPonte, NOMES_PONTES } from "./pontes.ts";
import { createUxChamados } from "./ux-chamados.ts";
import { createUxTicket } from "./ux-ticket.ts";
import type { Acoes, ContextoApp } from "./tipos.ts";

export type FabricaFeature = (context: ContextoApp) => Acoes;

const proprias: Record<string, FabricaFeature> = {
  shell: createShell,
  dashboard: createDashboard,
  backupsRegionais: createBackupsRegionais,
  cockpitToolPanels: createCockpitToolPanels,
  uxChamados: createUxChamados,
  uxTicket: createUxTicket,
  fullEquipmentSearch: createFullEquipmentSearch,
  comparisonResult: createComparisonResult,
  comparisonHistory: createComparisonHistory,
  cockpitChamados: createCockpitChamados,
  aliasHistory: createAliasHistory,
  equipmentDossier: createEquipmentDossier,
};

const encaminhadas: Record<string, FabricaFeature> = Object.fromEntries(
  NOMES_PONTES.map(nome => [nome, (context: ContextoApp) => criarPonte(nome, context)]),
);

export const fabricas: Record<string, FabricaFeature> = { ...proprias, ...encaminhadas };
