// Validate H.265's default layer-0 decode of Nokia HEIF layered-image samples.
// The HEIF samples are copyrighted, so download and verify them transiently.
import { createHash } from 'node:crypto';
import { decodeHeic, decodeHeicStereoPairs, getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitLengthPrefixed } from '../src/hevc/nal';
import { decodeItemPlanes } from '../src/planes';

const source =
  'https://raw.githubusercontent.com/nokiatech/heif/f01283f3e64ccc6e6ab489bd556d454879069185/content/conformance';
const vectors = [
  {
    name: 'multilayer001.heic',
    fileSha256: '7b50db4483d31d78306cd1bf6e5b7d43d497d1cba6ac5b6895cadc546883164c',
    width: 1024,
    height: 512,
    ffmpegYuvSha256: '47ec14dad51336d972d756268cb952caa5310a97b36256771e87d4a4627bffdf',
    enhancementItems: [{ itemId: 20004, width: 1024, height: 512 }],
  },
  {
    name: 'multilayer002.heic',
    fileSha256: 'b4536629a8054a50e37c1d707a61c68b3f5f2284ec5fd36f6705c4e07063727e',
    width: 512,
    height: 256,
    ffmpegYuvSha256: '3f09ae78b09576fcc18f66f671043d0733832ba4357148a713eb218bcbc90092',
    enhancementItems: [
      { itemId: 20014, width: 512, height: 256 },
      { itemId: 20015, width: 512, height: 256 },
      { itemId: 20016, width: 512, height: 256 },
      { itemId: 20017, width: 512, height: 256 },
    ],
  },
  {
    name: 'multilayer005.heic',
    fileSha256: '43cd906e0f04e12ceb007e683d637b68c72184f2118a69882e19f286c69f73d2',
    width: 512,
    height: 256,
    ffmpegYuvSha256: '2be8165482c16037c0808a7e1379bc879fb2b44fc0d836ab000518ea3fe753b8',
  },
] as const;

