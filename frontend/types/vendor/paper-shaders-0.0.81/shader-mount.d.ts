// Tipos mínimos de shader-mount.js (paper-shaders 0.0.81), só o que frontend/src/ui/cromo-marca.ts usa.
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
