"""Writes magnetite fixtures with ASE (uv run --with ase python make_magnetite.py).

magnetite.cif          Fe3O4 spinel, Fd-3m origin choice 2, a = 8.396 A, the
                       asymmetric unit plus all 192 symmetry operators.
magnetite-001-h2o.cif  a P1 Fe3O4(001) slab (two cells thick) with one water
                       molecule adsorbed above an octahedral Fe, as an adsorbate case.
"""

from pathlib import Path

import numpy as np
from ase import Atoms
from ase.build import surface
from ase.io import write
from ase.spacegroup import Spacegroup, crystal

HERE = Path(__file__).parent
A = 8.396
BASIS = [(0.125, 0.125, 0.125), (0.5, 0.5, 0.5), (0.2548, 0.2548, 0.2548)]


def fraction(value):
    from fractions import Fraction

    f = Fraction(value).limit_denominator(12)
    return "" if f == 0 else (f"+{f}" if f > 0 else f"{f}")


def op_string(rot, trans):
    out = []
    for row, t in zip(rot, trans):
        terms = ""
        for coef, axis in zip(row, "xyz"):
            if coef == 1:
                terms += f"+{axis}"
            elif coef == -1:
                terms += f"-{axis}"
        out.append((terms.lstrip("+") or "0") + fraction(t % 1))
    return ",".join(out)


def symmetric_cif():
    sg = Spacegroup(227, setting=2)
    ops = [op_string(r, t) for r, t in sg.get_symop()]
    lines = [
        "data_magnetite",
        "_chemical_name_mineral 'Magnetite'",
        "_chemical_formula_sum 'Fe3 O4'",
        *(f"_cell_length_{x} {A:.4f}" for x in "abc"),
        *(f"_cell_angle_{x} 90" for x in ("alpha", "beta", "gamma")),
        "_symmetry_space_group_name_H-M 'F d -3 m :2'",
        "_space_group_IT_number 227",
        "loop_",
        "_symmetry_equiv_pos_as_xyz",
        *(f"'{op}'" for op in ops),
        "loop_",
        "_atom_site_label",
        "_atom_site_type_symbol",
        "_atom_site_fract_x",
        "_atom_site_fract_y",
        "_atom_site_fract_z",
        "_atom_site_occupancy",
        "Fe1 Fe 0.12500 0.12500 0.12500 1.0",
        "Fe2 Fe 0.50000 0.50000 0.50000 1.0",
        "O1 O 0.25480 0.25480 0.25480 1.0",
    ]
    (HERE / "magnetite.cif").write_text("\n".join(lines) + "\n")
    return len(ops)


def slab_with_water():
    bulk = crystal(["Fe", "Fe", "O"], basis=BASIS, spacegroup=227, setting=2, cellpar=[A, A, A, 90, 90, 90])
    slab = surface(bulk, (0, 0, 1), layers=2, vacuum=None)
    slab.center(vacuum=7.5, axis=2)
    top = slab.positions[:, 2].max()
    fe = [i for i, s in enumerate(slab.get_chemical_symbols()) if s == "Fe"]
    site = max(fe, key=lambda i: slab.positions[i, 2])
    x, y, _ = slab.positions[site]
    water = Atoms("OHH", positions=[(x, y, top + 2.1), (x + 0.76, y, top + 2.7), (x - 0.76, y, top + 2.7)])
    slab += water
    write(HERE / "magnetite-001-h2o.cif", slab, format="cif")
    return len(slab)


if __name__ == "__main__":
    print("operators", symmetric_cif())
    print("slab atoms", slab_with_water())
