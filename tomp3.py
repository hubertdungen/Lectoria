"""WAV -> MP3 in one-minute blocks (libsndfile >= 1.1), so a ten-hour audiobook never sits in RAM.
Optional args: title, artist, album, cover image path (ID3 tags via mutagen when installed)."""
import sys, soundfile as sf
src_path, out_path = sys.argv[1], sys.argv[2]
with sf.SoundFile(src_path) as src, sf.SoundFile(out_path, 'w', samplerate=src.samplerate, channels=src.channels, format='MP3') as out:
    for block in src.blocks(blocksize=src.samplerate * 60, dtype='int16'):
        out.write(block)
if len(sys.argv) > 3:
    try:
        from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC, ID3NoHeaderError
        try: tags = ID3(out_path)
        except ID3NoHeaderError: tags = ID3()
        title, artist, album = (sys.argv + ['', '', ''])[3:6]
        if title: tags.add(TIT2(encoding=3, text=title))
        if artist: tags.add(TPE1(encoding=3, text=artist))
        if album: tags.add(TALB(encoding=3, text=album))
        cover = sys.argv[6] if len(sys.argv) > 6 else ''
        if cover:
            data = open(cover, 'rb').read()
            mime = 'image/png' if data[:4] == b'\x89PNG' else 'image/webp' if data[8:12] == b'WEBP' else 'image/jpeg'
            tags.add(APIC(encoding=3, mime=mime, type=3, desc='Cover', data=data))
        tags.save(out_path)
    except Exception as error:  # tags are a bonus: the audio file is already complete
        print('tags skipped: ' + str(error), file=sys.stderr)
