import os
import sys
import struct
import zlib
import base64
import json
import unittest
import urllib.parse
from io import BytesIO

# Import server handler from run.py
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from run import ProxyAndStaticServer

def create_minimal_png_with_card(card_data: dict) -> bytes:
    png_signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk: 1x1 pixel, 8-bit RGBA
    ihdr_data = struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data) & 0xffffffff
    ihdr_chunk = struct.pack('>I', len(ihdr_data)) + b'IHDR' + ihdr_data + struct.pack('>I', ihdr_crc)

    # IDAT chunk: empty raw scanline compressed
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

class DummyRequest:
    def __init__(self, headers=None, path='/', method='GET', body=b''):
        self.headers = headers or {}
        self.path = path
        self.command = method
        self.rfile = BytesIO(body)
        self.wfile = BytesIO()

    def makefile(self, *args, **kwargs):
        return BytesIO()

class MockProxyHandler(ProxyAndStaticServer):
    def __init__(self, dummy_req):
        self.headers = dummy_req.headers
        self.path = dummy_req.path
        self.command = dummy_req.command
        self.request_version = 'HTTP/1.1'
        self.rfile = dummy_req.rfile
        self.wfile = dummy_req.wfile
        self._headers_buffer = []
        self.sent_headers = {}
        self.status_code = None

    def send_response(self, code, message=None):
        self.status_code = code

    def send_header(self, keyword, value):
        self.sent_headers[keyword.lower()] = value

    def end_headers(self):
        super().end_headers()

