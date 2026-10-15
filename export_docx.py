"""Word export: the document's text with the reader's marks as native Word features.
Bookmarks become Word bookmarks (Insert > Bookmark > Go To), notes become Word comments, highlights keep their colour
(as run shading, exact colour), chapters are Heading 1 so they show in the Navigation Pane, and a list of the bookmarks
with links opens the document. Standard library only. Input: JSON on stdin; output: the .docx bytes on stdout.

Input: {"title", "subtitle", "author", "sections": [{"title", "text"}],
        "marks": [{"kind": "bookmark"|"note", "section", "start", "end", "comment", "color": [r, g, b], "label", "author"}]}
start/end are character offsets in the section text (paragraphs separated by blank lines)."""
import io, json, re, sys, unicodedata, zipfile
from datetime import datetime, timezone

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
BAD = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]')

def esc(t):
    return BAD.sub('', str(t)).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

def run(text, shade=None, style=None):
    props = (f'<w:rStyle w:val="{style}"/>' if style else '') + (f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>' if shade else '')
    return f'<w:r>{"<w:rPr>" + props + "</w:rPr>" if props else ""}<w:t xml:space="preserve">{esc(text)}</w:t></w:r>'

def para(inner, style=None, page_break=False):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ''
    return f'<w:p>{ppr}{"<w:r><w:br w:type=\"page\"/></w:r>" if page_break else ""}{inner}</w:p>'

def tint(rgb, alpha=0.45):
    """The highlight colour as it looks over white paper."""
    r, g, b = (round(255 - (255 - c) * alpha) for c in rgb)
    return f'{r:02X}{g:02X}{b:02X}'

def bookmark_name(label, n, used):
    ascii_ = unicodedata.normalize('NFKD', label).encode('ascii', 'ignore').decode()
    slug = re.sub(r'[^A-Za-z0-9]+', '_', ascii_).strip('_')[:28]
    name = f'M{n:02d}_{slug}' if slug else f'M{n:02d}'
    while name in used: name += 'x'
    used.add(name)
    return name[:40]

def paragraphs(text):
    """(start, end) of every paragraph in the section text."""
    out, at = [], 0
    for part in text.split('\n'):
        if part.strip(): out.append((at, at + len(part)))
        at += len(part) + 1
    return out

def build(data):
    author = data.get('author') or 'Lectoria'
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    marks, used = [], set()
    for n, m in enumerate(sorted(data.get('marks', []), key=lambda m: (m['section'], m['start'])), 1):
        m = dict(m); m['id'] = n
        if m['kind'] == 'bookmark': m['name'] = bookmark_name(m.get('label') or 'Marcador', n, used)
        marks.append(m)
    comments = [m for m in marks if m['kind'] == 'note' and m.get('comment')]
    body = [para(run(data.get('title') or 'Documento'), 'Title')]
    if data.get('subtitle'): body.append(para(run(data['subtitle']), 'Subtitle'))
    bookmarks = [m for m in marks if m['kind'] == 'bookmark']
    notes = [m for m in marks if m['kind'] == 'note']
    if bookmarks or notes:
        body.append(para(run('Marcadores e notas'), 'Heading2'))
        body.append(para(run(f'{len(bookmarks)} marcador(es), {len(notes)} destaque(s)/nota(s). Os marcadores estão também em Inserir › Marcador; as notas são comentários.'), 'Small'))
        for m in bookmarks:
            chapter = data['sections'][m['section']]['title']
            body.append(para(f'<w:hyperlink w:anchor="{m["name"]}" w:history="1">{run(m.get("label") or "Marcador", style="Hyperlink")}</w:hyperlink>{run(" — " + chapter)}', 'ListParagraph'))
    for si, section in enumerate(data['sections']):
        text = section['text']
        here = [m for m in marks if m['section'] == si]
        body.append(para(run(section['title'] or f'Capítulo {si + 1}'), 'Heading1', page_break=si > 0 or bool(bookmarks or notes)))
        title = (section['title'] or '').strip()
        for pi, (ps, pe) in enumerate(paragraphs(text)):
            if pi == 0 and title and text[ps:pe].strip() == title: continue  # the heading already says it
            cuts = {ps, pe}
            for m in here:
                for x in (m['start'], m['end']):
                    if ps < x < pe: cuts.add(x)
            cuts = sorted(cuts)
            out = []
            for a, b in zip(cuts, cuts[1:]):
                for m in here:  # each mark opens on the first piece of text at or after its position
                    if m['kind'] == 'bookmark' and not m.get('_done') and m['start'] <= a:
                        out.append(f'<w:bookmarkStart w:id="{m["id"]}" w:name="{m["name"]}"/><w:bookmarkEnd w:id="{m["id"]}"/>'); m['_done'] = True
                    if m['kind'] == 'note' and m.get('comment') and not m.get('_started') and m['start'] <= a:
                        out.append(f'<w:commentRangeStart w:id="{m["id"]}"/>'); m['_started'] = True
                active = [m for m in here if m['kind'] == 'note' and m['start'] <= a and b <= m['end']]
                out.append(run(text[a:b], shade=tint(active[-1]['color']) if active else None))
                for m in here:
                    if m['kind'] == 'note' and m.get('comment') and m.get('_started') and not m.get('_ended') and b >= m['end']:
                        out.append(f'<w:commentRangeEnd w:id="{m["id"]}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{m["id"]}"/></w:r>'); m['_ended'] = True
            body.append(para(''.join(out)))
        for m in here:  # a mark past the last paragraph (end of the chapter)
            if m['kind'] == 'bookmark' and not m.get('_done'):
                body.append(para(f'<w:bookmarkStart w:id="{m["id"]}" w:name="{m["name"]}"/><w:bookmarkEnd w:id="{m["id"]}"/>')); m['_done'] = True
            if m['kind'] == 'note' and m.get('comment') and not m.get('_ended'):
                if not m.get('_started'): body.append(para(f'<w:commentRangeStart w:id="{m["id"]}"/>'))
                body.append(para(f'<w:commentRangeEnd w:id="{m["id"]}"/><w:r><w:commentReference w:id="{m["id"]}"/></w:r>')); m['_ended'] = True
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>{"".join(body)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>'
    comment_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments {W}>' + ''.join(
        f'<w:comment w:id="{m["id"]}" w:author="{esc(m.get("author") or author)}" w:date="{now}" w:initials="{esc((m.get("author") or author)[:2].upper())}">'
        + ''.join(para(run(line)) for line in (m['comment'].split('\n') or ['']))
        + '</w:comment>' for m in comments) + '</w:comments>'
    styles = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="24"/><w:lang w:val="pt-PT"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="666666"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Lectoria small"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="360"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5C99"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>'''
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
        z.writestr('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')
        z.writestr('docProps/core.xml', f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>{esc(data.get("title") or "")}</dc:title><dc:creator>{esc(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created></cp:coreProperties>')
        z.writestr('word/document.xml', document)
        z.writestr('word/styles.xml', styles)
        z.writestr('word/comments.xml', comment_xml)
    return out.getvalue()

if __name__ == '__main__':
    sys.stdout.buffer.write(build(json.load(sys.stdin)))
