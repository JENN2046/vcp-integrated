"""Recognize little-endian 16 kHz PCM exclusively with a local Vosk model."""

import array
import json
import os
import sys

from vosk import KaldiRecognizer, Model, SetLogLevel


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def text_of(payload, key):
    return "".join(json.loads(payload).get(key, "").split())


def recognize(model_path):
    SetLogLevel(-1)
    recognizer = KaldiRecognizer(Model(model_path), 16000)
    committed = ""
    last = None
    quiet_samples = 0
    total_samples = 0
    remainder = b""
    emit(ready=True)

    while chunk := os.read(0, 3200):
        data = remainder + chunk
        aligned = len(data) & ~1
        data, remainder = data[:aligned], data[aligned:]
        if not data:
            continue
        samples = array.array("h", data)
        if sys.byteorder != "little":
            samples.byteswap()
        total_samples += len(samples)
        quiet = sum(sample * sample for sample in samples) < len(samples) * 375**2
        quiet_samples = quiet_samples + len(samples) if quiet else 0
        if recognizer.AcceptWaveform(data):
            committed += text_of(recognizer.Result(), "text")
            current = committed
        else:
            current = committed + text_of(recognizer.PartialResult(), "partial")
        if current != last:
            emit(text=current, final=False)
            last = current
        if (current and quiet_samples >= 48000) or (
            not current and total_samples >= 112000 and quiet_samples >= 28800
        ):
            break

    emit(text=committed + text_of(recognizer.FinalResult(), "text"), final=True)


if __name__ == "__main__":
    recognize(sys.argv[1])
