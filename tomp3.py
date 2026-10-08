"""WAV -> MP3 in one-minute blocks (libsndfile >= 1.1), so a ten-hour audiobook never sits in RAM."""
import sys, soundfile as sf
with sf.SoundFile(sys.argv[1]) as src, sf.SoundFile(sys.argv[2], 'w', samplerate=src.samplerate, channels=src.channels, format='MP3') as out:
    for block in src.blocks(blocksize=src.samplerate * 60, dtype='int16'):
        out.write(block)
