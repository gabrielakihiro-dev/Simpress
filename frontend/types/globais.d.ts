// Globais que os scripts de frontend/src/legado e as pontes de frontend/src/comum e frontend/src/ui publicam ou leem em window.
// Só para o `tsc --project tsconfig.ui.json` (checkJs, sem emitir) e para o tsconfig.json. Script global: sem import/export.
// Tipadas como `any` por enquanto; as pontes de comum/ e ui/ saem na react-final-3, quando app.js virar TS.

// Bibliotecas externas (static/vendor).
declare var lucide: any;

// Autosave das anotações (frontend/src/comum/history-annotation-autosave.ts); lido pelo painel resultado-comparacao.
declare var HistoryAnnotationAutosave: any;

// Módulos Simpress* (cada arquivo publica o seu em window).
declare var SimpressAccessibleDialogs: any;
declare var SimpressActionDispatcher: any;
declare var SimpressApiErrors: any;
declare var SimpressApiFetch: any;
declare var SimpressApp: any;
declare var SimpressBento: any;
declare var SimpressCatalogSearch: any;
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
declare var SimpressTransferUtils: any;
declare var SimpressUxEnhancements: any;

// Funções de frontend/src/aplicacao lidas pelos scripts de ui.
declare var cancelarDadosCadastrais: any;
