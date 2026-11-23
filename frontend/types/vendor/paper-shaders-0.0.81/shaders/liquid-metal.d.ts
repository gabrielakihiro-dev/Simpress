// Tipos mínimos de shaders/liquid-metal.js (paper-shaders 0.0.81).
export const LiquidMetalShapes: { readonly none: number; readonly [forma: string]: number };
export const liquidMetalFragmentShader: string;
export function toProcessedLiquidMetal(arquivo: File | string): Promise<{ imageData: ImageData; pngBlob: Blob }>;
