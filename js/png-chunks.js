/**
 * PNG Chunks Utility
 * Handles reading and writing tEXt chunks (chara metadata) for AI Character Cards.
 * Supports V2/V3 spec PNGs, CRC32 calculation, and safe UTF-8 Base64 encoding.
 */

// CRC-32 calculation table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  CRC_TABLE[n] = c;
}

function calculateCRC32(buf, offset, length) {
  let c = 0xffffffff;
  for (let i = 0; i < length; i++) {
    c = CRC_TABLE[(c ^ buf[offset + i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Safely converts Base64 string to UTF-8 text (handles Cyrillic, emoji, etc.)
 */
export function base64ToUtf8(base64) {
  const cleanBase64 = base64.replace(/[\r\n\t ]/g, '');
  const binStr = atob(cleanBase64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Safely converts UTF-8 text to Base64 string without data corruption
 */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binStr = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binStr += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binStr);
}

/**
 * Verifies if buffer starts with PNG signature: 89 50 4E 47 0D 0A 1A 0A
 */
export function isPNG(uint8Array) {
  if (uint8Array.length < 8) return false;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (uint8Array[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Extracts character card JSON from PNG binary buffer
 * Searches for tEXt chunks with keyword 'chara' or 'ccv3'
 */
export function extractCardFromPNG(uint8Array) {
  if (!isPNG(uint8Array)) {
    throw new Error('Файл не является корректным изображением PNG');
  }

  const view = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
  let offset = 8; // skip 8-byte PNG signature
  let charaJsonStr = null;
  let ccv3JsonStr = null;

  while (offset < uint8Array.length) {
    if (offset + 8 > uint8Array.length) break;

    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      uint8Array[offset + 4],
      uint8Array[offset + 5],
      uint8Array[offset + 6],
      uint8Array[offset + 7]
    );

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd > uint8Array.length) {
      break;
    }

    if (type === 'tEXt') {
      // Find null separator byte
      let nullIndex = -1;
      for (let i = dataStart; i < dataEnd; i++) {
        if (uint8Array[i] === 0) {
          nullIndex = i;
          break;
        }
      }

      if (nullIndex !== -1) {
        let keyword = '';
        for (let i = dataStart; i < nullIndex; i++) {
          keyword += String.fromCharCode(uint8Array[i]);
        }

        const textBytes = uint8Array.subarray(nullIndex + 1, dataEnd);
        let textVal = '';
        const chunkSz = 8192;
        for (let i = 0; i < textBytes.length; i += chunkSz) {
          textVal += String.fromCharCode.apply(null, textBytes.subarray(i, i + chunkSz));
        }

        if (keyword.toLowerCase() === 'chara') {
          try {
            charaJsonStr = base64ToUtf8(textVal);
          } catch (e) {
            // In case it was stored as raw JSON string instead of base64
            charaJsonStr = new TextDecoder('utf-8').decode(textBytes);
          }
        } else if (keyword.toLowerCase() === 'ccv3') {
          try {
            ccv3JsonStr = base64ToUtf8(textVal);
          } catch (e) {
            ccv3JsonStr = new TextDecoder('utf-8').decode(textBytes);
          }
        }
      }
    }

    if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip 4 bytes CRC
  }

  const rawJson = ccv3JsonStr || charaJsonStr;
  if (!rawJson) {
    throw new Error('В данном PNG не обнаружены метаданные карточки персонажа (отсутствует tEXt чанк "chara" / "ccv3")');
  }

  try {
    return JSON.parse(rawJson);
  } catch (err) {
    throw new Error('Ошибка парсинга JSON из метаданных карточки: ' + err.message);
  }
}

/**
 * Embeds character card JSON into a PNG image as a tEXt chunk 'chara'
 * Removes any pre-existing 'chara' or 'ccv3' chunks to keep the file clean.
 */
export function embedCardInPNG(imageUint8Array, cardJsonObject) {
  if (!isPNG(imageUint8Array)) {
    throw new Error('Исходное изображение должно быть формата PNG');
  }

  const jsonStr = typeof cardJsonObject === 'string' ? cardJsonObject : JSON.stringify(cardJsonObject);
  const base64Data = utf8ToBase64(jsonStr);

  // Keyword: 'chara\0'
  const keyword = [0x63, 0x68, 0x61, 0x72, 0x61, 0x00];
  const base64Bytes = new Uint8Array(base64Data.length);
  for (let i = 0; i < base64Data.length; i++) {
    base64Bytes[i] = base64Data.charCodeAt(i);
  }

  const chunkPayloadLen = keyword.length + base64Bytes.length;
  const newChunkData = new Uint8Array(chunkPayloadLen);
  newChunkData.set(keyword, 0);
  newChunkData.set(base64Bytes, keyword.length);

  // Chunk type 'tEXt' = [0x74, 0x45, 0x58, 0x74]
  const typeBytes = new Uint8Array([0x74, 0x45, 0x58, 0x74]);

  // Compute CRC32 over (type + payload)
  const crcBuffer = new Uint8Array(4 + chunkPayloadLen);
  crcBuffer.set(typeBytes, 0);
  crcBuffer.set(newChunkData, 4);
  const crc32 = calculateCRC32(crcBuffer, 0, crcBuffer.length);

  // Build complete tEXt chunk: Length (4) + Type (4) + Data (N) + CRC (4)
  const newChunk = new Uint8Array(12 + chunkPayloadLen);
  const newChunkView = new DataView(newChunk.buffer);
  newChunkView.setUint32(0, chunkPayloadLen, false);
  newChunk.set(typeBytes, 4);
  newChunk.set(newChunkData, 8);
  newChunkView.setUint32(8 + chunkPayloadLen, crc32, false);

  // Read existing chunks and remove any old chara/ccv3 tEXt chunks
  const view = new DataView(imageUint8Array.buffer, imageUint8Array.byteOffset, imageUint8Array.byteLength);
  let offset = 8;
  const chunksToKeep = [];

  while (offset < imageUint8Array.length) {
    if (offset + 8 > imageUint8Array.length) break;

    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      imageUint8Array[offset + 4],
      imageUint8Array[offset + 5],
      imageUint8Array[offset + 6],
      imageUint8Array[offset + 7]
    );

    const chunkTotalLen = 12 + length;
    const chunkBytes = imageUint8Array.subarray(offset, offset + chunkTotalLen);

    let isOldChara = false;
    if (type === 'tEXt') {
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      let nullIndex = -1;
      for (let i = dataStart; i < dataEnd; i++) {
        if (imageUint8Array[i] === 0) {
          nullIndex = i;
          break;
        }
      }
      if (nullIndex !== -1) {
        let kw = '';
        for (let i = dataStart; i < nullIndex; i++) {
          kw += String.fromCharCode(imageUint8Array[i]);
        }
        if (kw.toLowerCase() === 'chara' || kw.toLowerCase() === 'ccv3') {
          isOldChara = true;
        }
      }
    }

    if (!isOldChara) {
      chunksToKeep.push({ type, bytes: chunkBytes });
    }

    if (type === 'IEND') break;
    offset += chunkTotalLen;
  }

  // Insert newChunk right before IEND
  let totalLength = 8 + newChunk.length; // 8 bytes signature + newChunk
  for (const c of chunksToKeep) {
    totalLength += c.bytes.length;
  }

  const output = new Uint8Array(totalLength);
  // Copy signature
  output.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let writeOffset = 8;

  let inserted = false;
  for (const c of chunksToKeep) {
    if (c.type === 'IEND' && !inserted) {
      output.set(newChunk, writeOffset);
      writeOffset += newChunk.length;
      inserted = true;
    }
    output.set(c.bytes, writeOffset);
    writeOffset += c.bytes.length;
  }

  if (!inserted) {
    output.set(newChunk, writeOffset);
  }

  return output;
}

/**
 * Converts an image file (PNG, JPG, WEBP) to a clean PNG Uint8Array via Canvas
 */
export async function convertImageFileToPNGBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          if (!blob) {
            reject(new Error('Не удалось конвертировать изображение в PNG'));
            return;
          }
          const arrayBuffer = await blob.arrayBuffer();
          resolve(new Uint8Array(arrayBuffer));
        }, 'image/png');
      };
      img.onerror = () => reject(new Error('Не удалось загрузить изображение'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Ошибка чтения файла'));
    reader.readAsDataURL(file);
  });
}
