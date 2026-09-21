"""Generate placeholder icon.png (32x32) and icon.ico using only stdlib zlib/struct."""
import struct
import zlib
import os

W = H = 32


def make_png_bytes():
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)  # RGBA, 8-bit
    raw = bytearray()
    for y in range(H):
        raw.append(0)  # filter type: none
        for x in range(W):
            # simple gradient/purple accent square, matches a dark theme app icon
            r = 90 + int(60 * x / W)
            g = 60 + int(40 * y / H)
            b = 200
            a = 255
            raw += bytes([r, g, b, a])
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    return png


def make_ico(png_bytes):
    # ICO with a single embedded PNG image (valid per spec for 32x32+ icons)
    count = 1
    header = struct.pack("<HHH", 0, 1, count)
    # ICONDIRENTRY: width, height, colorcount, reserved, planes, bitcount, byteSize, offset
    entry = struct.pack(
        "<BBBBHHII",
        W if W < 256 else 0,
        H if H < 256 else 0,
        0, 0, 1, 32,
        len(png_bytes),
        6 + 16,
    )
    return header + entry + png_bytes


if __name__ == "__main__":
    out_dir = os.path.dirname(os.path.abspath(__file__))
    png = make_png_bytes()
    with open(os.path.join(out_dir, "icon.png"), "wb") as f:
        f.write(png)
    ico = make_ico(png)
    with open(os.path.join(out_dir, "icon.ico"), "wb") as f:
        f.write(ico)
    print("wrote icon.png (%d bytes) and icon.ico (%d bytes)" % (len(png), len(ico)))
