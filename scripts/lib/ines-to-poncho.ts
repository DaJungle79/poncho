/**
 * iNES → PonchoROM conversion library — re-exports the runtime-shipped
 * converter so the CLI shares a single source of truth with the web
 * shell's "Convert .nes" button.
 *
 * The implementation lives in `src/convert/ines-to-poncho.ts` so it can
 * be tree-shaken into the browser bundle.
 */

export {
  ConvertError,
  bankingVariantName,
  convertInesToPoncho,
  type ConvertNotes,
  type ConvertOptions,
  type ConvertResult,
} from '../../src/convert/ines-to-poncho';

export {
  AiConvertCancelled,
  convertInesToPonchoAi,
  type AiConvertNotes,
  type AiConvertOptions,
  type AiConvertProgress,
  type AiConvertResult,
} from '../../src/convert/ines-to-poncho-ai';

export {
  MockUpscaleClient,
  UpscaleError,
  type UpscaleClient,
} from '../../src/convert/upscale-client';

export {
  NEAREST_NEIGHBOUR_MODEL,
  createUpscaleClient,
  listUpscaleModels,
  type UpscaleModel,
} from '../../src/convert/upscale-registry';
