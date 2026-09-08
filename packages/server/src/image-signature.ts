/**
 * Que formato de imagen es un buffer, mirando sus primeros bytes.
 *
 * Es lo que decide si algo que llego del cliente se escribe en disco con
 * extension de imagen. El `mediaType` que declara el navegador es una promesa;
 * la firma es un hecho. Lo usan el pegado del cuadro de escritura y las notas,
 * y vive aparte para que los dos apliquen exactamente la misma lista.
 */

export interface ImageFormat {
  ext: string;
  mediaType: string;
}

const FORMATS: readonly { readonly format: ImageFormat; readonly test: (b: Buffer) => boolean }[] =
  [
    {
      format: { ext: 'png', mediaType: 'image/png' },
      test: (b) =>
        b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    },
    {
      format: { ext: 'jpg', mediaType: 'image/jpeg' },
      test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
      format: { ext: 'gif', mediaType: 'image/gif' },
      test: (b) => b.length > 6 && b.subarray(0, 4).toString('ascii') === 'GIF8',
    },
    {
      format: { ext: 'webp', mediaType: 'image/webp' },
      test: (b) =>
        b.length > 12 &&
        b.subarray(0, 4).toString('ascii') === 'RIFF' &&
        b.subarray(8, 12).toString('ascii') === 'WEBP',
    },
  ];

/** Tipos declarables. Lista corta y explicita, la misma que las firmas. */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  FORMATS.map((entry) => entry.format.mediaType),
);

export function detectImageFormat(bytes: Buffer): ImageFormat | null {
  return FORMATS.find((entry) => entry.test(bytes))?.format ?? null;
}
