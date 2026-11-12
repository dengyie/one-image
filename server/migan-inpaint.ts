import { rgbaToRgbChw, maskToBinary } from '../src/infrastructure/inpaint/inpaint-core'
import type { SessionLike, TensorCtor, LamaRunResult } from './lama-inpaint'

// Server-side MI-GAN runner (migan_pipeline_v2, MIT): the same model the
// browser 标准 tier runs through onnxruntime-web, executed by onnxruntime-node
// on the host. The browser worker is the contract reference — uint8 RGB CHW
// image + binary mask, dynamic H×W (measured: 2048² ≈ 1.6s, arena ≈ 0 over a
// 57MB session, so the model fits hosts where LaMa's fp32 activations do not).
//
// The result mirrors runLamaTiling's contract: hole pixels carry the model
// output, every non-hole pixel is bit-for-bit the input plane, alpha rides
// from the original. The caller (the browser) feathers through its own alpha
// — the server never blends.

export async function runMiganTiling(
  session: SessionLike,
  tensors: TensorCtor,
  input: { width: number; height: number; image: Uint8Array; mask: Uint8Array },
): Promise<LamaRunResult> {
  const started = performance.now()
  const { width, height, image, mask } = input
  const pixelCount = width * height
  if (image.length !== pixelCount * 4 || mask.length !== pixelCount * 4) {
    throw new Error('migan-inpaint: plane dimensions do not match buffer sizes')
  }

  const planes = {
    image: { data: image as unknown as Uint8ClampedArray, width, height },
    mask: { data: mask as unknown as Uint8ClampedArray, width, height },
  }
  const feeds: Record<string, unknown> = {
    [session.inputNames[0]]: new tensors.Tensor('uint8', rgbaToRgbChw(planes.image), [1, 3, height, width]),
    [session.inputNames[1]]: new tensors.Tensor('uint8', maskToBinary(planes.mask), [1, 1, height, width]),
  }
  const results = await session.run(feeds)
  const output = results[session.outputNames[0]].data as Uint8Array

  const rgba = new Uint8Array(image)
  for (let i = 0; i < pixelCount; i++) {
    if (mask[i * 4] < 128) continue
    rgba[i * 4] = output[i]
    rgba[i * 4 + 1] = output[pixelCount + i]
    rgba[i * 4 + 2] = output[pixelCount * 2 + i]
  }
  return { rgba, ms: Math.round(performance.now() - started), tiles: 1 }
}
