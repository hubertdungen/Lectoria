"""Bounded, offline document extraction; no uploaded markup reaches the reader."""
import json, sys, zipfile, posixpath, subprocess, os, re
from html.parser import HTMLParser
from xml.etree import ElementTree as ET
MAX_TEXT = 2_000_000
MAX_MEMBER = 30_000_000

class Text(HTMLParser):
    """Text per block; h1-h3 headings start a new section so an article becomes topics."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip, self.sections, self.heading, self.title = [], 0, [], None, ''
    def flush(self):
        text = clean(''.join(self.parts))
        if text: self.sections.append({'title': self.title or ('Início' if not self.sections else f'Parte {len(self.sections)+1}'), 'text': text})
        self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'head', 'noscript', 'title'): self.skip += 1
        if self.skip: return
        if tag in ('h1', 'h2', 'h3'): self.flush(); self.heading = []
        elif tag in ('p', 'br', 'div', 'li', 'section'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'head', 'noscript', 'title'): self.skip = max(0, self.skip - 1)
        if self.skip: return
        if tag in ('h1', 'h2', 'h3') and self.heading is not None:
            self.title = ' '.join(''.join(self.heading).split())[:200]; self.heading = None
        elif tag in ('p', 'div', 'li', 'section'): self.parts.append('\n')
    def handle_data(self, data):
        if self.skip: return
        # Newlines inside HTML text are just whitespace (Word/EPUB wrap lines); only block tags end a paragraph.
        data = data.replace('\r', ' ').replace('\n', ' ')
        if self.heading is not None: self.heading.append(data)
        else: self.parts.append(data)
    def text(self): return clean(''.join(self.parts))
    def topics(self):
        self.flush(); return self.sections

def clean(text):
    """Paragraphs from lines. Lines broken mid-sentence (PDF text, one block per visual line in converted EPUBs) are
    joined back: a line that does not end a sentence, followed by one starting in lower case or with trailing punctuation."""
    out = []
    for line in (' '.join(p.split()) for p in text.replace('\x00', '').splitlines()):
        if not line: continue
        if out and _continues(out[-1], line):
            out[-1] = out[-1][:-1] + line if out[-1].endswith('-') and line[:1].islower() else out[-1] + ' ' + line
        else: out.append(line)
    return '\n\n'.join(out)

def _continues(prev, line):
    if prev[-1] in '.!?…:;"»”)' and not prev.endswith('-'): return False
    return line[:1].islower() or line[:1] in ',;:)»”' or (prev.endswith('-') and line[:1].isalpha())

def html_text(text):
    return '\n\n'.join(filter(None, [(s['title'] if s['title'] not in ('Início',) and not s['title'].startswith('Parte ') else '') + '\n\n' + s['text'] for s in html_topics(text)])).strip()

def html_topics(text):
    p = Text(); p.feed(text); return p.topics()

def safe_zip(file):
    z = zipfile.ZipFile(file)
    members = z.infolist()
    if len(members) > 5000 or sum(x.file_size for x in members) > 200_000_000: raise ValueError('Ficheiro comprimido demasiado grande.')
    if any(x.file_size > MAX_MEMBER or x.file_size > max(1, x.compress_size) * 1000 for x in members): raise ValueError('Ficheiro comprimido expande demasiado.')
    return z

def epub(z):
    container = ET.fromstring(z.read('META-INF/container.xml'))
    rootfile = next(x for x in container.iter() if x.tag.endswith('rootfile')).attrib['full-path']
    opf = ET.fromstring(z.read(rootfile)); base = posixpath.dirname(rootfile)
    title = next((x.text for x in opf.iter() if x.tag.endswith('}title') and x.text), 'Livro EPUB')
    manifest = {x.attrib['id']: x.attrib.get('href', '') for x in opf.iter() if x.tag.endswith('}item')}
    from urllib.parse import unquote
    sections = []
    for item in opf.iter():
        if not item.tag.endswith('}itemref'): continue
        href = manifest.get(item.attrib.get('idref'), '').split('#')[0]
        if not href: continue
        name = posixpath.normpath(posixpath.join(base, unquote(href)))
        if name.startswith('../') or name.startswith('/'): raise ValueError('Caminho EPUB inválido.')
        source = z.read(name).decode('utf-8', errors='replace'); text = html_text(source)
        if text:
            sections.append({'title': text.split('\n')[0][:100] or f'Capítulo {len(sections)+1}', 'text': text})
    return {'title': title, 'sections': sections}

def extract(file, name, depth=0):
    ext = os.path.splitext(name.lower())[1]
    if ext == '.pdf':
        result = subprocess.run(['pdftotext', file, '-'], capture_output=True, timeout=60)
        if result.returncode: raise ValueError('Não foi possível ler este PDF.')
        if len(result.stdout) > 15_000_000: raise ValueError('PDF demasiado extenso.')
        pages = result.stdout.decode('utf-8', errors='replace').split('\f')
        doc = {'title': os.path.splitext(os.path.basename(name))[0], 'sections': [{'title': f'Página {i+1}', 'text': clean(t)} for i,t in enumerate(pages) if t.strip()]}
        if not doc['sections']: raise ValueError('Este PDF não contém texto selecionável. Precisa de OCR.')
        return doc
    if ext in ('.epub', '.docx', '.zip'):
        with safe_zip(file) as z:
            if 'META-INF/container.xml' in z.namelist(): return epub(z)
            if 'word/document.xml' in z.namelist():
                root = ET.fromstring(z.read('word/document.xml'))
                text = '\n'.join(''.join(x.text or '' for x in p.iter() if x.tag.endswith('}t')) for p in root.iter() if p.tag.endswith('}p'))
                return {'title': os.path.splitext(os.path.basename(name))[0], 'sections': [{'title': 'Documento', 'text': clean(text)}]}
            if depth: raise ValueError('Formato de ficheiro não suportado.')
            supported = [x for x in z.namelist() if os.path.splitext(x.lower())[1] in ('.epub', '.pdf', '.docx', '.txt') and not x.startswith('__MACOSX/')]
            if not supported: raise ValueError('O livro não contém EPUB, PDF, DOCX ou TXT legível.')
            import tempfile
            with tempfile.TemporaryDirectory() as temp:
                target = os.path.join(temp, 'book' + os.path.splitext(supported[0])[1])
                with open(target, 'wb') as f: f.write(z.read(supported[0]))
                return extract(target, supported[0], depth+1)
    if ext in ('.html', '.htm'):
        with open(file, 'rb') as f: data = f.read(10_000_001)
        if len(data) > 10_000_000: raise ValueError('Página demasiado grande.')
        source = data.decode('utf-8', errors='replace')
        found = re.search(r'<title[^>]*>(.*?)</title>', source, re.I | re.S)
        title = html_text(found.group(1)).replace('\n', ' ') if found else os.path.splitext(os.path.basename(name))[0]
        # One section per article: headings stay in the text as their own paragraphs, so the whole piece reads top to bottom.
        return {'title': title[:300] or 'Artigo', 'sections': [{'title': 'Artigo', 'text': html_text(source)}]}
    if ext in ('.txt', '.md'):
        with open(file, 'rb') as f: data = f.read(10_000_001)
        if len(data) > 10_000_000: raise ValueError('Texto demasiado grande.')
        try: text = data.decode('utf-8-sig')
        except UnicodeDecodeError: text = data.decode('cp1252', errors='replace')
        return {'title': os.path.splitext(os.path.basename(name))[0], 'sections': [{'title': 'Texto', 'text': clean(text)}]}
    raise ValueError('Formato não suportado. Usa EPUB, PDF, DOCX, HTML ou TXT.')

if __name__ == '__main__':
    try:
        doc = extract(sys.argv[1], sys.argv[2])
        if not doc['sections'] or not any(s['text'].strip() for s in doc['sections']): raise ValueError('O documento não contém texto legível.')
        if sum(len(s['text']) for s in doc['sections']) > MAX_TEXT: raise ValueError('Documento demasiado extenso (máximo dois milhões de caracteres).')
        print(json.dumps(doc, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else 'Não foi possível extrair o texto deste documento.'}, ensure_ascii=False)); sys.exit(1)
