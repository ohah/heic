import { describe, expect, it } from 'bun:test';
import { decode } from '../src/async';
import { decodeHeic } from '../src/decoder';
import { getItemDataReference, getItemDataReferenceUrl } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { buildHeif, codedFixture, full } from './helpers/heif';

describe('external HEIF item resources', () => {
  it('resolves URL-backed item extents from caller data in sync and async decode', async () => {
    const source = codedFixture();
    const baseline = decodeHeic(buildHeif([source], source.id));
    const url = 'assets/base-layer.hevc';
    const prefix = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const suffix = Buffer.from([0x11, 0x22]);
    const resource = Buffer.concat([prefix, Buffer.from(source.data), suffix]);
    const externalSource = {
      ...source,
      dataReference: full('url ', 0, Buffer.from(`${url}\0`)),
      externalDataOffset: prefix.length,
    };
    const input = buildHeif([externalSource], externalSource.id);
    const options = { externalItemData: { [source.id]: resource } };

    expect(getItemDataReferenceUrl(parseISOBMFF(input), source.id)).toBe(url);
    expect(decodeHeic(input, options).data).toEqual(baseline.data);
    expect(() => decodeHeic(input)).toThrow(`external item ${source.id} has no data`);

    let resolved = false;
    const asynchronous = await decode(input, {
      execution: 'main',
      resolveExternalItem: (reference, itemId) => {
        expect(reference).toEqual({ type: 'url', url });
        expect(itemId).toBe(source.id);
        resolved = true;
        return resource;
      },
    });
    expect(resolved).toBe(true);
    expect(asynchronous.data).toEqual(baseline.data);
  });

  it('resolves URN-backed item resources with the optional location hint', async () => {
    const source = codedFixture();
    const baseline = decodeHeic(buildHeif([source], source.id));
    const name = 'urn:example:heic:base-layer';
    const location = 'assets/base-layer.hevc';
    const resource = Buffer.concat([Buffer.from([0xca, 0xfe]), Buffer.from(source.data)]);
    const externalSource = {
      ...source,
      dataReference: full('urn ', 0, Buffer.from(`${name}\0${location}\0`)),
      externalDataOffset: 2,
    };
    const input = buildHeif([externalSource], externalSource.id);

    expect(getItemDataReference(parseISOBMFF(input), source.id)).toEqual({
      type: 'urn',
      name,
      location,
    });
    expect(decodeHeic(input, { externalItemData: { [source.id]: resource } }).data).toEqual(
      baseline.data,
    );

    const asynchronous = await decode(input, {
      execution: 'main',
      resolveExternalItem: (reference, itemId) => {
        expect(reference).toEqual({ type: 'urn', name, location });
        expect(itemId).toBe(source.id);
        return resource;
      },
    });
    expect(asynchronous.data).toEqual(baseline.data);

    const nameOnlyInput = buildHeif(
      [
        {
          ...source,
          dataReference: full('urn ', 0, Buffer.from(`${name}\0`)),
        },
      ],
      source.id,
    );
    expect(getItemDataReference(parseISOBMFF(nameOnlyInput), source.id)).toEqual({
      type: 'urn',
      name,
    });
    expect(
      decodeHeic(nameOnlyInput, { externalItemData: { [source.id]: source.data } }).data,
    ).toEqual(baseline.data);
  });
});
