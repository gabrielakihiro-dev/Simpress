// Keep the browser dependency graph in one place. Shared utilities load before
// features, the bootstrap publishes feature actions, and page enhancements load last.
import "./ui/action-dispatcher.js";
import "../comum/dom-utils.ts";
import "../comum/catalog-search-utils.ts";
import "../comum/recent-equipment.ts";
import "../comum/form-draft-guard.ts";
import "../comum/transfer-utils.ts";
import "../comum/history-annotation-autosave.ts";
import "../comum/api-errors.ts";
import "../api.ts";
import "../ui/ui-motion.ts";
import "../ui/bento.ts";
import "../ui/accessible-dialogs.ts";
import "../ui/file-picker.ts";
import "../ui/ui-notifications.ts";
import "../comum/history-format.ts";
import "../comum/sebrae-dashboard-model.ts";
import "../aplicacao/registro.ts";
import "../ui/equipment-search-renderers.ts";
import "../ui/logged-user-markers.ts";
import "./app.js";
import "./ui/ux-enhancements.js";
import "./ui/ck-cockpit-visual.js";
import "./ui/cromo-marca.js";