class TestCharacterCard(unittest.TestCase):
    def setUp(self):
        self.sample_card = {
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
                "character_book": {
                    "name": "Лорбук Астральной Библиотеки",
                    "description": "Справочник древних знаний",
                    "entries": [
                        {
                            "keys": ["астральная библиотека", "astral library"],
                            "content": "Древнее хранилище знаний, парящее в межпространстве.",
                            "comment": "Локация библиотеки",
                            "enabled": True
                        }
                    ]
                },
                "extensions": {}
            }
        }

    def test_png_roundtrip_with_character_book(self):
        png_data = create_minimal_png_with_card(self.sample_card)
        self.assertTrue(len(png_data) > 0)
        self.assertEqual(png_data[:8], b'\x89PNG\r\n\x1a\n')

        extracted = parse_png_card(png_data)
        self.assertIsNotNone(extracted)
        self.assertEqual(extracted['spec'], 'chara_card_v2')
        self.assertEqual(extracted['data']['name'], "Серафина Вейл")
        self.assertIn("{{user}}", extracted['data']['scenario'])
        self.assertIn("{{char}}", extracted['data']['mes_example'])
        self.assertIn("<START>", extracted['data']['mes_example'])

        # Verify character_book preservation
        self.assertIn('character_book', extracted['data'])
        cb = extracted['data']['character_book']
        self.assertEqual(cb['name'], "Лорбук Астральной Библиотеки")
        self.assertEqual(len(cb['entries']), 1)
        self.assertIn("астральная библиотека", cb['entries'][0]['keys'])
        self.assertIn("astral library", cb['entries'][0]['keys'])

    def test_cors_local_origins_allowed(self):
        # 127.0.0.1 origin
        req1 = DummyRequest(headers={'Origin': 'http://127.0.0.1:8000'})
        handler1 = MockProxyHandler(req1)
        handler1.end_headers()
        self.assertEqual(handler1.sent_headers.get('access-control-allow-origin'), 'http://127.0.0.1:8000')

        # localhost origin
        req2 = DummyRequest(headers={'Origin': 'http://localhost:5173'})
        handler2 = MockProxyHandler(req2)
        handler2.end_headers()
        self.assertEqual(handler2.sent_headers.get('access-control-allow-origin'), 'http://localhost:5173')

        # IPv6 localhost origin
        req3 = DummyRequest(headers={'Origin': 'http://[::1]:8000'})
        handler3 = MockProxyHandler(req3)
        handler3.end_headers()
        self.assertEqual(handler3.sent_headers.get('access-control-allow-origin'), 'http://[::1]:8000')

    def test_cors_external_origins_blocked(self):
        # Malicious external web origin
        req = DummyRequest(headers={'Origin': 'https://malicious-site.com'})
        handler = MockProxyHandler(req)
        handler.end_headers()
        self.assertNotIn('access-control-allow-origin', handler.sent_headers)

        # Attacker subdomain
        req2 = DummyRequest(headers={'Origin': 'http://localhost.evil.com'})
        handler2 = MockProxyHandler(req2)
        handler2.end_headers()
        self.assertNotIn('access-control-allow-origin', handler2.sent_headers)

    def test_ssrf_protection_blocked_schemes(self):
        req = DummyRequest(path='/api-proxy?target=file:///etc/passwd')
        handler = MockProxyHandler(req)
        handler.handle_proxy()
        self.assertEqual(handler.status_code, 400)
        self.assertIn(b"only http and https", handler.wfile.getvalue())

    def test_ssrf_protection_blocked_metadata_ip(self):
        req = DummyRequest(path='/api-proxy?target=http://169.254.169.254/latest/meta-data/')
        handler = MockProxyHandler(req)
        handler.handle_proxy()
        self.assertEqual(handler.status_code, 403)
        self.assertIn(b"cloud metadata IP", handler.wfile.getvalue())

        # IPv6-mapped IPv4 metadata address
        req2 = DummyRequest(path='/api-proxy?target=http://[::ffff:169.254.169.254]/latest/')
        handler2 = MockProxyHandler(req2)
        handler2.handle_proxy()
        self.assertEqual(handler2.status_code, 403)

        # Trailing dot metadata address
        req3 = DummyRequest(path='/api-proxy?target=http://169.254.169.254./')
        handler3 = MockProxyHandler(req3)
        handler3.handle_proxy()
        self.assertEqual(handler3.status_code, 403)

    def test_ssrf_protection_blocked_google_metadata(self):
        req = DummyRequest(path='/api-proxy?target=http://metadata.google.internal/computeMetadata/v1/')
        handler = MockProxyHandler(req)
        handler.handle_proxy()
        self.assertEqual(handler.status_code, 403)

        req2 = DummyRequest(path='/api-proxy?target=http://metadata.google.internal./computeMetadata/v1/')
        handler2 = MockProxyHandler(req2)
        handler2.handle_proxy()
        self.assertEqual(handler2.status_code, 403)

    def test_additive_lorebook_keys(self):
        keys_original = ["astral library", "tome of shadows"]
        keys_translated = ["астральная библиотека", "astral library", "фолиант теней"]
        # In JS: [...new Set([...keys_original, ...keys_translated])]
        keys_final = list(dict.fromkeys(keys_original + keys_translated))
        self.assertEqual(len(keys_final), 4)
        self.assertIn("astral library", keys_final)
        self.assertIn("tome of shadows", keys_final)
        self.assertIn("астральная библиотека", keys_final)
        self.assertIn("фолиант теней", keys_final)

    def test_xml_regex_parsing(self):
        xml_response = """
<name>Серафина Вейл</name>
<first_mes>«Привет, {{user}}», — сказала она.</first_mes>
<description lang="ru">Хранительница библиотеки.</description>
<Personality>Любопытная и скрытная.</Personality>
<entry_0_content>Секретный отдел.</entry_0_content>
<entry_0_keys>секретный отдел, тайная комната</entry_0_keys>
"""
        import re
        raw_matches = re.findall(r'<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>', xml_response, flags=re.IGNORECASE)
        matches = {k.lower().replace('-', '_'): v.strip() for k, v in raw_matches}
        self.assertIn('name', matches)
        self.assertEqual(matches['name'], 'Серафина Вейл')
        self.assertIn('first_mes', matches)
        self.assertIn('{{user}}', matches['first_mes'])
        self.assertIn('description', matches)
        self.assertEqual(matches['description'], 'Хранительница библиотеки.')
        self.assertIn('personality', matches)
        self.assertEqual(matches['personality'], 'Любопытная и скрытная.')
        self.assertIn('entry_0_keys', matches)

    def test_xml_truncated_tail_tag(self):
        import re
        xml_response = "<name>Seraphina</name>\n<first_mes>*She turned* <START>\n{{user}}: Hello"
        raw_matches = re.findall(r'<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>', xml_response, flags=re.IGNORECASE)
        matches = {k.lower().replace('-', '_'): v.strip() for k, v in raw_matches}

        last_closed_end = 0
        for m in re.finditer(r'<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>', xml_response, flags=re.IGNORECASE):
            last_closed_end = m.end()
        remaining = xml_response[last_closed_end:].strip()
        unclosed = re.search(r'<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]+)$', remaining, flags=re.IGNORECASE)
        if unclosed:
            tag = unclosed.group(1).lower().replace('-', '_')
            if tag not in matches:
                matches[tag] = unclosed.group(2).strip()

        self.assertIn('first_mes', matches)
        self.assertIn('<START>', matches['first_mes'])

    def test_reasoning_and_macro_cleaning(self):
        import re
        # Clean reasoning
        raw_output = "<think>Here is my chain of thought\nCharacter is female.</think>\n<first_mes>*\u041e\u043d\u0430 \u0443\u043b\u044b\u0431\u043d\u0443\u043b\u0430\u0441\u044c*</first_mes>"
        cleaned = re.sub(r'<think>[\s\S]*?(?:<\/think>|$)', '', raw_output, flags=re.IGNORECASE).strip()
        self.assertNotIn('chain of thought', cleaned)
        self.assertEqual(cleaned, '<first_mes>*\u041e\u043d\u0430 \u0443\u043b\u044b\u0431\u043d\u0443\u043b\u0430\u0441\u044c*</first_mes>')

        # Repair macros: {char}, {user}, {{персонаж}}, {{пользователя}}, <start>, {{{char}}}
        text = "Hello {char}, I am {user}. {{{char}}} talks to {{\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f}} at <start>."
        repaired = re.sub(r'\{{1,3}\s*(?:char|' + '\u043f\u0435\u0440\u0441\u043e\u043d\u0430\u0436[\u0430-\u044f\u0451]*|\u0431\u043e\u0442[\u0430-\u044f\u0451]*|\u043f\u0435\u0440\u0441[\u0430-\u044f\u0451]*' + r')\s*\}{1,3}', '{{char}}', text, flags=re.IGNORECASE)
        repaired = re.sub(r'\{{1,3}\s*(?:user|' + '\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b[\u0430-\u044f\u0451]*|\u044e\u0437\u0435\u0440[\u0430-\u044f\u0451]*|\u0438\u0433\u0440\u043e\u043a[\u0430-\u044f\u0451]*' + r')\s*\}{1,3}', '{{user}}', repaired, flags=re.IGNORECASE)
        repaired = re.sub(r'(?:\[\s*START\s*\]|<\s*start\s*>|\[' + '\u0441\u0442\u0430\u0440\u0442' + r'\]|<' + '\u0441\u0442\u0430\u0440\u0442' + r'>)', '<START>', repaired, flags=re.IGNORECASE)
        self.assertEqual(repaired, "Hello {{char}}, I am {{user}}. {{char}} talks to {{user}} at <START>.")

    def test_balance_asterisks_with_lists_and_breaks(self):
        import re
        def balance_asterisks(text):
            cleaned = re.sub(r'^\s*(?:\*\s*){3,}\s*$', '', text, flags=re.MULTILINE)
            cleaned = re.sub(r'^\s*\*\s+', '', cleaned, flags=re.MULTILINE)
            count = len(re.findall(r'\*', cleaned))
            if count % 2 != 0:
                return text.rstrip() + '*'
            return text

        # Test unclosed italic
        self.assertEqual(balance_asterisks("*She sighs and looks away"), "*She sighs and looks away*")
        # Test closed italic
        self.assertEqual(balance_asterisks("*She sighs* and looks away"), "*She sighs* and looks away")
        # Test markdown list bullet points (should NOT add asterisk)
        list_text = "* Feature 1\n* Feature 2\n* Feature 3"
        self.assertEqual(balance_asterisks(list_text), list_text)
        # Test horizontal rule (should NOT add asterisk)
        rule_text = "***\n*Action begins*"
        self.assertEqual(balance_asterisks(rule_text), rule_text)

    def test_preamble_and_codeblock_cleaning(self):
        import re
        def clean_model_preamble(text):
            if not text:
                return ''
            res = text.strip()
            # Strip reasoning
            res = re.sub(r'<think>[\s\S]*?(?:<\/think>|$)', '', res, flags=re.IGNORECASE).strip()
            # Remove chat opener before code block
            chat_opener = r'^(?:(?:Конечно|Разумеется)[!,.]?\s*)?(?:Вот\s+(?:готовый\s+)?перевод(?:\s+(?:текста|поля|карточки|сообщения))?|Перевод(?:\s+(?:текста|поля|карточки|сообщения))?|Here\s+(?:is|are)\s+(?:the\s+)?(?:translation|translated\s+(?:text|card|fields))|Here\'s\s+the\s+translation):\s*\n+'
            res = re.sub(chat_opener, '', res, flags=re.IGNORECASE).strip()
            # Strip code block
            m = re.match(r'^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$', res)
            if m:
                res = m.group(1).strip()
            else:
                res = re.sub(r'^```(?:[a-zA-Z0-9_-]+)?\s*\n?', '', res, flags=re.IGNORECASE).strip()
                res = re.sub(r'\n?```\s*$', '', res).strip()
            res = re.sub(chat_opener, '', res, flags=re.IGNORECASE).strip()
            return res

        # 1. Chat opener + wrapped code block
        input1 = "Конечно, вот перевод карточки:\n```xml\n<name>Серафина</name>\n```"
        self.assertEqual(clean_model_preamble(input1), "<name>Серафина</name>")

        # 2. English chat opener
        input2 = "Here is the translation:\n\n*Seraphina smiles.*"
        self.assertEqual(clean_model_preamble(input2), "*Seraphina smiles.*")

        # 3. Truncated unclosed code block
        input3 = "Here's the translation:\n```\n*Action text*"
        self.assertEqual(clean_model_preamble(input3), "*Action text*")

    def test_additive_lorebook_keys_multi_delimiters(self):
        import re
        entry_keys_str = "astral library, tome of shadows; ancient archive\ncelestial observatory"
        orig_keys = [k.strip() for k in re.split(r'[\n,;]+', entry_keys_str) if k.strip()]
        
        xml_keys_str = "астральная библиотека, фолиант теней\nдревний архив"
        xml_keys = [k.strip() for k in re.split(r'[\n,;]+', xml_keys_str) if k.strip()]
        
        passport_dict = {
            "astral library": "астральная библиотека",
            "ancient archive": "древний архив, тайное хранилище"
        }
        passport_keys = []
        for k in orig_keys:
            mapped = passport_dict.get(k.lower())
            if mapped:
                passport_keys.extend([x.strip() for x in re.split(r'[\n,;]+', mapped) if x.strip()])
                
        final_keys = list(dict.fromkeys(orig_keys + xml_keys + passport_keys))
        self.assertIn("astral library", final_keys)
        self.assertIn("tome of shadows", final_keys)
        self.assertIn("ancient archive", final_keys)
        self.assertIn("celestial observatory", final_keys)
        self.assertIn("астральная библиотека", final_keys)
        self.assertIn("фолиант теней", final_keys)
        self.assertIn("древний архив", final_keys)
        self.assertIn("тайное хранилище", final_keys)

    def test_js_files_balance(self):
        import glob
        js_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'js'))
        kw_regex = {'return', 'case', 'typeof', 'delete', 'void', 'throw', 'new', 'in', 'instanceof', 'yield', 'await'}

        for js_file in glob.glob(os.path.join(js_dir, '*.js')):
            with open(js_file, 'r', encoding='utf-8') as f:
                code = f.read()

            i = 0
            n = len(code)
            stack = []
            prev_tok = None

            while i < n:
                c = code[i]
                if c in ' \t\r\n':
                    i += 1
                    continue
                if c == '/' and i + 1 < n and code[i+1] == '/':
                    i += 2
                    while i < n and code[i] != '\n':
                        i += 1
                    continue
                if c == '/' and i + 1 < n and code[i+1] == '*':
                    i += 2
                    while i + 1 < n and not (code[i] == '*' and code[i+1] == '/'):
                        i += 1
                    i += 2
                    continue
                if c == '/':
                    if prev_tok is None or prev_tok == 'punc' or prev_tok in kw_regex:
                        i += 1
                        in_cc = False
                        while i < n:
                            if code[i] == '\\':
                                i += 2
                            elif code[i] == '[':
                                in_cc = True
                                i += 1
                            elif code[i] == ']' and in_cc:
                                in_cc = False
                                i += 1
                            elif code[i] == '/' and not in_cc:
                                i += 1
                                break
                            elif code[i] == '\n':
                                break
                            else:
                                i += 1
                        while i < n and code[i].isalnum():
                            i += 1
                        prev_tok = 'val'
                        continue
                    else:
                        prev_tok = 'punc'
                        i += 1
                        continue
                if c in ("'", '"'):
                    q = c
                    i += 1
                    while i < n:
                        if code[i] == '\\':
                            i += 2
                        elif code[i] == q:
                            i += 1
                            break
                        elif code[i] == '\n':
                            break
                        else:
                            i += 1
                    prev_tok = 'val'
                    continue
                if c == '`':
                    i += 1
                    mode = 'template'
                    while i < n:
                        if code[i] == '\\':
                            i += 2
                        elif code[i] == '`':
                            i += 1
                            break
                        elif code[i] == '$' and i + 1 < n and code[i+1] == '{':
                            stack.append(('`', i))
                            stack.append(('${', i))
                            i += 2
                            prev_tok = 'punc'
                            mode = 'code'
                            break
                        else:
                            i += 1
                    if mode == 'template':
                        prev_tok = 'val'
                    continue
                if c in '({[':
                    stack.append((c, i))
                    prev_tok = 'punc'
                    i += 1
                    continue
                if c in ')}]':
                    self.assertTrue(len(stack) > 0, f"Unmatched closing '{c}' in {os.path.basename(js_file)}")
                    top, pos = stack[-1]
                    if top == '${' and c == '}':
                        stack.pop()
                        if stack and stack[-1][0] == '`':
                            i += 1
                            while i < n:
                                if code[i] == '\\':
                                    i += 2
                                elif code[i] == '`':
                                    stack.pop()
                                    i += 1
                                    prev_tok = 'val'
                                    break
                                elif code[i] == '$' and i + 1 < n and code[i+1] == '{':
                                    stack.append(('${', i))
                                    i += 2
                                    prev_tok = 'punc'
                                    break
                                else:
                                    i += 1
                            continue
                    expected = {'(': ')', '{': '}', '[': ']'}.get(top)
                    self.assertEqual(c, expected, f"Mismatched bracket in {os.path.basename(js_file)}")
                    stack.pop()
                    prev_tok = 'val'
                    i += 1
                    continue
                if c.isalpha() or c in '_$':
                    start = i
                    while i < n and (code[i].isalnum() or code[i] in '_$'):
                        i += 1
                    word = code[start:i]
                    prev_tok = word if word in kw_regex else 'ident'
                    continue
                if c.isdigit():
                    while i < n and (code[i].isalnum() or code[i] in '._'):
                        i += 1
                    prev_tok = 'val'
                    continue
                prev_tok = 'punc'
                i += 1

            self.assertEqual(len(stack), 0, f"Unclosed brackets at EOF in {os.path.basename(js_file)}: {[s[0] for s in stack]}")

if __name__ == '__main__':
    unittest.main()
