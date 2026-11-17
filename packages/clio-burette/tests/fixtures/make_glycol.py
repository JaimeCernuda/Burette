"""Writes ethylene-glycol.xyz (uv run --with rdkit python make_glycol.py).

Ethylene glycol embedded with RDKit (ETKDG, seed 7, MMFF-optimized), with the
O-C-C-O dihedral set to 180 degrees (anti). Atom order: O0 C1 C2 O3, then H.
"""

from pathlib import Path

from rdkit import Chem
from rdkit.Chem import AllChem, rdMolTransforms

mol = Chem.AddHs(Chem.MolFromSmiles("OCCO"))
AllChem.EmbedMolecule(mol, randomSeed=7)
AllChem.MMFFOptimizeMolecule(mol)
conf = mol.GetConformer()
rdMolTransforms.SetDihedralDeg(conf, 0, 1, 2, 3, 180.0)
lines = [str(mol.GetNumAtoms()), "ethylene glycol, O-C-C-O anti (180 deg)"]
for atom in mol.GetAtoms():
    p = conf.GetAtomPosition(atom.GetIdx())
    lines.append(f"{atom.GetSymbol():2s} {p.x:12.6f} {p.y:12.6f} {p.z:12.6f}")
(Path(__file__).parent / "ethylene-glycol.xyz").write_text("\n".join(lines) + "\n")
print(rdMolTransforms.GetDihedralDeg(conf, 0, 1, 2, 3))
