import { escapeKey } from '../../../src/utils/inputUtils';

describe('escapeKey', () => {
  it('leaves an ordinary key unchanged', () => {
    expect(escapeKey('octo/app/refs%2Fheads%2Fmain/npm-é/v1/cache.tar.zst')).toBe(
      'octo/app/refs%2Fheads%2Fmain/npm-é/v1/cache.tar.zst'
    );
  });

  it('escapes line breaks, tabs and other control characters', () => {
    expect(escapeKey('a\n::error::b\r\tc\u0000d\u001be\u007ff\u0085g h')).toBe(
      'a\\n::error::b\\r\\tc\\u0000d\\u001be\\u007ff\\u0085g\\u2028h'
    );
  });
});
