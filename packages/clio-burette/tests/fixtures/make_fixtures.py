"""Writes the synthetic fixtures the view checks use (standard library only).

p-xylene.xyz       18 atoms, idealized geometry (C-C 1.39/1.51 A, C-H 1.09 A).
p-xylene-mode.xyz  20 frames of a ring-breathing-like normal mode, amplitude 0.25 A.
"""

import math
from pathlib import Path

HERE = Path(__file__).parent


def p_xylene():
    atoms = []
    ring = 1.39
    for k in range(6):
        a = math.radians(60 * k)
        atoms.append(("C", ring * math.cos(a), ring * math.sin(a), 0.0))
    for k in range(6):
        a = math.radians(60 * k)
        if k in (0, 3):
            r = ring + 1.51
            atoms.append(("C", r * math.cos(a), r * math.sin(a), 0.0))
        else:
            r = ring + 1.09
            atoms.append(("H", r * math.cos(a), r * math.sin(a), 0.0))
    for k, sign in ((0, 1), (3, -1)):
        cx = sign * (ring + 1.51)
        for j in range(3):
            phi = math.radians(120 * j)
            atoms.append(("H", cx + sign * 0.363, 1.028 * math.cos(phi), 1.028 * math.sin(phi)))
    return atoms


def xyz_frame(atoms, comment):
    lines = [str(len(atoms)), comment]
    lines += [f"{e:2s} {x:12.6f} {y:12.6f} {z:12.6f}" for e, x, y, z in atoms]
    return "\n".join(lines) + "\n"


def main():
    atoms = p_xylene()
    (HERE / "p-xylene.xyz").write_text(xyz_frame(atoms, "p-xylene (idealized)"))
    frames = []
    for f in range(20):
        s = 0.25 * math.sin(2 * math.pi * f / 20)
        moved = []
        for e, x, y, z in atoms:
            r = math.hypot(x, y) or 1.0
            moved.append((e, x + s * x / r, y + s * y / r, z))
        frames.append(xyz_frame(moved, f"mode 7 ring breathing frame {f}"))
    (HERE / "p-xylene-mode.xyz").write_text("".join(frames))


if __name__ == "__main__":
    main()