async function download(name: string, expectedSha256: string): Promise<Uint8Array> {
  const response = await fetch(`${source}/${name}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256)
    throw new Error(`${name}: file SHA-256 mismatch (${actualSha256})`);
  return bytes;
}

function selectPrimaryItem(
  file: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  itemId: number,
) {
  const selected = file.slice();
  const metaBox = boxes.find((box) => box.type === 'meta');
  const pitmBox = metaBox?.children?.find((box) => box.type === 'pitm');
  if (!pitmBox) throw new Error('missing pitm box');
  const itemIdOffset = pitmBox.data.byteOffset - file.byteOffset + 4;
  new DataView(selected.buffer, selected.byteOffset, selected.byteLength).setUint16(
    itemIdOffset,
    itemId,
  );
  return selected;
}

for (const vector of vectors) {
  const file = await download(vector.name, vector.fileSha256);
  const boxes = parseISOBMFF(file);
  const info = getHeicInfo(file, boxes);
  if (
    getFtypInfo(file)?.majorBrand !== 'heis' ||
    info.primaryItemType !== 'hvc1' ||
    info.width !== vector.width ||
    info.height !== vector.height ||
    info.bitDepth !== 8 ||
    info.hvcC?.chromaFormatIdc !== 1
  )
    throw new Error(`${vector.name}: unexpected primary item or HEVC image format`);

  const metadata = getHeicMetadata(file);
  if (
    metadata.sliceNalCount !== 1 ||
    metadata.sps?.chromaFormatIdc !== 1 ||
    metadata.sps.picWidthInLumaSamples !== vector.width ||
    metadata.sps.picHeightInLumaSamples !== vector.height
  )
    throw new Error(`${vector.name}: public metadata did not resolve the base-layer picture`);

  const planes = decodeItemPlanes(file, boxes, info, info.primaryItemId);
  const yuvSha256 = createHash('sha256')
    .update(planes.y)
    .update(planes.cb)
    .update(planes.cr)
    .digest('hex');
  if (yuvSha256 !== vector.ffmpegYuvSha256)
    throw new Error(`${vector.name}: base-layer Y/Cb/Cr mismatch (${yuvSha256})`);

  const image = decodeHeic(file);
  if (
    image.width !== vector.width ||
    image.height !== vector.height ||
    image.bitDepth !== 8 ||
    image.data.length !== vector.width * vector.height * 4
  )
    throw new Error(`${vector.name}: public decode returned unexpected RGBA output`);

  console.log(
    `${vector.name}: layer-0 Y/Cb/Cr matches FFmpeg 9.0.1; public RGBA decode ${image.width}x${image.height} passes.`,
  );

  if ('enhancementItems' in vector) {
    for (const enhancement of vector.enhancementItems) {
      const enhancementInfo = getHeicInfo(file, boxes, enhancement.itemId);
      if (
        enhancementInfo.primaryItemType !== 'lhv1' ||
        enhancementInfo.lhevc?.targetLayerId !== 1 ||
        enhancementInfo.lhevc.requiredLayerIds.join(',') !== '0,1' ||
        enhancementInfo.lhevc.selectedSpsHeader?.layerId !== 1
      )
        throw new Error(`${vector.name}: item ${enhancement.itemId} did not select L-HEVC layer 1`);

      const enhancementPlanes = decodeItemPlanes(file, boxes, enhancementInfo, enhancement.itemId);
      if (
        enhancementPlanes.width !== enhancement.width ||
        enhancementPlanes.height !== enhancement.height ||
        enhancementPlanes.chromaFormatIdc !== 1 ||
        enhancementPlanes.bitDepthLuma !== 8 ||
        enhancementPlanes.bitDepthChroma !== 8
      )
        throw new Error(`${vector.name}: item ${enhancement.itemId} returned unexpected planes`);

      const enhancementImage = decodeHeic(selectPrimaryItem(file, boxes, enhancement.itemId));
      if (
        enhancementImage.width !== enhancement.width ||
        enhancementImage.height !== enhancement.height ||
        enhancementImage.bitDepth !== 8 ||
        enhancementImage.data.length !== enhancement.width * enhancement.height * 4
      )
        throw new Error(
          `${vector.name}: item ${enhancement.itemId} returned unexpected RGBA output`,
        );

      const enhancementYuvSha256 = createHash('sha256')
        .update(enhancementPlanes.y)
        .update(enhancementPlanes.cb)
        .update(enhancementPlanes.cr)
        .digest('hex');
      console.log(
        `${vector.name}: lhv1 item ${enhancement.itemId} layer 1 decodes to ${enhancement.width}x${enhancement.height}; Y/Cb/Cr SHA-256 ${enhancementYuvSha256}. No independent pixel reference is available for this layer.`,
      );
    }
  }

  if (vector.name === 'multilayer005.heic') {
    const enhancementInfo = getHeicInfo(file, boxes, 20004);
    const enhancementPayload = getItemPayload(file, boxes, 20004);
    if (
      enhancementInfo.primaryItemType !== 'lhv1' ||
      enhancementInfo.lhevc?.targetOutputLayerSetIndex !== 1 ||
      enhancementInfo.lhevc.targetLayerId !== 1 ||
      enhancementInfo.lhevc.requiredLayerIds.join(',') !== '0,1' ||
      enhancementInfo.lhevc.selectedSpsHeader?.layerId !== 1 ||
      enhancementInfo.lhevc.selectedSpsHeader.videoParameterSetId !== 0 ||
      enhancementInfo.lhevc.selectedSpsHeader.spsExtOrMaxSubLayersMinus1 !== 7 ||
      enhancementInfo.lhevc.selectedSpsHeader?.spsId !== 1 ||
      enhancementInfo.lhevc.selectedSpsHeader.updateRepFormatFlag !== false ||
      enhancementInfo.lhevc.selectedSpsHeader.spsRepFormatIndex !== null ||
      enhancementInfo.lhevc.selectedSpsHeader.log2MaxPicOrderCntLsb !== 8 ||
      enhancementInfo.lhevc.selectedRepresentationFormat?.index !== 0 ||
      enhancementInfo.lhevc.selectedRepresentationFormat.width !== 512 ||
      enhancementInfo.lhevc.selectedRepresentationFormat.height !== 256 ||
      enhancementInfo.lhevc.selectedRepresentationFormat.chromaFormatIdc !== 1 ||
      enhancementInfo.lhevc.selectedRepresentationFormat.bitDepthLuma !== 8 ||
      enhancementInfo.lhevc.selectedRepresentationFormat.bitDepthChroma !== 8 ||
      enhancementInfo.bitDepth !== 8 ||
      !enhancementPayload
    )
      throw new Error('multilayer005.heic: failed to resolve the selected L-HEVC output layer');

    const parameterSets = new Set(
      enhancementInfo.lhevc.configuration.arrays
        .flatMap((array) => array.nalUnits)
        .filter((nal) => nal.nalUnitType === 33 || nal.nalUnitType === 34)
        .map((nal) => `${nal.nalUnitType}:${nal.layerId}`),
    );
    if (
      ![0, 1].every(
        (layerId) => parameterSets.has(`33:${layerId}`) && parameterSets.has(`34:${layerId}`),
      )
    )
      throw new Error('multilayer005.heic: lhvC is missing an SPS or PPS for a required layer');

    const enhancementSlices = splitLengthPrefixed(
      enhancementPayload,
      enhancementInfo.lhevc.configuration.nalLengthSize,
      false,
      [enhancementInfo.lhevc.targetLayerId],
    ).filter((nal) => isSliceNal(nal.type));
    if (enhancementSlices.length !== 1 || enhancementSlices[0].layerId !== 1)
      throw new Error('multilayer005.heic: selected enhancement-layer slice was not isolated');

    const enhancementMetadata = getHeicMetadata(file, 20004);
    const enhancementPrimary = selectPrimaryItem(file, boxes, 20004);
    if (
      enhancementMetadata.primaryItemType !== 'lhv1' ||
      enhancementMetadata.lhevc?.targetLayerId !== 1 ||
      enhancementMetadata.sps?.layerId !== 1 ||
      enhancementMetadata.sps.videoParameterSetId !== 0 ||
      enhancementMetadata.sps.spsId !== 1 ||
      !enhancementMetadata.sps.multiLayerExtSps ||
      enhancementMetadata.sps.representationFormatIndex !== 0 ||
      enhancementMetadata.sps.width !== 512 ||
      enhancementMetadata.sps.height !== 256 ||
      enhancementMetadata.sps.chromaFormatIdc !== 1 ||
      enhancementMetadata.sps.bitDepthLuma !== 8 ||
      enhancementMetadata.sps.bitDepthChroma !== 8 ||
      enhancementMetadata.sps.log2MaxPicOrderCntLsb !== 8 ||
      enhancementMetadata.sliceNalCount !== 1
    )
      throw new Error('multilayer005.heic: public metadata did not parse the selected layer SPS');

    const enhancementPlanes = decodeItemPlanes(file, boxes, enhancementInfo, 20004);
    if (
      enhancementPlanes.width !== 512 ||
      enhancementPlanes.height !== 256 ||
      enhancementPlanes.chromaFormatIdc !== 1 ||
      enhancementPlanes.bitDepthLuma !== 8 ||
      enhancementPlanes.bitDepthChroma !== 8 ||
      enhancementPlanes.y.length !== 512 * 256 ||
      enhancementPlanes.cb.length !== 256 * 128 ||
      enhancementPlanes.cr.length !== 256 * 128
    )
      throw new Error('multilayer005.heic: selected layer 1 returned unexpected Y/Cb/Cr planes');

    const enhancementImage = decodeHeic(enhancementPrimary);
    if (
      enhancementImage.width !== 512 ||
      enhancementImage.height !== 256 ||
      enhancementImage.bitDepth !== 8 ||
      enhancementImage.data.length !== 512 * 256 * 4
    )
      throw new Error('multilayer005.heic: selected layer 1 returned unexpected RGBA output');

    const stereoPairs = decodeHeicStereoPairs(file);
    const stereoPair = stereoPairs.find((pair) => pair.groupId === 20005);
    if (
      stereoPairs.length !== 1 ||
      !stereoPair ||
      stereoPair.leftItemId !== 20003 ||
      stereoPair.rightItemId !== 20004 ||
      stereoPair.left.width !== 512 ||
      stereoPair.left.height !== 256 ||
      stereoPair.right.width !== 512 ||
      stereoPair.right.height !== 256 ||
      stereoPair.left.bitDepth !== 8 ||
      stereoPair.right.bitDepth !== 8
    )
      throw new Error('multilayer005.heic: ster pair did not render both selected image items');

    console.log(
      'multilayer005.heic: selected layer 1 reconstructs to 512x256 8-bit planes and RGBA; ster pair 20005 renders both views. No independent enhancement-layer pixel reference is available.',
    );
  }
}
