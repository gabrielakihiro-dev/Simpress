// @ts-check
/** Labels and date-times shown by the history views (Histórico de Planilhas, alias history, ticket tracking). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressHistoryFormat = api;
})(typeof window !== "undefined" ? window : globalThis, function createHistoryFormat() {
  "use strict";

  /** @param {unknown} valor @returns {string} */
  function formatarNomeFonteHistorico(valor) {
    const text = String(valor || "");
    return text.replace(
      /(?<![\p{L}\p{M}\p{N}])((?:de|da|do|das|dos|na|no|pela|pelo|em|à|ao|a|o)\s+)?(EquipamentosDetalhes|InvAll|Simpress|Endpoint)([\p{L}\p{M}\p{N}_.-]*(?: \(\d+\))?\.[a-z0-9]{1,10}(?=$|[^\p{L}\p{M}\p{N}_]))?(?![\p{L}\p{M}\p{N}_-]|\.[\p{L}\p{M}\p{N}_])/giu,
      (match, preposition = "", source = "", filename = "", offset = 0) => {
        // Keep this display-only normalization in parity with
        // domains.inventory_comparison._comparison_source_text_for_display.
        const sourceLower = source.toLowerCase();
        const isSimpress = sourceLower === "simpress" || sourceLower === "equipamentosdetalhes";
        const isLegacySource = sourceLower === "invall" || sourceLower === "equipamentosdetalhes";
        const visibleSource = isSimpress ? "Simpress" : "Endpoint";

        if (filename) {
          return `${preposition}${isLegacySource ? visibleSource : source}${filename}`;
        }
        if (!preposition && offset > 0 && "_.-".includes(text[offset - 1])) {
          return match;
        }
        if (isLegacySource) {
          return isSimpress ? "na Simpress" : "no endpoint";
        }
        if (preposition) {
          return `${preposition}${!isSimpress && preposition.trim().toLowerCase() === "no" ? "endpoint" : visibleSource}`;
        }
        return isSimpress ? "na Simpress" : "no endpoint";
      },
    );
  }

  /** @param {any} horario @returns {any} */
  function formatarHorarioHistorico(horario) {
    const text = String(horario || "").trim();
    let data = null;
    const brazilianDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text);
    if (brazilianDate) {
      const [, day, month, year, hour = "0", minute = "0", second = "0", millisecond = "0"] = brazilianDate;
      const parts = {
        year: Number(year), month: Number(month), day: Number(day),
        hour: Number(hour), minute: Number(minute), second: Number(second),
        millisecond: Number(millisecond.padEnd(3, "0")),
      };
      const parsed = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
      if (parsed.getFullYear() === parts.year && parsed.getMonth() === parts.month - 1 && parsed.getDate() === parts.day
        && parsed.getHours() === parts.hour && parsed.getMinutes() === parts.minute && parsed.getSeconds() === parts.second) {
        data = parsed;
      }
    }
    const isoDateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!data && isoDateOnly) {
      const [, year, month, day] = isoDateOnly;
      const parsed = new Date(Number(year), Number(month) - 1, Number(day));
      if (parsed.getFullYear() === Number(year) && parsed.getMonth() === Number(month) - 1 && parsed.getDate() === Number(day)) data = parsed;
    }
    if (!data) data = horario instanceof Date ? horario : new Date(horario);
    if (Number.isNaN(data.getTime())) return horario || "Horário indisponível";
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "medium"
    }).format(data);
  }

  // Metric cards share one neutral surface; the tone only colors the left edge, and only when the count is above zero.
  const ACENTOS_METRICA = { amber: "border-l-amber-400", rose: "border-l-rose-400", emerald: "border-l-emerald-400" };

  /** @param {unknown} valor @param {string} tom @returns {{ cartao: string, numero: string }} */
  function classesMetricaHistorico(valor, tom) {
    const ativo = Number(valor || 0) > 0;
    return {
      cartao: `border border-line-quiet border-l-2 bg-surface-overlay/40 ${ativo && ACENTOS_METRICA[tom] ? ACENTOS_METRICA[tom] : "border-l-line-quiet"}`,
      numero: ativo ? "text-white" : "text-fg-muted",
    };
  }

  return { formatarNomeFonteHistorico, formatarHorarioHistorico, classesMetricaHistorico };
});
