import unittest, tempfile, zipfile, pathlib, sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from extract import extract, html_text, safe_zip
class Extraction(unittest.TestCase):
 def test_markup_is_text_and_scripts_are_removed(self):
  self.assertEqual(html_text('<p>Olá &amp; mundo.</p><script>alert(1)</script><style>.x{}</style><p>Outra frase.</p>'),'Olá & mundo.\n\nOutra frase.')
 def test_html_articles_split_into_topics_at_headings(self):
  from extract import html_topics
  topics=html_topics('<p>Abertura.</p><h2>Primeiro tema</h2><p>Um.</p><p>Dois.</p><h3>Segundo tema</h3><p>Três.</p>')
  self.assertEqual([(t['title'],t['text']) for t in topics],[('Início','Abertura.'),('Primeiro tema','Um.\n\nDois.'),('Segundo tema','Três.')])
  self.assertEqual(html_text('<h1>Capítulo 1</h1><p>Era uma vez.</p>'),'Capítulo 1\n\nEra uma vez.')
 def test_wrapped_lines_inside_paragraphs_do_not_split_them(self):
  self.assertEqual(html_text('<p>A Europa, com a sua rica génese, foi\nsempre um terreno\r\nfértil.</p><p>Outro<br>parágrafo.</p><h2>Título<o:p></o:p></h2><p>Fim.</p>'),'A Europa, com a sua rica génese, foi sempre um terreno fértil.\n\nOutro parágrafo.\n\nTítulo\n\nFim.')
 def test_lines_broken_mid_sentence_are_joined(self):
  from extract import clean
  self.assertEqual(clean('A casa que os Maias vieram habitar em Lisboa,\nno outono de 1875, era conhe-\ncida na vizinhança.\nEra uma frase nova.\n\nCapítulo II\nOutra abertura.'),'A casa que os Maias vieram habitar em Lisboa, no outono de 1875, era conhecida na vizinhança.\n\nEra uma frase nova.\n\nCapítulo II\n\nOutra abertura.')
  self.assertEqual(html_text('<p>Uma linha que continua</p><p>na linha seguinte.</p><p>Nova frase.</p>'),'Uma linha que continua na linha seguinte.\n\nNova frase.')
 def test_chapter_heading_followed_by_scene_heading_is_kept(self):
  self.assertEqual(html_text('<h2>Capítulo Um — O Último Homem</h2><h3>Varsóvia — 2028</h3><p>Texto.</p>'),'Capítulo Um — O Último Homem\n\nVarsóvia — 2028\n\nTexto.')
 def test_html_article_is_a_single_section(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'post.html'; p.write_text('<title>Art</title><p>Intro.</p><h2>Um</h2><p>Texto um.</p><h3>Dois</h3><p>Texto dois.</p>',encoding='utf-8')
   doc=extract(str(p),'post.html'); self.assertEqual(doc['title'],'Art'); self.assertEqual(len(doc['sections']),1); self.assertEqual(doc['sections'][0]['text'],'Intro.\n\nUm\n\nTexto um.\n\nDois\n\nTexto dois.')
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

class AnchorsTest(unittest.TestCase):
    def test_xpaths_match_kavita(self):
        from extract import Anchors
        a = Anchors(); a.feed('<html><body><div id="c"><p>Um <span>dois</span></p><p> </p><p>Três</p></div><h2>Fim</h2><br/><p>Último</p></body></html>')
        self.assertEqual([(x['xpath'], x['idpath'], x['text']) for x in a.result()], [
            ('//body/div[1]/p[1]', 'id("c")/p[1]', 'Um dois'), ('//body/div[1]/p[3]', 'id("c")/p[3]', 'Três'),
            ('//body/h2[1]', None, 'Fim'), ('//body/p[1]', None, 'Último')])
