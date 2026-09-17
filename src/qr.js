export function qrSvg(text) {
  const factory = globalThis.qrcode;
  if (typeof factory !== 'function') throw new Error('qrcode-generator is not loaded');
  if (factory.stringToBytesFuncs?.['UTF-8']) {
    factory.stringToBytes = factory.stringToBytesFuncs['UTF-8'];
  }
  const qr = factory(0, 'M');
  qr.addData(String(text), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
