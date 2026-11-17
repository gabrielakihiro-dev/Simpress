// Tipos mínimos do paper-shaders 0.0.81 (static/vendor/paper-shaders-0.0.81/index.js), só o que
// frontend/src/ui/cromo-marca.ts usa. O módulo real é carregado pelo navegador (vite.config.mts:
// external /static/vendor/); o tsconfig.json aponta "/static/vendor/*" para esta pasta.
export const LiquidMetalShapes: { readonly none: number; readonly [forma: string]: number };
export const ShaderFitOptions: { readonly none: number; readonly contain: number; readonly cover: number };
export const liquidMetalFragmentShader: string;
export function getShaderColorFromString(cor: string): number[];
export function toProcessedLiquidMetal(arquivo: File | string): Promise<{ imageData: ImageData; pngBlob: Blob }>;
export class ShaderMount {
  constructor(
    elementoPai: HTMLElement,
    fragmentShader: string,
    uniforms: Record<string, unknown>,
    atributosWebGl?: WebGLContextAttributes,
    velocidade?: number,
    quadro?: number,
    razaoMinimaDePixels?: number,
    maximoDePixels?: number,
    mipmaps?: string[],
  );
  setUniforms(uniforms: Record<string, unknown>): void;
}
