#!/usr/bin/env python3
"""
PipeWire Real-Time Audio FFT Spectrum Helper
Taps PipeWire monitor stream, calculates 16-band logarithmic FFT,
and streams JSON arrays of 16 bar values (0.0 to 1.0) to stdout.
"""
import sys
import os
import time
import math
import struct
import subprocess

N = 256
HALF_N = N // 2
SAMPLE_RATE = 44100

# 16 Logarithmic frequency bin groupings for 256 FFT bins (172Hz per bin)
BAND_MAP = [
    [1],                                                  # 0: ~172Hz (Sub Bass)
    [2],                                                  # 1: ~344Hz (Sub Bass)
    [3],                                                  # 2: ~516Hz (Bass)
    [4, 5],                                               # 3: ~688-860Hz (Bass)
    [6, 7],                                               # 4: ~1.0-1.2kHz (Low Mid)
    [8, 9, 10],                                           # 5: ~1.3-1.7kHz (Mid)
    [11, 12, 13, 14],                                     # 6: ~1.9-2.4kHz (Mid)
    [15, 16, 17, 18, 19],                                 # 7: ~2.5-3.2kHz (Upper Mid)
    [20, 21, 22, 23, 24, 25],                             # 8: ~3.4-4.3kHz (Upper Mid)
    [26, 27, 28, 29, 30, 31, 32],                         # 9: ~4.4-5.5kHz (Presence)
    [33, 34, 35, 36, 37, 38, 39, 40],                     # 10: ~5.6-6.8kHz (Presence)
    [41, 42, 43, 44, 45, 46, 47, 48, 49, 50],             # 11: ~7.0-8.6kHz (Brilliance)
    [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62],     # 12: ~8.7-10.6kHz (Brilliance)
    [63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75], # 13: ~10.8-12.9kHz (Treble)
    [76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90], # 14: ~13.0-15.5kHz (High Treble)
    [91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120] # 15: ~15.6-20.6kHz (Air)
]

# Precompute Hann Window
HANN = [0.5 * (1 - math.cos(2 * math.pi * i / (N - 1))) for i in range(N)]

# Precompute Cos/Sin tables for 128 positive FFT bins
COS_TABLE = []
SIN_TABLE = []
for k in range(HALF_N):
    COS_TABLE.append([math.cos(-2 * math.pi * k * n / N) for n in range(N)])
    SIN_TABLE.append([math.sin(-2 * math.pi * k * n / N) for n in range(N)])

def main():
    # Start pw-record to tap PipeWire monitor output
    cmd = ['pw-record', '--channels=1', '--rate=44100', '--format=s16', '-']
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception as e:
        sys.stderr.write(f"Error launching pw-record: {e}\n")
        sys.exit(1)

    peak_gain = 0.05
    decay_speed = 0.992

    try:
        while True:
            raw = proc.stdout.read(N * 2)
            if not raw or len(raw) < N * 2:
                time.sleep(0.01)
                continue

            samples = struct.unpack(f'<{N}h', raw)

            # Apply Hann window & normalize to [-1.0, 1.0]
            windowed = [samples[i] * HANN[i] / 32768.0 for i in range(N)]

            # Calculate DFT magnitudes for positive spectrum
            mags = []
            max_mag = 0.0001
            for k in range(HALF_N):
                c_tab = COS_TABLE[k]
                s_tab = SIN_TABLE[k]
                re = sum(windowed[n] * c_tab[n] for n in range(N))
                im = sum(windowed[n] * s_tab[n] for n in range(N))
                mag = math.sqrt(re * re + im * im)
                mags.append(mag)
                if mag > max_mag:
                    max_mag = mag

            # Auto-gain tracking (adapts to soft/loud tracks gracefully)
            if max_mag > peak_gain:
                peak_gain = peak_gain * 0.7 + max_mag * 0.3
            else:
                peak_gain = max(0.02, peak_gain * decay_speed)

            # Calculate 16 band energies normalized (0.0 to 1.0)
            bars = []
            for band in BAND_MAP:
                avg_mag = sum(mags[b] for b in band if b < HALF_N) / len(band)
                norm = avg_mag / (peak_gain * 0.85 + 0.001)
                # Apply WinAmp dB scaling curve
                scaled = math.pow(min(1.0, norm), 0.55)
                bars.append(round(scaled, 3))

            # Format as single comma-separated line for high performance parsing
            sys.stdout.write(",".join(map(str, bars)) + "\n")
            sys.stdout.flush()

    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        proc.terminate()

if __name__ == "__main__":
    main()
