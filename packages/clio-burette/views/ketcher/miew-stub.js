// Ketcher's optional Miew 3D preview is not shipped in the CLIO view.
export default class Miew {
  constructor() {
    throw new Error("The Miew 3D preview is not part of the Burette CLIO Ketcher view; use the Mol* viewer.");
  }
}
export { Miew };
