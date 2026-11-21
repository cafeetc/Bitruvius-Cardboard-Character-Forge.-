import { RigNodeSpec, RigSpec } from './types';

export type YorickViewGroup = 'front' | 'side' | 'back';

export type YorickPoseId =
  | 'front-neutral'
  | 'front-stern'
  | 'front-jaw-open'
  | 'front-snarl'
  | 'side-3q-l'
  | 'side-3q-r'
  | 'side-profile-l'
  | 'side-profile-r'
  | 'side-jaw-open-l'
  | 'side-jaw-open-r'
  | 'back-neutral'
  | 'back-tilt-up'
  | 'back-turn-l'
  | 'back-turn-r';

export interface YorickPosePreset {
  id: YorickPoseId;
  group: YorickViewGroup;
  label: string;
  description: string;
}

export const YORICK_POSE_PRESETS: YorickPosePreset[] = [
  // Front Poses
  {
    id: 'front-neutral',
    group: 'front',
    label: 'Neutral',
    description: 'Orthographic symmetrical front skull and facial mask',
  },
  {
    id: 'front-stern',
    group: 'front',
    label: 'Stern Furl',
    description: 'Furrowed brow & furlbone, narrowed sockets, clenched jaw',
  },
  {
    id: 'front-jaw-open',
    group: 'front',
    label: 'Jaw Open',
    description: 'Articulated lower mandible & jowls dropped open exposing teeth',
  },
  {
    id: 'front-snarl',
    group: 'front',
    label: 'Snarl',
    description: 'Asymmetric sneer lifting upper lip, left cheek, and tilted jaw',
  },

  // Side Poses (Left & Right)
  {
    id: 'side-3q-l',
    group: 'side',
    label: '3/4 Left',
    description: 'Three-quarter turn facing left with cranial perspective sideShifts',
  },
  {
    id: 'side-3q-r',
    group: 'side',
    label: '3/4 Right',
    description: 'Three-quarter turn facing right (mirrored sideShift perspective)',
  },
  {
    id: 'side-profile-l',
    group: 'side',
    label: 'Profile Left',
    description: 'Full left cranial profile; far-side eye & cheek tucked behind ridge',
  },
  {
    id: 'side-profile-r',
    group: 'side',
    label: 'Profile Right',
    description: 'Full right cranial profile; far-side features occluded behind ridge',
  },
  {
    id: 'side-jaw-open-l',
    group: 'side',
    label: 'Profile Jaw L',
    description: 'Left profile view with articulated jaw & throat dropped open',
  },
  {
    id: 'side-jaw-open-r',
    group: 'side',
    label: 'Profile Jaw R',
    description: 'Right profile view with articulated jaw & throat dropped open',
  },

  // Back Poses
  {
    id: 'back-neutral',
    group: 'back',
    label: 'Occipital',
    description: 'Posterior cranial vault & crownpin facing viewer; face occluded',
  },
  {
    id: 'back-tilt-up',
    group: 'back',
    label: 'Tilt Up',
    description: 'Occipital skull pitched upward exposing posterior throat & spinepin',
  },
  {
    id: 'back-turn-l',
    group: 'back',
    label: 'Over Shoulder L',
    description: 'Posterior 3/4 view turning left with left cheek/orbit peeking edge',
  },
  {
    id: 'back-turn-r',
    group: 'back',
    label: 'Over Shoulder R',
    description: 'Posterior 3/4 view turning right with right cheek/orbit peeking edge',
  },
];

