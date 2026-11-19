/** The icon is stored as a 256px square PNG: browsers scale it down for a tab. */
export const ICON_SIZE = 256;

/** Where to draw a w×h image so it fits, centred, inside a size×size square. */
export function fitSquare(w: number, h: number, size: number): { x: number; y: number; w: number; h: number } {
  const scale = size / Math.max(w, h);
  const dw = w * scale;
  const dh = h * scale;
  return { x: (size - dw) / 2, y: (size - dh) / 2, w: dw, h: dh };
}

/**
 * Whatever image the author chose, as a square PNG with transparent margins,
 * so the published tab icon is never stretched or cropped.
 */
export async function toIconPng(file: Blob): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image.');
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const fit = fitSquare(bitmap.width, bitmap.height, ICON_SIZE);
    canvas.getContext('2d')!.drawImage(bitmap, fit.x, fit.y, fit.w, fit.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('That file could not be read as an image.');
    const stem = ((file as File).name ?? 'icon').replace(/\.[^.]*$/, '') || 'icon';
    return new File([blob], `${stem}-icon.png`, { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}
