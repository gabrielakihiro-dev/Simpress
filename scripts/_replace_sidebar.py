"""Replace sidebar+header block in index.html with cockpit bar."""
import re
import pathlib

p = pathlib.Path("static/index.html")
html = p.read_text(encoding="utf-8")

pattern = r'<div id="simpress-app-shell"[^>]*>.*?</header>'

new_block = '''<div id="simpress-app-shell" class="simpress-app-shell cockpit-shell">
<header class="cockpit-bar" role="banner">
<div class="cockpit-bar__brand" aria-label="Simpress, gestão de equipamentos">
<span class="cockpit-bar__brand-mark" aria-hidden="true">S</span>
<strong class="cockpit-bar__brand-name">Simpress</strong>
</div>
<nav class="cockpit-bar__tabs app-tabs" role="tablist" aria-label="Navegação principal" data-on-keydown="controlarAbasTransferencia" data-args='["$event"]'>
<button type="button" id="tab-home" class="cockpit-tab app-tab is-active" role="tab" aria-selected="true" aria-controls="tab-panel-home" tabindex="0" data-on-click="ativarAbaTransferencia" data-args='["home"]' aria-label="Home" title="Home (F1)">
<i data-lucide="home" class="w-4 h-4" aria-hidden="true"></i>
<span>Home</span>
<kbd class="cockpit-tab__shortcut" aria-hidden="true">F1</kbd>
</button>
<button type="button" id="tab-retirada-entrega" class="cockpit-tab app-tab" role="tab" aria-selected="false" aria-controls="tab-panel-retirada-entrega" tabindex="-1" data-on-click="ativarAbaTransferencia" data-args='["transferencia"]' aria-label="Transporte" title="Transporte (F2)">
<i data-lucide="truck" class="w-4 h-4" aria-hidden="true"></i>
<span>Transporte</span>
<kbd class="cockpit-tab__shortcut" aria-hidden="true">F2</kbd>
</button>
<button type="button" id="tab-resumo" class="cockpit-tab app-tab" role="tab" aria-selected="false" aria-controls="tab-panel-resumo" tabindex="-1" data-on-click="ativarAbaTransferencia" data-args='["resumo"]' aria-label="Resumo" title="Resumo (F3)">
<i data-lucide="layout-dashboard" class="w-4 h-4" aria-hidden="true"></i>
<span>Resumo</span>
<kbd class="cockpit-tab__shortcut" aria-hidden="true">F3</kbd>
</button>
<button type="button" id="tab-automacao" class="cockpit-tab app-tab" role="tab" aria-selected="false" aria-controls="tab-panel-automacao" tabindex="-1" data-on-click="ativarAbaTransferencia" data-args='["automacao"]' aria-label="Automação" title="Automação (F4)">
<i data-lucide="terminal" class="w-4 h-4" aria-hidden="true"></i>
<span>Automação</span>
<kbd class="cockpit-tab__shortcut" aria-hidden="true">F4</kbd>
</button>
</nav>
<div class="cockpit-bar__spacer" aria-hidden="true"></div>
<div class="cockpit-bar__search">
<input
type="text"
id="input-serial"
aria-keyshortcuts="/ Control+K Meta+K"
role="combobox"
aria-label="Série, apelido, modelo, cidade ou nome do usuário do equipamento"
aria-autocomplete="list"
aria-controls="autocomplete-list"
aria-expanded="false"
aria-haspopup="listbox"
autocomplete="off"
placeholder="Série, apelido, cidade ou usuário"
class="cockpit-search-input"
data-on-input="handleSerialInput" data-args='["$value"]'
data-on-keydown="handleSerialKeydown" data-args='["$event"]'
/>
<kbd class="cockpit-search-shortcut" aria-hidden="true" title="Atalho: Ctrl+K">Ctrl K</kbd>
</div>
<div class="cockpit-bar__chips">
<details id="readiness-panel" class="cockpit-chip readiness-panel" data-state="loading" aria-labelledby="readiness-title" aria-busy="true">
<summary class="cockpit-chip__trigger" aria-controls="readiness-content">
<span id="stat-base-dot" class="cockpit-chip__dot dot-ok" aria-hidden="true"></span>
<span id="readiness-summary-short" class="cockpit-chip__label" role="status" aria-live="polite" aria-atomic="true">Base 2 h</span>
<span id="readiness-title" class="sr-only">Disponibilidade das funções</span>
</summary>
<div id="readiness-content" class="cockpit-chip__panel readiness-expanded-content">
<dl class="readiness-grid">
<div class="readiness-item"><dt>Equipamentos</dt><dd><strong id="stat-equipamentos">Carregando…</strong> <span id="stat-equipamentos-rotulo">equipamentos</span></dd></div>
<div class="readiness-item"><dt>Regionais</dt><dd><strong id="stat-unidades">Carregando…</strong></dd></div>
<div class="readiness-item"><dt>Contrato</dt><dd><strong>16467</strong></dd></div>
</dl>
</div>
</details>
<span id="automacao-estado" class="cockpit-chip cockpit-chip--neutral" data-state="idle" aria-live="polite">
<span class="cockpit-chip__dot" aria-hidden="true"></span>
<span id="automacao-estado-titulo" class="cockpit-chip__label">Chrome livre</span>
</span>
</div>
<div class="cockpit-bar__tools">
<details class="cockpit-tools-dropdown">
<summary class="cockpit-tools-dropdown__trigger" aria-label="Ferramentas do sistema" title="Ferramentas">
<i data-lucide="wrench" aria-hidden="true"></i>
<span>Ferramentas</span>
<i data-lucide="chevron-down" class="cockpit-tools-dropdown__chevron" aria-hidden="true"></i>
</summary>
<div class="cockpit-tools-dropdown__menu" role="menu">
<button type="button" data-on-click="resetarFormulario" id="btn-nova-transferencia" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="rotate-ccw" aria-hidden="true"></i><span>Nova transferência</span>
</button>
<div class="cockpit-tools-dropdown__divider" role="separator"></div>
<button type="button" data-on-click="abrirAcompanhamentoChamados" id="btn-acompanhamento-chamados" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="clipboard-list" aria-hidden="true"></i><span>Acompanhamento de Chamados</span>
</button>
<button type="button" data-on-click="abrirModalAtualizarPlanilhas" id="btn-atualizar-planilhas" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="upload" aria-hidden="true"></i><span>Atualizar planilhas</span>
</button>
<button type="button" data-on-click="exportarEquipamentosAtualizados" id="btn-exportar-equipamentos" aria-label="Exportar planilha Excel com apelidos e IdCliente atualizados" aria-labelledby="label-exportar-equipamentos" class="cockpit-tools-dropdown__item hidden" role="menuitem">
<i data-lucide="download" aria-hidden="true"></i><span id="label-exportar-equipamentos">Exportar Excel</span>
</button>
<button type="button" data-on-click="abrirRelatorioMensal" id="btn-relatorio-mensal" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="file-spreadsheet" aria-hidden="true"></i><span>Relatório mensal</span>
</button>
<div class="cockpit-tools-dropdown__divider" role="separator"></div>
<button type="button" data-on-click="abrirModalHistoricoComparacoes" id="btn-historico-comparacoes" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="file-clock" aria-hidden="true"></i><span>Histórico planilhas</span>
<span id="badge-total-historico-comparacoes" class="cockpit-tools-dropdown__badge" aria-label="0 registros">0</span>
</button>
<button type="button" data-on-click="abrirEvolucaoAtualizacoes" id="btn-evolucao-atualizacoes" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="activity" aria-hidden="true"></i><span>Evolução das atualizações</span>
</button>
<button type="button" data-on-click="abrirModalHistoricoApelidos" id="btn-historico-apelidos" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="user-pen" aria-hidden="true"></i><span>Histórico de alterações</span>
</button>
<button type="button" data-on-click="abrirModalGerenciarUnidades" id="btn-catalogo-unidades" class="cockpit-tools-dropdown__item" role="menuitem">
<i data-lucide="map-pin" aria-hidden="true"></i><span>Catálogo de unidades</span>
</button>
</div>
</details>
</div>
<div class="cockpit-bar__actions">
<button type="button" id="btn-notificacoes" class="cockpit-action-button" aria-label="Notificações" aria-controls="notification-center-panel" aria-expanded="false" title="Notificações">
<i data-lucide="bell" aria-hidden="true"></i>
<span id="badge-notificacoes" class="cockpit-notification-badge" aria-hidden="true" hidden>0</span>
</button>
<button type="button" id="theme-toggle" class="cockpit-action-button" aria-label="Ativar modo claro" title="Ativar modo claro">
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.42 1.42"></path><path d="m17.65 17.65 1.42 1.42"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.42-1.42"></path><path d="m19.07 4.93-1.42-1.42"></path></svg>
</button>
</div>
<strong id="header-page-title" class="sr-only">Home</strong>
</header>
<!-- Notification center panel (preserved from original) -->
<section id="notification-center-panel" class="notification-center-panel" role="region" aria-labelledby="notification-center-title" aria-busy="true" hidden>
<div class="notification-center-header">
<h2 id="notification-center-title">Notificações</h2>
<p id="notification-center-summary" role="status" aria-live="polite" aria-atomic="true">Verificando os avisos…</p>
</div>
<section id="alerta-os-paradas" class="stale-base-alert" role="status" aria-labelledby="alerta-os-paradas-titulo" data-state="loading" hidden>
<i data-lucide="file-clock" class="stale-base-alert-icon" aria-hidden="true"></i>
<div class="stale-base-alert-copy">
<h2 id="alerta-os-paradas-titulo" class="stale-base-alert-title">OS paradas</h2>
<p id="alerta-os-paradas-texto" class="stale-base-alert-text"></p>
</div>
<button type="button" id="btn-alerta-os-paradas" data-on-click="abrirAcompanhamentoChamados" class="btn btn-secondary stale-base-alert-action">Ver chamados</button>
</section>
<section id="alerta-divergencias-novas" class="stale-base-alert" role="status" aria-labelledby="alerta-divergencias-novas-titulo" data-state="loading" hidden>
<i data-lucide="alert-circle" class="stale-base-alert-icon" aria-hidden="true"></i>
<div class="stale-base-alert-copy">
<h2 id="alerta-divergencias-novas-titulo" class="stale-base-alert-title">Divergências novas</h2>
<p id="alerta-divergencias-novas-texto" class="stale-base-alert-text"></p>
</div>
<button type="button" id="btn-alerta-divergencias-novas" data-on-click="abrirEvolucaoAtualizacoes" class="btn btn-secondary stale-base-alert-action">Ver evolução</button>
</section>
</section>
<div class="app-workspace cockpit-workspace">'''

result = re.sub(pattern, new_block, html, count=1, flags=re.DOTALL)
if result == html:
    print("ERROR: no substitution made")
else:
    p.write_text(result, encoding="utf-8")
    print(f"OK: replaced {len(html)} -> {len(result)} chars")