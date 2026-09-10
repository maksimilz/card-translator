import os
import sys
import struct
import zlib
import base64
import json

def create_minimal_png_with_card(card_data: dict) -> bytes:
    # 8-byte PNG signature
    png_signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk: 1x1 pixel, 8-bit RGBA
    ihdr_data = struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data) & 0xffffffff
    ihdr_chunk = struct.pack('>I', len(ihdr_data)) + b'IHDR' + ihdr_data + struct.pack('>I', ihdr_crc)

    # IDAT chunk: empty raw scanline (filter 0 + 4 bytes RGBA) compressed
    raw_pixel = b'\x00\xff\x00\x00\xff'
    compressed_idat = zlib.compress(raw_pixel)
    idat_crc = zlib.crc32(b'IDAT' + compressed_idat) & 0xffffffff
    idat_chunk = struct.pack('>I', len(compressed_idat)) + b'IDAT' + compressed_idat + struct.pack('>I', idat_crc)

    # tEXt chunk with 'chara' keyword + base64 encoded JSON
    json_bytes = json.dumps(card_data, ensure_ascii=False).encode('utf-8')
    b64_str = base64.b64encode(json_bytes).decode('ascii')
    text_data = b'chara\x00' + b64_str.encode('ascii')
    text_crc = zlib.crc32(b'tEXt' + text_data) & 0xffffffff
    text_chunk = struct.pack('>I', len(text_data)) + b'tEXt' + text_data + struct.pack('>I', text_crc)

    # IEND chunk
    iend_crc = zlib.crc32(b'IEND') & 0xffffffff
    iend_chunk = struct.pack('>I', 0) + b'IEND' + struct.pack('>I', iend_crc)

    return png_signature + ihdr_chunk + text_chunk + idat_chunk + iend_chunk

def parse_png_card(png_bytes: bytes) -> dict:
    assert png_bytes[:8] == b'\x89PNG\r\n\x1a\n', "Invalid PNG signature"
    offset = 8
    found_card = None

    while offset < len(png_bytes):
        length = struct.unpack('>I', png_bytes[offset:offset+4])[0]
        chunk_type = png_bytes[offset+4:offset+8]
        data = png_bytes[offset+8:offset+8+length]
        crc = struct.unpack('>I', png_bytes[offset+8+length:offset+12+length])[0]
        
        # Validate CRC
        expected_crc = zlib.crc32(chunk_type + data) & 0xffffffff
        assert crc == expected_crc, f"CRC mismatch in {chunk_type} chunk"

        if chunk_type == b'tEXt':
            parts = data.split(b'\x00', 1)
            keyword = parts[0].decode('latin1')
            if keyword == 'chara':
                b64_val = parts[1].decode('ascii')
                decoded_json = base64.b64decode(b64_val).decode('utf-8')
                found_card = json.loads(decoded_json)

        if chunk_type == b'IEND':
            break

        offset += 12 + length

    return found_card

def main():
    print("--- Тестирование спецификации и чанков Character Card V2 ---")
    sample_card = {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": "Серафина Вейл",
            "description": "Хранительница тайной библиотеки с фиолетовыми глазами.",
            "personality": "Любопытная, скрытная, с тонким чувством юмора.",
            "scenario": "{{user}} находит Серафину среди древних фолиантов.",
            "first_mes": "*Серафина поднимает кристальный фонарь.* «Ты ступаешь по опасной земле, {{user}}...»",
            "mes_example": "<START>\n{{user}}: «Я ищу правду о Затмении.»\n{{char}}: *Серафина улыбается.* «Правда опасна.»",
            "alternate_greetings": [
                "*Серафина перелистывает свитки, не поднимая взгляда.* «Ты вовремя, {{user}}.»"
            ],
            "tags": ["магия", "библиотека", "фэнтези"],
            "creator": "Тестовый автор",
            "character_version": "1.0",
            "extensions": {}
        }
    }

    # 1. Create PNG
    png_data = create_minimal_png_with_card(sample_card)
    print(f"[OK] Сгенерирован тестовый PNG файл, размер: {len(png_data)} байт")

    # Save to demo file for user convenience
    os.makedirs('demo', exist_ok=True)
    demo_file = os.path.join('demo', 'sample_character_card.png')
    with open(demo_file, 'wb') as f:
        f.write(png_data)
    print(f"[OK] Демо-карточка сохранена в {demo_file}")

    # 2. Parse PNG back
    extracted = parse_png_card(png_data)
    assert extracted is not None, "Карточка не была извлечена из PNG"
    assert extracted['spec'] == 'chara_card_v2'
    assert extracted['data']['name'] == "Серафина Вейл"
    assert "{{user}}" in extracted['data']['scenario']
    assert "{{char}}" in extracted['data']['mes_example']
    assert "<START>" in extracted['data']['mes_example']
    assert extracted['data']['alternate_greetings'][0].startswith("*Серафина")
    print(f"[OK] Карточка успешно распарсена, имя: {extracted['data']['name']}")
    print(f"[OK] Кириллица, макросы {{{{user}}}} и {{{{char}}}} сохранены идеально!")

    print("\n--- Все тесты успешно пройдены! ---")

if __name__ == '__main__':
    main()
