# Lectoria

Leitor de livros e documentos com vozes neurais. O [Kavita](https://www.kavitareader.com) e um motor de voz no servidor são ambos **opcionais**: um sensor deteta o que está configurado e a responder, e a interface mostra apenas o que funciona. (Versão em inglês: [README.md](README.md).)

## Requisitos

- Node.js 22 ou superior (sem dependências de execução).
- Python 3 com `pdftotext` (poppler) para extrair texto; `mutagen` e `soundfile` para exportar MP3.
- Opcional: um servidor [Kavita](https://www.kavitareader.com) (biblioteca, progresso partilhado, início de sessão).
- Opcional: um motor de voz com `/api/voice` (aqui usa-se o [BlogArtifex](https://github.com/hubertdungen/blogartifex)). Sem ele, as vozes correm no navegador.
- Opcional: blogues públicos do Blogger (`LECTORIA_BLOGS`).

## Arrancar

```bash
git clone https://github.com/hubertdungen/Lectoria.git
cd Lectoria
npm ci
# Sem Kavita nem BlogArtifex, com vozes no navegador
HOST=127.0.0.1 LECTORIA_KAVITA_URL= LECTORIA_VOICE_URL= npm start
```

Abre http://127.0.0.1:8104. As vozes no navegador descarregam os modelos na primeira utilização e precisam de internet.

Para usar **ambos**, arranca primeiro o Kavita e o bridge de voz do BlogArtifex:

```bash
cp .env.example .env
# Edita .env com os dois URLs e o caminho da chave do bridge de voz.
set -a
. ./.env
set +a
npm start
```

A aplicação não carrega `.env` automaticamente. Deixa o URL de uma integração vazio para a desligar. A chave fica fora do Git.

A configuração é por variáveis de ambiente (modelo em `.env.example`):

| Variável | Por omissão | Para quê |
| --- | --- | --- |
| `PORT`, `HOST` | `8104`, `0.0.0.0` | Endereço de escuta |
| `LECTORIA_DATA` | `./data` | Utilizadores, sessões, tarefas |
| `LECTORIA_KAVITA_URL` | `http://127.0.0.1:5000` | Servidor Kavita; **vazio = desligado** |
| `LECTORIA_VOICE_URL` | `http://127.0.0.1:8103` | Motor de voz; **vazio = desligado** |
| `LECTORIA_VOICE_KEY_FILE` | `<data>/voice-bridge.key` | Chave partilhada com o motor de voz |
| `LECTORIA_BLOGS` | vazio | URLs do Blogger separados por vírgulas; vazio = sem secção Blogues |
| `LECTORIA_CACHE_DIR`, `LECTORIA_CACHE_MAX_MB` | `<data>/cache`, `6000` | Cache de passagens |
| `LECTORIA_CLOUD_DIR` | vazio | Pasta opcional para os MP3 prontos |
| `LECTORIA_EXPORT_DIR` | vazio | Pasta opcional para exportações Word |
| `LECTORIA_GOVERNOR` | ligado | `0` desliga o regulador de CPU/temperatura |

## Integrações opcionais

`GET /api/capabilities` (público) diz o que está configurado e o que responde neste momento (sonda de 1,5 s, em cache 30 s; 10 s após uma falha). A página lê-o no arranque e esconde o que falta.

| Kavita | Motor de voz | Resultado |
| --- | --- | --- |
| desligado | desligado | Utilizador local único, sem início de sessão. Ficheiros, texto colado e blogues (se definidos); vozes no navegador (Tugão, Kokoro). Ficam escondidas as vistas Kavita, Blogues (se não definidos) e Áudios. |
| desligado | ligado | Como acima, com as vozes do servidor, a cache de passagens e os áudios completos. |
| ligado | desligado | Início de sessão e biblioteca do Kavita; vozes no navegador; sem áudios completos. |
| ligado | ligado | Tudo. |
| configurado mas em baixo | | Aparece «indisponível de momento» no menu; nunca se entra como utilizador local para contornar o início de sessão do Kavita. |

Para ligar uma integração mais tarde, define a variável (ver `.env.example`) e reinicia. Uma instalação sem Kavita não tem palavras-passe: usa `HOST=127.0.0.1` ou põe-na atrás do teu controlo de acesso.

## Testes

```bash
npm test
```

## Licença

GPL-3.0. Ver [LICENSE](LICENSE).

Copyright (c) 2026 Hubert Dungen. Projeto DL Forge, submarca DungenLabs. Licença GPL-3.0-only, ver [LICENSE](LICENSE).