function classifyYorickFeature(idOrName: string): {
  role:
    | 'skull'
    | 'forehead'
    | 'crownpin'
    | 'throat'
    | 'spinepin'
    | 'furlbone'
    | 'nasal'
    | 'nosepin'
    | 'upperlip'
    | 'upperteeth'
    | 'chin'
    | 'lowerteeth'
    | 'chinpoint'
    | 'eyeframe'
    | 'socket'
    | 'eyeball'
    | 'iris'
    | 'pupil'
    | 'cheek'
    | 'upperjowl'
    | 'jowl'
    | 'other';
  side: '1' | '2' | 'mid';
} {
  const s = idOrName.toLowerCase();
  const side: '1' | '2' | 'mid' =
    /(1|left|_l\b|\bl$)/.test(s) ? '1' : /(2|right|_r\b|\br$)/.test(s) ? '2' : 'mid';

  if (/skull/.test(s)) return { role: 'skull', side: 'mid' };
  if (/forehead/.test(s)) return { role: 'forehead', side: 'mid' };
  if (/crownpin/.test(s)) return { role: 'crownpin', side: 'mid' };
  if (/throat/.test(s)) return { role: 'throat', side: 'mid' };
  if (/spinepin|chinpin/.test(s)) return { role: 'spinepin', side: 'mid' };
  if (/furlbone/.test(s)) return { role: 'furlbone', side: 'mid' };
  if (/nosepin/.test(s)) return { role: 'nosepin', side: 'mid' };
  if (/nasal/.test(s)) return { role: 'nasal', side: 'mid' };
  if (/upperjowl/.test(s)) return { role: 'upperjowl', side };
  if (/upperlip/.test(s)) return { role: 'upperlip', side: 'mid' };
  if (/upperteeth/.test(s)) return { role: 'upperteeth', side: 'mid' };
  if (/lowerteeth|bottom\s*teeth/.test(s)) return { role: 'lowerteeth', side: 'mid' };
  if (/chinpoint|chinrest/.test(s)) return { role: 'chinpoint', side: 'mid' };
  if (/jowl/.test(s)) return { role: 'jowl', side };
  if (/chin/.test(s)) return { role: 'chin', side: 'mid' };
  if (/eyeframe/.test(s)) return { role: 'eyeframe', side };
  if (/socket/.test(s)) return { role: 'socket', side };
  if (/eyeball/.test(s)) return { role: 'eyeball', side };
  if (/iris/.test(s)) return { role: 'iris', side };
  if (/pupil/.test(s)) return { role: 'pupil', side };
  if (/cheek/.test(s)) return { role: 'cheek', side };
  return { role: 'other', side };
}

function getSkullScaleWidth(rig: RigSpec): number {
  const skull = rig.nodes.find((n) => /skull/i.test(`${n.id} ${n.name}`));
  if (skull?.pieces[0]) {
    return Math.max(400, skull.pieces[0].w);
  }
  return Math.max(400, rig.W * 0.65);
}

/**
 * Applies a Front, Side (Left/Right), or Back pose to a Yorick rig cleanly from a
 * captured Front rest baseline so switching between views never accumulates drift.
 */
