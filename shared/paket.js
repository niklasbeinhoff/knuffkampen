// Heta paketet – hot potato with the Knuffkampen bumper cars. The physics is
// shared/sim.js; these are the rules' numbers.

export const PAKET = Object.freeze({
  FUSE_MIN: 11,        // seconds a parcel ticks with a full field, shortest
  FUSE_MAX: 19,        // ... and longest. The players never see the number.
  FUSE_FLOOR: 0.6,     // fuse multiplier when only two cars are left
  PASS_CD: 0.5,        // seconds after a pass before the parcel can move again
  PASS_BACK: 1.6,      // seconds the previous carrier cannot get it straight back
  NEXT_T: 2.2,         // pause after a pop before the next parcel is handed out
  CARRIER_ACC: 1.15,   // the carrier accelerates this much harder: it has to catch someone
});

/** Fuse multiplier for `alive` cars: FUSE_FLOOR with two left, 1 with eight or more. */
export function fuseScale(alive) {
  const k = Math.min(1, Math.max(0, (alive - 2) / 6));
  return PAKET.FUSE_FLOOR + (1 - PAKET.FUSE_FLOOR) * k;
}
