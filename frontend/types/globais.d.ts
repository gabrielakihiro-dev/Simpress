// Globais que os scripts de frontend/src/legado/shared e frontend/src/legado/ui publicam ou leem em window.
// Só para o `tsc --project tsconfig.ui.json` (checkJs, sem emitir). Script global: sem import/export.
// Tipadas como `any` por enquanto; ganham forma quando o módulo dono migrar para TypeScript.

// Bibliotecas externas (static/vendor).
declare var lucide: any;

// Autosave das anotações (frontend/src/legado/shared/history-annotation-autosave.js); lido pelo painel resultado-comparacao.
declare var HistoryAnnotationAutosave: any;

// Módulos Simpress* (cada arquivo publica o seu em window).
declare var SimpressAccessibleDialogs: any;
declare var SimpressActionDispatcher: any;
declare var SimpressApiErrors: any;
declare var SimpressApiFetch: any;
declare var SimpressApp: any;
declare var SimpressBento: any;
declare var SimpressCatalogSearch: any;
declare var SimpressChamadosOsModel: any;
declare var SimpressComparisonResultRenderer: any;
declare var SimpressCoberturaVinculo: any;
declare var SimpressCoverageModel: any;
declare var SimpressDataPanels: any;
declare var SimpressDomUtils: any;
declare var SimpressEquipmentSearchRenderers: any;
declare var SimpressFilePicker: any;
declare var SimpressFormDraftGuard: any;
declare var SimpressHistoryFormat: any;
declare var SimpressLoggedUserMarkers: any;
declare var SimpressMotion: any;
declare var SimpressNotifications: any;
declare var SimpressReact: any; // ações dos painéis React, publicadas por frontend/src/main.tsx
declare var SimpressRecentEquipment: any;
declare var SimpressSebraeDashboardModel: any;
declare var SimpressTransferHistory: any;
declare var SimpressTransferUtils: any;
declare var SimpressUxEnhancements: any;

// Funções de frontend/src/legado/features lidas pelos scripts de ui.
declare var cancelarDadosCadastrais: any;
