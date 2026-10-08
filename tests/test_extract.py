import unittest, tempfile, zipfile, pathlib, sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from extract import extract, html_text, safe_zip
class Extraction(unittest.TestCase):
 def test_markup_is_text_and_scripts_are_removed(self):
  self.assertEqual(html_text('<p>Olá &amp; mundo.</p><script>alert(1)</script><style>.x{}</style><p>Outra frase.</p>'),'Olá & mundo.\n\nOutra frase.')
 def test_epub_uses_spine_order_not_zip_order(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'sample.epub'
   with zipfile.ZipFile(p,'w') as z:
    z.writestr('META-INF/container.xml','<container><rootfile full-path="OPS/content.opf"/></container>')
    z.writestr('OPS/content.opf','<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Um livro</dc:title></metadata><manifest><item id="b" href="b.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>')
    z.writestr('OPS/b.xhtml','<p>Segunda página.</p>');z.writestr('OPS/a.xhtml','<p>Primeira página.</p>')
   doc=extract(str(p),'sample.epub');self.assertEqual(doc['title'],'Um livro');self.assertEqual([x['text'] for x in doc['sections']],['Primeira página.','Segunda página.'])
 def test_archive_expansion_is_bounded(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'bomb.zip'
   with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED)as z:z.writestr('a.txt','a'*10_000_000)
   with self.assertRaises(ValueError):safe_zip(p)
 def test_docx_extracts_paragraphs(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'sample.docx'
   with zipfile.ZipFile(p,'w')as z:z.writestr('word/document.xml','<w:document xmlns:w="urn:test"><w:p><w:r><w:t>Olá Portugal.</w:t></w:r></w:p></w:document>')
   self.assertEqual(extract(str(p),'sample.docx')['sections'][0]['text'],'Olá Portugal.')
