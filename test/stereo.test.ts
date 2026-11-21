import { describe, expect, it } from 'bun:test';
import { HeicError } from '../src/errors';
import { decodeHeic, decodeHeicStereoPairs, getHeicMetadata } from '../src/decoder';
import { buildHeif, codedFixture, full, u32 } from './helpers/heif';

function stereoGroup(groupId: number, leftItemId: number, rightItemId: number): Uint8Array {
  return full('ster', 0, u32(groupId), u32(2), u32(leftItemId), u32(rightItemId));
}

describe('HEIF stereo pairs', () => {
  it('reports and decodes left/right image items in `ster` entity order', () => {
    const left = codedFixture();
    const right = { ...codedFixture(), id: 2 };
    const file = buildHeif([left, right], left.id, [stereoGroup(71, left.id, right.id)]);

    expect(getHeicMetadata(file).stereoPairs).toEqual([
      { groupId: 71, leftItemId: left.id, rightItemId: right.id },
    ]);
    const [pair] = decodeHeicStereoPairs(file);
    expect(pair).toMatchObject({ groupId: 71, leftItemId: left.id, rightItemId: right.id });
    expect(pair.left.width).toBe(64);
    expect(pair.left.height).toBe(64);
    expect(pair.right.width).toBe(64);
    expect(pair.right.height).toBe(64);
    expect(pair.left.data).toEqual(pair.right.data);
  });

  it('renders a right-view 4:2:2 item rather than reusing the primary item', () => {
    const left = codedFixture();
    const right = { ...codedFixture(8, 'chroma422'), id: 2 };
    const file = buildHeif([left, right], left.id, [stereoGroup(74, left.id, right.id)]);
    const rightOnly = buildHeif([right], right.id);

    const [pair] = decodeHeicStereoPairs(file);
    expect(pair.right.data).toEqual(decodeHeic(rightOnly).data);
  });

  it('rejects a ster group that does not contain exactly two entities', () => {
    const image = codedFixture();
    const malformed = full('ster', 0, u32(72), u32(1), u32(image.id));
    const file = buildHeif([image], image.id, [malformed]);

    try {
      getHeicMetadata(file);
      throw new Error('expected invalid stereo group to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HeicError);
      expect((error as HeicError).code).toBe('INVALID_CONTAINER');
    }
  });

  it('reports a missing stereo group as an unsupported feature', () => {
    const image = codedFixture();
    const file = buildHeif([image], image.id);

    expect(() => decodeHeicStereoPairs(file)).toThrow('no stereo pair group found');
  });

  it('ignores an unknown optional ster-group version while decoding the primary item', () => {
    const image = codedFixture();
    const futureVersion = full('ster', 1, u32(73), u32(2), u32(image.id), u32(image.id + 1));
    const file = buildHeif([image], image.id, [futureVersion]);

    expect(getHeicMetadata(file).stereoPairs).toEqual([]);
    expect(decodeHeic(file).width).toBe(64);
  });
});
