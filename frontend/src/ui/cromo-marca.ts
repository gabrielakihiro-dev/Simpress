/* eslint-disable @typescript-eslint/no-explicit-any */
// Marca "Simpress" em metal liquido (LiquidMetal da Paper, WebGL2, @paper-design/shaders 0.0.81).
// Sem WebGL2 ou se algo falhar, o texto da marca continua visivel (fallback).
// O paper-shaders segue como módulo do navegador em /static/vendor/ (external no vite.config.mts); os tipos
// mínimos dele estão em frontend/types/vendor/ (mapeados por `paths` no tsconfig.json).
// Só 4 módulos do pacote (não o index.js, que puxa 35) e só depois do carregamento, para o efeito não atrasar a abertura.
type Qualquer = any;

const TEXTO = "Simpress";
const CONFIG = {
  font: "900 400px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  letterSpacing: -8,
  tint: "#f4f0fa",
  tintClaro: "#1b2236", // tema claro: metal escuro sobre fundo claro
  repetition: 0.7,
  softness: 0.45,
  shiftRed: 0.3,
  shiftBlue: 0.3,
  distortion: 0.07,
  contour: 0.12,
  angle: 70,
  speed: 1,
};

async function drawMask(text: string): Promise<Blob> {
  await document.fonts.load(CONFIG.font);
  const measure = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  measure.font = CONFIG.font;
  measure.letterSpacing = `${CONFIG.letterSpacing}px`;
  const pad = 80;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(measure.measureText(text).width) + pad * 2;
  canvas.height = 400 + pad * 2;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.font = CONFIG.font;
  ctx.letterSpacing = `${CONFIG.letterSpacing}px`;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, canvas.height / 2 + 14);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("cromo: mascara vazia"))), "image/png"),
  );
}

function corDoTema(): string {
  return document.documentElement.dataset.theme === "light" ? CONFIG.tintClaro : CONFIG.tint;
}

async function montar(el: HTMLElement): Promise<void> {
  const [{ ShaderMount }, { ShaderFitOptions }, { getShaderColorFromString }, { LiquidMetalShapes, liquidMetalFragmentShader, toProcessedLiquidMetal }] =
    await Promise.all([
      import("/static/vendor/paper-shaders-0.0.81/shader-mount.js"),
      import("/static/vendor/paper-shaders-0.0.81/shader-sizing.js"),
      import("/static/vendor/paper-shaders-0.0.81/get-shader-color-from-string.js"),
      import("/static/vendor/paper-shaders-0.0.81/shaders/liquid-metal.js"),
    ]);
  const blob = await drawMask(TEXTO);
  const { pngBlob } = await toProcessedLiquidMetal(new File([blob], "mascara.png", { type: "image/png" }));
  const image = new Image();
  image.src = URL.createObjectURL(pngBlob);
  await image.decode();
  // A Paper procura style[data-paper-shader] e, se nao acha, injeta um <style> proprio, que a CSP
  // (style-src 'self') bloqueia. As mesmas regras estao em ck-cockpit.css; aqui o achado e simulado
  // so durante a montagem.
  let mount: Qualquer;
  const doc: Qualquer = document;
  const procurar = doc.querySelector;
  doc.querySelector = function (this: Qualquer, seletor: string) {
    return seletor === "style[data-paper-shader]" ? document.head : procurar.call(this, seletor);
  };
  try {
    mount = new ShaderMount(
      el,
      liquidMetalFragmentShader,
      {
        u_colorBack: getShaderColorFromString("rgba(0,0,0,0)"),
        u_colorTint: getShaderColorFromString(corDoTema()),
        u_image: image,
        u_isImage: true,
        u_shape: LiquidMetalShapes.none,
        u_repetition: CONFIG.repetition,
        u_softness: CONFIG.softness,
        u_shiftRed: CONFIG.shiftRed,
        u_shiftBlue: CONFIG.shiftBlue,
        u_distortion: CONFIG.distortion,
        u_contour: CONFIG.contour,
        u_angle: CONFIG.angle,
        u_fit: ShaderFitOptions.contain,
        u_scale: 1,
        u_rotation: 0,
        u_offsetX: 0,
        u_offsetY: 0,
        u_originX: 0.5,
        u_originY: 0.5,
        u_worldWidth: 0,
        u_worldHeight: 0,
      },
      undefined,
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : CONFIG.speed,
      0,
      2,
      undefined,
      ["u_image"],
    );
  } finally {
    doc.querySelector = procurar;
  }
  // a cor segue o tema quando o usuario alterna claro/escuro
  new MutationObserver(() => mount.setUniforms({ u_colorTint: getShaderColorFromString(corDoTema()) })).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ["data-theme"] },
  );
}

const el = document.getElementById("ck-marca-cromo");
function iniciar(): void {
  if (!el) return;
  montar(el)
    .then(() => el.closest(".ck-marca")?.classList.add("ck-marca--cromo"))
    .catch((erro) => console.warn("Marca em metal indisponivel; texto mantido.", erro));
}

// Depois do load, e quando o navegador estiver ocioso (setTimeout onde nao ha requestIdleCallback).
function aoOcioso(): void {
  if ("requestIdleCallback" in window) window.requestIdleCallback(iniciar, { timeout: 2000 });
  else setTimeout(iniciar, 200);
}
if (document.readyState === "complete") aoOcioso();
else window.addEventListener("load", aoOcioso, { once: true });
