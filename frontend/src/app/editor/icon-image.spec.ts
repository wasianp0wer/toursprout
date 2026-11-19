import { describe, expect, it } from 'vitest';
import { fitSquare, toIconPng } from './icon-image';

describe('fitSquare', () => {
  it('letterboxes a wide image', () => {
    expect(fitSquare(1000, 200, 256)).toEqual({ x: 0, y: 102.4, w: 256, h: 51.2 });
  });
  it('pillarboxes a tall image', () => {
    expect(fitSquare(200, 1000, 256)).toEqual({ x: 102.4, y: 0, w: 51.2, h: 256 });
  });
  it('scales a small square up to fill', () => {
    expect(fitSquare(16, 16, 256)).toEqual({ x: 0, y: 0, w: 256, h: 256 });
  });
});

describe('toIconPng', () => {
  it('rejects a file that is not an image', async () => {
    await expect(toIconPng(new Blob(['not an image'])))
      .rejects.toThrow('That file could not be read as an image.');
  });
});
