#!/usr/bin/env python3
"""Deterministically generate the legacy-encoding ID3 fixtures.

Real-world files from Chinese/Japanese sources store GBK / Shift_JIS / Big5
bytes under ID3v2 encoding byte 0, and many old files only carry an ID3v1 tag.
These fixtures reproduce both shapes. Run from anywhere:

    python3 tests/fixtures/gen-cjk.py
"""

import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent

# One MPEG1 Layer III frame: 128 kbps, 44100 Hz, no padding -> 417 bytes.
AUDIO_FRAME = b"\xff\xfb\x90\x00" + b"\x00" * 413
AUDIO = AUDIO_FRAME * 12


def syncsafe(value):
    return bytes(
        [
            (value >> 21) & 0x7F,
            (value >> 14) & 0x7F,
            (value >> 7) & 0x7F,
            value & 0x7F,
        ]
    )


def frame(frame_id, payload):
    return (
        frame_id.encode("ascii")
        + struct.pack(">I", len(payload))
        + b"\x00\x00"
        + payload
    )


def text_frame(frame_id, encoded_text):
    return frame(frame_id, b"\x00" + encoded_text)


def id3v2(frames):
    body = b"".join(frames)
    return b"ID3\x03\x00\x00" + syncsafe(len(body)) + body


def id3v1(title, artist, album, year):
    def fixed(value, length):
        return value[:length].ljust(length, b"\x00")

    return (
        b"TAG"
        + fixed(title.encode("gbk"), 30)
        + fixed(artist.encode("gbk"), 30)
        + fixed(album.encode("gbk"), 30)
        + fixed(year.encode("ascii"), 4)
        + fixed(b"", 30)
        + b"\xff"
    )


def write(name, data):
    path = HERE / name
    path.write_bytes(data)
    print(f"{name}\t{len(data)} bytes")


def main():
    write(
        "cjk-gbk-v2.mp3",
        id3v2(
            [
                text_frame("TIT2", "周杰伦".encode("gbk")),
                text_frame("TPE1", "七里香".encode("gbk")),
                text_frame("TALB", "叶惠美".encode("gbk")),
            ]
        )
        + AUDIO,
    )
    write(
        "cjk-sjis-v2.mp3",
        id3v2(
            [
                text_frame("TIT2", "米津玄師".encode("shift_jis")),
                text_frame("TPE1", "Lemon".encode("ascii")),
                text_frame("TALB", "STRAY SHEEP".encode("ascii")),
            ]
        )
        + AUDIO,
    )
    write(
        "cjk-big5-v2.mp3",
        id3v2(
            [
                text_frame("TIT2", "五月天".encode("big5")),
                text_frame("TPE1", "突然好想你".encode("big5")),
                text_frame("TALB", "後青春期的詩".encode("big5")),
            ]
        )
        + AUDIO,
    )
    write(
        "cjk-gbk-v1.mp3",
        AUDIO + id3v1("周杰伦", "七里香", "叶惠美", "2004"),
    )
    write(
        "cjk-utf8-v2.mp3",
        id3v2(
            [
                text_frame("TIT2", "周杰伦".encode("utf-8")),
                text_frame("TPE1", "七里香".encode("utf-8")),
            ]
        )
        + AUDIO,
    )
    write(
        "ascii-v2.mp3",
        id3v2(
            [
                text_frame("TIT2", b"Plain Title"),
                text_frame("TPE1", b"Plain Artist"),
                text_frame("TALB", b"Plain Album"),
            ]
        )
        + AUDIO,
    )


if __name__ == "__main__":
    main()
