import { describe, expect, it } from 'vitest';
import { creditLine } from './credit';

describe('creditLine', () => {
  it('links sourced work and names its creator', () => {
    expect(creditLine({ type: 'sourced', source: 'LoC', url: 'https://loc.gov/x',
      license: 'No known restrictions', creator: 'National Photo Co.' })).toEqual({
      attribution: 'LoC — National Photo Co. · No known restrictions',
      url: 'https://loc.gov/x',
    });
  });

  it('omits the dash when a sourced credit has no creator', () => {
    expect(creditLine({ type: 'sourced', source: 'Mapillary', url: 'https://m.com',
      license: 'CC-BY-SA-4.0', creator: null }).attribution)
      .toBe('Mapillary · CC-BY-SA-4.0');
  });

  it('gives original work no link', () => {
    expect(creditLine({ type: 'original', creator: 'M. Harrington',
      license: 'CC-BY-4.0' })).toEqual({
      attribution: 'M. Harrington · CC-BY-4.0', url: null });
  });
});