export function applyYorickPose(
  currentRig: RigSpec,
  baseFrontRig: RigSpec,
  poseId: YorickPoseId
): RigSpec {
  const srcByNodePiece = new Map<string, string>();
  for (const n of currentRig.nodes) {
    n.pieces.forEach((p, idx) => {
      if (p.src) srcByNodePiece.set(`${n.id}:${idx}:${p.name}`, p.src);
    });
  }

  const baseCopy: RigSpec = JSON.parse(JSON.stringify(baseFrontRig));
  // Preserve latest texture src from currentRig in case user swapped PNGs
  for (const n of baseCopy.nodes) {
    n.pieces.forEach((p, idx) => {
      const latestSrc = srcByNodePiece.get(`${n.id}:${idx}:${p.name}`);
      if (latestSrc) p.src = latestSrc;
      p.visible = true;
      delete p.scaleX;
      delete p.scaleY;
    });
    n.ang = 0;
    n.flipX = false;
  }

  if (poseId === 'front-neutral') {
    return baseCopy;
  }

  const skullW = getSkullScaleWidth(baseCopy);

  const shiftPiece = (
    node: RigNodeSpec,
    dxNorm: number,
    dyNorm = 0,
    scaleX = 1,
    scaleY = 1
  ) => {
    const dx = Math.round(dxNorm * skullW);
    const dy = Math.round(dyNorm * skullW);
    node.pivot = [
      Math.round((node.pivot[0] + dx) * 10) / 10,
      Math.round((node.pivot[1] + dy) * 10) / 10,
    ];
    node.pieces = node.pieces.map((p) => ({
      ...p,
      x: Math.round(p.x + dx),
      y: Math.round(p.y + dy),
      ...(Math.abs(scaleX - 1) > 0.001 ? { scaleX } : {}),
      ...(Math.abs(scaleY - 1) > 0.001 ? { scaleY } : {}),
    }));
  };

  // --- FRONT POSES ---
  if (poseId.startsWith('front-')) {
    for (const node of baseCopy.nodes) {
      const { role, side } = classifyYorickFeature(`${node.id} ${node.name}`);
      const sSign = side === '1' ? -1 : side === '2' ? 1 : 0;

      if (poseId === 'front-stern') {
        if (role === 'forehead') shiftPiece(node, 0, 0.012, 1, 0.96);
        if (role === 'furlbone') {
          shiftPiece(node, 0, 0.025, 0.88, 1.05);
          node.ang = 4;
          const crown = baseCopy.nodes.find((cn) => /crownpin/i.test(`${cn.id} ${cn.name}`));
          if (crown) {
            crown.pivot = [node.pivot[0], node.pivot[1]];
          }
        }
        if (role === 'eyeframe' || role === 'socket') {
          shiftPiece(node, -sSign * 0.012, 0.01, 0.95, 0.86);
          node.ang = sSign * 9;
        }
        if (role === 'eyeball' || role === 'iris' || role === 'pupil') {
          shiftPiece(node, -sSign * 0.012, 0.01);
        }
        if (role === 'cheek') {
          shiftPiece(node, 0, -0.01);
          node.ang = -sSign * 6;
        }
        if (role === 'upperlip') shiftPiece(node, 0, -0.012, 0.97, 0.92);
        if (role === 'chin' || role === 'chinpoint') {
          shiftPiece(node, 0, -0.022);
        }
        if (role === 'jowl') node.ang = -sSign * 5;
      }

      if (poseId === 'front-jaw-open') {
        if (role === 'upperlip' || role === 'upperteeth') {
          shiftPiece(node, 0, -0.015);
        }
        if (role === 'upperjowl') {
          node.ang = sSign * 8;
        }
        if (role === 'cheek') {
          shiftPiece(node, 0, 0.012);
          node.ang = sSign * 6;
        }
        if (role === 'chin') {
          shiftPiece(node, 0, 0.075);
        }
        if (role === 'lowerteeth' || role === 'chinpoint') {
          shiftPiece(node, 0, 0.085);
        }
        if (role === 'jowl') {
          shiftPiece(node, 0, 0.045);
          node.ang = sSign * 14;
        }
      }

      if (poseId === 'front-snarl') {
        if (role === 'furlbone') {
          shiftPiece(node, -0.012, 0.015, 0.94, 1);
          node.ang = -7;
          const crown = baseCopy.nodes.find((cn) => /crownpin/i.test(`${cn.id} ${cn.name}`));
          if (crown) {
            crown.pivot = [node.pivot[0], node.pivot[1]];
          }
        }
        if (role === 'eyeframe' || role === 'socket') {
          node.ang = side === '1' ? 10 : -5;
          shiftPiece(node, 0, side === '1' ? 0.012 : -0.005, 1, side === '1' ? 0.84 : 1.04);
        }
        if (role === 'cheek') {
          shiftPiece(node, side === '1' ? -0.01 : 0.005, side === '1' ? -0.028 : 0.006);
          node.ang = side === '1' ? -10 : 4;
        }
        if (role === 'upperlip' || role === 'upperteeth') {
          shiftPiece(node, -0.014, -0.024);
          node.ang = -9;
        }
        if (role === 'upperjowl') {
          node.ang = side === '1' ? -14 : 5;
        }
        if (role === 'chin' || role === 'lowerteeth' || role === 'chinpoint') {
          shiftPiece(node, 0.012, 0.036);
          node.ang = 6;
        }
        if (role === 'jowl') {
          node.ang = side === '1' ? -6 : 9;
        }
      }
    }
    return baseCopy;
  }

  // --- SIDE POSES (3/4 L/R, Full Profile L/R, Jaw Open L/R) ---
  if (poseId.startsWith('side-')) {
    const isRight = poseId.endsWith('-r');
    const dir = isRight ? 1 : -1;
    const isFullProfile = poseId.includes('profile') || poseId.includes('jaw-open');
    const isJawOpen = poseId.includes('jaw-open');
    const nearSide = isRight ? '2' : '1';
    const farSide = isRight ? '1' : '2';

    for (const node of baseCopy.nodes) {
      const { role, side } = classifyYorickFeature(`${node.id} ${node.name}`);

      // Cranium & axial bones
      if (role === 'skull') {
        node.flipX = isRight;
        node.ang = dir * (isFullProfile ? 4 : 2);
        node.pieces = node.pieces.map((p) => ({
          ...p,
          scaleX: isFullProfile ? 0.88 : 0.94,
          i: 27,
        }));
        continue;
      }

      if (role === 'crownpin') {
        shiftPiece(node, -dir * (isFullProfile ? 0.075 : 0.045), 0, isFullProfile ? 0.85 : 0.92, 1);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 26 }));
        continue;
      }

      if (role === 'forehead') {
        shiftPiece(node, dir * (isFullProfile ? 0.065 : 0.038), 0, isFullProfile ? 0.82 : 0.92, 1);
        node.flipX = isRight;
        node.pieces = node.pieces.map((p) => ({ ...p, i: 23 }));
        continue;
      }

      if (role === 'throat') {
        shiftPiece(node, -dir * (isFullProfile ? 0.05 : 0.025), isJawOpen ? 0.02 : 0, 0.9, 1);
        node.ang = isJawOpen ? -dir * 8 : 0;
        node.pieces = node.pieces.map((p) => ({ ...p, i: 24 }));
        continue;
      }

      if (role === 'spinepin') {
        shiftPiece(node, -dir * (isFullProfile ? 0.065 : 0.03), 0);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 28 }));
        continue;
      }

      // Midline facial projection (furlbone stays behind forehead & eyes)
      if (role === 'furlbone') {
        shiftPiece(node, dir * (isFullProfile ? 0.14 : 0.082), 0, isFullProfile ? 0.62 : 0.82, 1);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 25 }));
        continue;
      }

      if (role === 'nasal' || role === 'nosepin') {
        shiftPiece(
          node,
          dir * (isFullProfile ? 0.195 : 0.11),
          0,
          isFullProfile ? 0.54 : 0.78,
          1
        );
        node.pieces = node.pieces.map((p) => ({ ...p, i: role === 'nosepin' ? 4 : 5 }));
        continue;
      }

      if (role === 'upperlip' || role === 'upperteeth') {
        shiftPiece(
          node,
          dir * (isFullProfile ? 0.17 : 0.095),
          isJawOpen ? -0.01 : 0,
          isFullProfile ? 0.56 : 0.78,
          1
        );
        node.ang = dir * (isJawOpen ? -5 : 2);
        node.pieces = node.pieces.map((p) => ({ ...p, i: role === 'upperlip' ? 1 : 2 }));
        continue;
      }

      if (role === 'chin' || role === 'lowerteeth' || role === 'chinpoint') {
        shiftPiece(
          node,
          dir * (isFullProfile ? 0.15 : 0.085),
          isJawOpen ? 0.08 : 0,
          isFullProfile ? 0.58 : 0.78,
          1
        );
        node.ang = dir * (isJawOpen ? 16 : 3);
        node.pieces = node.pieces.map((p) => ({
          ...p,
          i: role === 'chin' ? 6 : role === 'lowerteeth' ? 7 : 18,
        }));
        continue;
      }

      // Paired lateral features: Near-side leads vs Far-side compresses/occludes
      if (side === nearSide) {
        const nearShift = isFullProfile ? 0.045 : 0.032;
        const nearScaleX = isFullProfile ? 0.78 : 0.9;
        const extraY = isJawOpen && (role === 'jowl' || role === 'cheek') ? 0.035 : 0;
        shiftPiece(node, -dir * nearShift, extraY, nearScaleX, 1);
        if (role === 'jowl' && isJawOpen) node.ang = dir * 18;
        if (role === 'upperjowl' && isJawOpen) node.ang = -dir * 8;
        node.pieces = node.pieces.map((p) => ({
          ...p,
          i: Math.max(1, Math.min(14, p.i - 4)),
        }));
      } else if (side === farSide) {
        if (isFullProfile) {
          // Far-side eye, cheek, jowls occlude behind the nasal ridge in full profile
          node.pieces = node.pieces.map((p) => ({ ...p, visible: false }));
        } else {
          // 3/4 turn compresses and tucks far-side features behind midline
          const farShift = 0.145;
          shiftPiece(node, dir * farShift, 0, 0.48, 0.96);
          node.pieces = node.pieces.map((p) => ({
            ...p,
            i: Math.min(27, p.i + 10),
          }));
        }
      }
    }

    return baseCopy;
  }

  // --- BACK POSES (Occipital Neutral, Tilt Up, Over Shoulder L/R) ---
  if (poseId.startsWith('back-')) {
    const isTurnL = poseId === 'back-turn-l';
    const isTurnR = poseId === 'back-turn-r';
    const isTiltUp = poseId === 'back-tilt-up';
    const turnDir = isTurnL ? -1 : isTurnR ? 1 : 0;
    const peekSide = isTurnL ? '1' : isTurnR ? '2' : null;

    for (const node of baseCopy.nodes) {
      const { role, side } = classifyYorickFeature(`${node.id} ${node.name}`);

      if (role === 'skull') {
        node.ang = isTiltUp ? -8 : turnDir * 6;
        node.flipX = isTurnR;
        node.pieces = node.pieces.map((p) => ({
          ...p,
          i: 2,
          scaleY: isTiltUp ? 0.93 : 1,
        }));
        continue;
      }

      if (role === 'crownpin') {
        shiftPiece(node, -turnDir * 0.04, isTiltUp ? -0.025 : 0);
        node.ang = turnDir * 4;
        node.pieces = node.pieces.map((p) => ({ ...p, i: 1 }));
        continue;
      }

      if (role === 'forehead') {
        shiftPiece(node, turnDir * 0.035, isTiltUp ? -0.035 : -0.015, 0.96, isTiltUp ? 0.85 : 0.94);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 5 }));
        continue;
      }

      if (role === 'throat') {
        shiftPiece(node, -turnDir * 0.02, isTiltUp ? 0.015 : 0.025, 0.94, 1);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 3 }));
        continue;
      }

      if (role === 'spinepin') {
        shiftPiece(node, -turnDir * 0.02, isTiltUp ? 0.01 : 0.02);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 0 }));
        continue;
      }

      if (role === 'chin' || role === 'chinpoint') {
        shiftPiece(node, turnDir * 0.03, isTiltUp ? -0.02 : 0.01, 0.9, 0.9);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 14, visible: !isTiltUp }));
        continue;
      }

      if (role === 'jowl' && peekSide && side === peekSide) {
        shiftPiece(node, turnDir * 0.06, 0, 0.65, 0.95);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 8 }));
        continue;
      }

      if (
        (role === 'cheek' || role === 'eyeframe' || role === 'socket') &&
        peekSide &&
        side === peekSide
      ) {
        shiftPiece(node, turnDir * 0.12, 0, 0.48, 0.95);
        node.pieces = node.pieces.map((p) => ({ ...p, i: 10 }));
        continue;
      }

      // All anterior face parts hidden behind the posterior occipital cranial vault
      node.pieces = node.pieces.map((p) => ({
        ...p,
        i: 28,
        visible: false,
      }));
    }

    return baseCopy;
  }

  return baseCopy;
}
