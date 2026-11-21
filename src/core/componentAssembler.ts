import {
  BITRUVIAN_ANATOMICAL_LIMITS,
  normalizeYorickHierarchy,
} from './bitruvianEngine';
import {
  AnchorConvention,
  AssembledModelsMap,
  ComponentModelKey,
  DeducedTrackRule,
  ExtractedAsset,
  RigNodeSpec,
  RigSpec,
  TuningConfig,
} from './types';

export const DEFAULT_TUNING: TuningConfig = {
  anchorConvention: 'auto',
  scaleFactor: 1,
  offsetX: 0,
  offsetY: 0,
  reverseZ: false,
};

const YORICK_KEYWORDS =
  /(yorick|yorrick|skull|crownpin|forehead|furlbone|eyeframe|socketbone|socket\d|eyeball|iris|pupil|nasalcavity|nosepin|throatbone|throat|cheek|upperlip|upper_lip|upperjowl|upperteeth|chinpoint|chinrest|chinpin|spinepin|lowerteeth|jowl|\bchin\b)/i;

const GOTZ_KEYWORDS =
  /(gotz|wrist|carpal|metacarpal|\bthumb\b|\bindex\b|\bbird\b|\bring\b|\bpinky\b|distal|proximal|phalanx|\.(carpal|meta|prox|mid|dist)$)/i;

const PIGGY_KEYWORDS =
  /(piggy|piggies|ankle|heelbone|calcaneus|footbone|cuboid|market|metatarsal|toebone|\btoe\d|toe_)/i;

export function classifyComponent(
  rawName: string,
  groupPath: string[] = []
): ComponentModelKey {
  const joined = `${groupPath.join(' / ')} ${rawName}`.toLowerCase();
  if (/(yorick|yorrick)/i.test(joined) || YORICK_KEYWORDS.test(joined)) {
    return 'yorick';
  }
  if (/(gotz)/i.test(joined) || GOTZ_KEYWORDS.test(joined)) {
    // Watch out for main body "Handkit" vs Gotz finger bones
    if (!/handkit/i.test(joined)) {
      return 'gotz';
    }
  }
  if (/(piggy|piggies)/i.test(joined) || PIGGY_KEYWORDS.test(joined)) {
    return 'piggy';
  }
  return 'bytruvyus';
}

export function inferAnatomicalMapping(
  rawName: string,
  component: ComponentModelKey
): {
  role: string;
  parentHints: string[];
  limits: [number, number];
} {
  const lower = rawName.toLowerCase();
  const isLeft = /(\bleft\b|_l\b|\bl_|\bleft|[\s_-]l$|1$)/i.test(rawName);
  const isRight = /(\bright\b|_r\b|\br_|\bright|[\s_-]r$|2$)/i.test(rawName);
  const side = isLeft ? 'L' : isRight ? 'R' : '';

  if (component === 'yorick') {
    if (/skull/i.test(lower)) return { role: 'skull', parentHints: [], limits: [-45, 45] };
    if (/crownpin/i.test(lower)) return { role: 'crownpin', parentHints: ['furlbone', 'forehead', 'skull'], limits: [-30, 30] };
    if (/forehead/i.test(lower)) return { role: 'forehead', parentHints: ['skull'], limits: [-25, 25] };
    if (/furlbone/i.test(lower)) return { role: 'furlbone', parentHints: ['forehead', 'skull'], limits: [-25, 25] };
    if (/eyeframe/i.test(lower)) return { role: `eyeframe${side === 'R' ? '2' : '1'}`, parentHints: ['furlbone', 'skull'], limits: [-20, 20] };
    if (/socket/i.test(lower)) return { role: `socket${side === 'R' ? '2' : '1'}`, parentHints: [`eyeframe${side === 'R' ? '2' : '1'}`, 'skull'], limits: [-20, 20] };
    if (/eyeball/i.test(lower)) return { role: `eyeball${side === 'R' ? '2' : '1'}`, parentHints: [`socket${side === 'R' ? '2' : '1'}`], limits: [-35, 35] };
    if (/iris/i.test(lower)) return { role: `iris${side === 'R' ? '2' : '1'}`, parentHints: [`eyeball${side === 'R' ? '2' : '1'}`], limits: [-25, 25] };
    if (/pupil/i.test(lower)) return { role: `pupil${side === 'R' ? '2' : '1'}`, parentHints: [`iris${side === 'R' ? '2' : '1'}`], limits: [-15, 15] };
    if (/nasalcavity/i.test(lower)) return { role: 'nasalcavity', parentHints: ['furlbone', 'skull'], limits: [-15, 15] };
    if (/nosepin/i.test(lower)) return { role: 'nosepin', parentHints: ['nasalcavity'], limits: [-15, 15] };
    if (/throat/i.test(lower)) return { role: 'throat', parentHints: ['skull'], limits: [-25, 25] };
    if (/cheek/i.test(lower)) return { role: `cheek${side === 'R' ? '2' : '1'}`, parentHints: ['throat', 'skull'], limits: [-20, 20] };
    if (/upperjowl/i.test(lower)) return { role: `upperjowl${side === 'R' ? '2' : '1'}`, parentHints: ['upperlip'], limits: [-25, 25] };
    if (/upperlip/i.test(lower)) return { role: 'upperlip', parentHints: ['throat', 'skull'], limits: [-25, 25] };
    if (/upperteeth/i.test(lower)) return { role: 'upperteeth', parentHints: ['upperlip'], limits: [-10, 10] };
    if (/jowl/i.test(lower)) return { role: `jowl${side === 'R' ? '2' : '1'}`, parentHints: ['chin'], limits: [-25, 25] };
    if (/lowerteeth|bottomteeth/i.test(lower)) return { role: 'lowerteeth', parentHints: ['chin'], limits: [-10, 10] };
    if (/chinpoint|chinrest/i.test(lower)) return { role: 'chinpoint', parentHints: ['chin'], limits: [-20, 20] };
    if (/chin/i.test(lower)) return { role: 'chin', parentHints: ['throat', 'skull'], limits: [-35, 20] };
    return { role: rawName, parentHints: ['skull'], limits: [-45, 45] };
  }

  if (component === 'gotz') {
    const digit = /thumb/i.test(lower)
      ? 'thumb'
      : /index/i.test(lower)
      ? 'index'
      : /bird|middle/i.test(lower)
      ? 'bird'
      : /ring/i.test(lower)
      ? 'ring'
      : /pinky/i.test(lower)
      ? 'pinky'
      : 'bird';
    if (/carpal/i.test(lower)) return { role: `${digit}.carpal`, parentHints: ['bird.meta', 'wrist'], limits: [-65, 65] };
    if (/meta/i.test(lower)) return { role: `${digit}.meta`, parentHints: digit === 'bird' ? [] : ['bird.meta'], limits: [-45, 45] };
    if (/prox/i.test(lower)) return { role: `${digit}.prox`, parentHints: [`${digit}.meta`, `${digit}.carpal`], limits: [-35, 90] };
    if (/mid/i.test(lower)) return { role: `${digit}.mid`, parentHints: [`${digit}.prox`], limits: [-35, 90] };
    if (/dist/i.test(lower)) return { role: `${digit}.dist`, parentHints: [`${digit}.mid`, `${digit}.prox`], limits: [-35, 90] };
    return { role: rawName, parentHints: ['bird.meta'], limits: [-90, 90] };
  }

  if (component === 'piggy') {
    if (/ankle/i.test(lower)) return { role: 'ankle', parentHints: [], limits: [-45, 45] };
    if (/heel/i.test(lower)) return { role: 'heel', parentHints: ['ankle'], limits: [-25, 25] };
    if (/footbone/i.test(lower)) return { role: 'footbone', parentHints: ['ankle'], limits: [-35, 35] };
    if (/cuboid/i.test(lower)) return { role: 'cuboid', parentHints: ['footbone'], limits: [-25, 25] };
    const toe = /market|big|toe1/i.test(lower)
      ? 'market'
      : /toe2/i.test(lower)
      ? 'toe2'
      : /toe3/i.test(lower)
      ? 'toe3'
      : /toe4/i.test(lower)
      ? 'toe4'
      : /toe5/i.test(lower)
      ? 'toe5'
      : 'toe3';
    const metaParent = toe === 'toe4' || toe === 'toe5' ? 'cuboid' : 'footbone';
    if (/meta/i.test(lower)) return { role: `${toe}.meta`, parentHints: [metaParent, 'footbone'], limits: [-30, 30] };
    if (/prox/i.test(lower)) return { role: `${toe}.prox`, parentHints: [`${toe}.meta`], limits: [-45, 65] };
    if (/mid/i.test(lower)) return { role: `${toe}.mid`, parentHints: [`${toe}.prox`, `${toe}.meta`], limits: [-45, 65] };
    if (/dist|toebone/i.test(lower)) return { role: `${toe}.dist`, parentHints: [`${toe}.mid`, `${toe}.prox`], limits: [-45, 65] };
    return { role: rawName, parentHints: ['footbone', 'ankle'], limits: [-65, 65] };
  }

  // Bytruvyus body rig
  if (/(pelvis|hip_root|hips|\broot\b)/i.test(lower)) {
    return { role: 'pelvis', parentHints: [], limits: [-180, 180] };
  }
  if (/(lumbar|waist|abdomen|lower_torso)/i.test(lower)) {
    return { role: 'lumbar', parentHints: ['pelvis', 'root'], limits: [-48, 48] };
  }
  if (/(thorax|chest|rib|torso|upper_body|upperspine|neckring)/i.test(lower)) {
    return { role: 'thorax', parentHints: ['lumbar', 'pelvis', 'root'], limits: [-42, 42] };
  }
  if (/\bneck\b/i.test(lower)) {
    return { role: 'neck', parentHints: ['thorax', 'torso'], limits: [-45, 45] };
  }
  if (/(head|skull|face)/i.test(lower)) {
    return { role: 'head', parentHints: ['neck', 'thorax', 'torso'], limits: [-65, 65] };
  }
  if (/(brace|tendon|backshoulder|collar|clavicle)/i.test(lower)) {
    return { role: `brace${side || 'L'}`, parentHints: ['thorax', 'neck', 'torso'], limits: [-18, 18] };
  }
  if (/(swivel|scapula)/i.test(lower)) {
    return { role: `swivel${side || 'L'}`, parentHints: ['lumbar', 'thorax'], limits: [-42, 42] };
  }
  if (/(acromion|shoulderbone|shoulder_cap|shoulder)/i.test(lower)) {
    return {
      role: `acromion${side || 'L'}`,
      parentHints: [`swivel${side}`, 'thorax', 'torso'],
      limits: side === 'R' ? [-60, 45] : [-45, 60],
    };
  }
  if (/(humerus|upper_arm|upperarm|bicep)/i.test(lower)) {
    return {
      role: `humerus${side || 'L'}`,
      parentHints: [`acromion${side}`, 'thorax', 'torso'],
      limits: side === 'R' ? [-165, 175] : [-175, 165],
    };
  }
  if (/(forearm|lower_arm|lowerarm|ulna|radius)/i.test(lower)) {
    return {
      role: `forearm${side || 'L'}`,
      parentHints: [`humerus${side}`, `upper_arm${side}`, `upperarm${side}`],
      limits: side === 'R' ? [-15, 155] : [-155, 15],
    };
  }
  if (/(handkit|\bhand\b|palm)/i.test(lower)) {
    return { role: `hand${side || 'L'}`, parentHints: [`forearm${side}`, `lower_arm${side}`], limits: [-85, 85] };
  }
  if (/(femur|thigh|upper_leg|upperleg)/i.test(lower)) {
    return {
      role: `femur${side || 'L'}`,
      parentHints: ['pelvis', 'root', 'torso'],
      limits: side === 'R' ? [-120, 135] : [-135, 120],
    };
  }
  if (/(shin|calf|tibia|fibula|lower_leg|lowerleg)/i.test(lower)) {
    return {
      role: `shin${side || 'L'}`,
      parentHints: [`femur${side}`, `thigh${side}`, `upper_leg${side}`],
      limits: side === 'R' ? [-150, 15] : [-15, 150],
    };
  }
  if (/(foot|shoe|boot)/i.test(lower)) {
    return {
      role: `foot${side || 'L'}`,
      parentHints: [`shin${side}`, `calf${side}`, `lower_leg${side}`],
      limits: side === 'R' ? [-75, 65] : [-65, 75],
    };
  }

  return { role: rawName, parentHints: ['pelvis', 'torso', 'root'], limits: [-180, 180] };
}

export function computePivotFromAnchor(
  box: { x: number; y: number; w: number; h: number },
  rawAnchor: [number, number] | null,
  convention: AnchorConvention,
  stageW: number,
  stageH: number
): { pivot: [number, number]; spaceLabel: string } {
  if (!rawAnchor) {
    return {
      pivot: [Math.round(box.x + box.w * 0.5), Math.round(box.y + box.h * 0.2)],
      spaceLabel: 'Default joint (top-center 20%)',
    };
  }

  const [ax, ay] = rawAnchor;
  let mode = convention;

  if (mode === 'auto') {
    if (ax >= -0.05 && ax <= 1.05 && ay >= -0.05 && ay <= 1.05) {
      mode = 'normalized-tl';
    } else if (ax >= -0.6 && ax <= 0.6 && ay >= -0.6 && ay <= 0.6) {
      mode = 'normalized-center';
    } else if (
      Math.abs(ax) <= box.w * 1.1 &&
      Math.abs(ay) <= box.h * 1.1 &&
      (ax < box.x || ay < box.y)
    ) {
      mode = 'layer-offset';
    } else if (ax >= 0 && ax <= stageW && ay >= 0 && ay <= stageH) {
      mode = 'stage-world';
    } else {
      mode = 'layer-offset';
    }
  }

  switch (mode) {
    case 'normalized-tl':
      return {
        pivot: [
          Math.round((box.x + ax * box.w) * 10) / 10,
          Math.round((box.y + ay * box.h) * 10) / 10,
        ],
        spaceLabel: 'Normalized [0..1] Top-Left',
      };
    case 'normalized-center':
      return {
        pivot: [
          Math.round((box.x + (0.5 + ax) * box.w) * 10) / 10,
          Math.round((box.y + (0.5 + ay) * box.h) * 10) / 10,
        ],
        spaceLabel: 'Normalized [-0.5..0.5] Center',
      };
    case 'layer-offset':
      return {
        pivot: [Math.round((box.x + ax) * 10) / 10, Math.round((box.y + ay) * 10) / 10],
        spaceLabel: 'Layer Local Pixel Offset',
      };
    case 'stage-world':
    default:
      return {
        pivot: [Math.round(ax * 10) / 10, Math.round(ay * 10) / 10],
        spaceLabel: 'Stage World Coordinates',
      };
  }
}

export function applyTuningToTracks(
  tracks: DeducedTrackRule[],
  tuning: TuningConfig,
  stageW: number,
  stageH: number
): DeducedTrackRule[] {
  const s = tuning.scaleFactor || 1;
  const maxZ = tracks.reduce((m, t) => Math.max(m, t.zIndex), 0);

  return tracks.map((tr) => {
    const scaledBox = {
      x: Math.round((tr.layerBox.x * s + tuning.offsetX) * 10) / 10,
      y: Math.round((tr.layerBox.y * s + tuning.offsetY) * 10) / 10,
      w: Math.max(8, Math.round(tr.layerBox.w * s * 10) / 10),
      h: Math.max(8, Math.round(tr.layerBox.h * s * 10) / 10),
    };
    const rawAnchorScaled: [number, number] | null =
      tr.rawAnchor &&
      (tuning.anchorConvention === 'stage-world' ||
        (tuning.anchorConvention === 'auto' &&
          (Math.abs(tr.rawAnchor[0]) > 1.05 || Math.abs(tr.rawAnchor[1]) > 1.05)))
        ? [tr.rawAnchor[0] * s + tuning.offsetX, tr.rawAnchor[1] * s + tuning.offsetY]
        : tr.rawAnchor;

    const { pivot, spaceLabel } = computePivotFromAnchor(
      scaledBox,
      rawAnchorScaled,
      tuning.anchorConvention,
      stageW * s,
      stageH * s
    );

    return {
      ...tr,
      layerBox: scaledBox,
      computedPivot: pivot,
      anchorSpace: spaceLabel,
      zIndex: tuning.reverseZ ? maxZ - tr.zIndex : tr.zIndex,
    };
  });
}

/**
 * Partitions deduced tracks & matched assets into the 4 Bitruvian models:
 * Bytruvyus (Body), Gotz (Hand), Yorick (Head/Skull), Piggy (Foot).
 */
export function assembleFourComponentModels(
  baseName: string,
  stageWidth: number,
  stageHeight: number,
  tracks: DeducedTrackRule[],
  assets: ExtractedAsset[]
): AssembledModelsMap {
  const assetById = new Map<string, ExtractedAsset>();
  assets.forEach((a) => assetById.set(a.id, a));

  const keys: ComponentModelKey[] = ['bytruvyus', 'gotz', 'yorick', 'piggy'];
  const labels: Record<ComponentModelKey, string> = {
    bytruvyus: `${baseName} — Bytruvyus`,
    gotz: `${baseName} — Gotz (Hand)`,
    yorick: `${baseName} — Yorick (Head)`,
    piggy: `${baseName} — Piggy (Foot)`,
  };

  const result: AssembledModelsMap = {};

  for (const key of keys) {
    const groupTracks = tracks.filter((t) => t.component === key);
    if (groupTracks.length === 0) continue;

    const idSet = new Set(groupTracks.map((t) => t.suggestedNodeId));
    const trackById = new Map<string, DeducedTrackRule>();
    groupTracks.forEach((t) => trackById.set(t.suggestedNodeId, t));

    let maxX = stageWidth;
    let maxY = stageHeight;
    groupTracks.forEach((t) => {
      maxX = Math.max(maxX, t.layerBox.x + t.layerBox.w + 120);
      maxY = Math.max(maxY, t.layerBox.y + t.layerBox.h + 120);
    });

    const nodes: RigNodeSpec[] = groupTracks.map((tr) => {
      const asset = tr.matchedAssetId ? assetById.get(tr.matchedAssetId) : undefined;
      const aimTarget = tr.aimTargetId ? trackById.get(tr.aimTargetId) : undefined;
      const parentId =
        tr.suggestedParentId && idSet.has(tr.suggestedParentId)
          ? tr.suggestedParentId
          : null;

      return {
        id: tr.suggestedNodeId,
        name: tr.rawName,
        parent: parentId,
        pivot: [tr.computedPivot[0], tr.computedPivot[1]],
        ang: tr.restAngle,
        limits:
          tr.limits || BITRUVIAN_ANATOMICAL_LIMITS[tr.suggestedNodeId] || [-180, 180],
        lock: tr.locked,
        aim:
          tr.aimTargetId && aimTarget
            ? {
                to: tr.aimTargetId,
                from: [aimTarget.computedPivot[0], aimTarget.computedPivot[1]],
                min: tr.aimMin,
                max: tr.aimMax,
              }
            : null,
        top: tr.layerBox.y,
        left: tr.layerBox.x,
        pieces: asset
          ? [
              {
                i: tr.zIndex,
                name: asset.name,
                x: tr.layerBox.x,
                y: tr.layerBox.y,
                w: tr.layerBox.w,
                h: tr.layerBox.h,
                src: asset.src,
              },
            ]
          : [],
      };
    });

    // Ensure a valid root exists
    if (nodes.length > 0 && !nodes.some((n) => n.parent === null)) {
      nodes[0].parent = null;
    }

    // Auto-wire closed-chain shoulder aim bonds on Bytruvyus rigs when not explicitly parsed
    if (key === 'bytruvyus') {
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      for (const side of ['L', 'R'] as const) {
        const brace = nodeMap.get(`brace${side}`);
        const target =
          nodeMap.get(`acromion${side}`) ?? nodeMap.get(`humerus${side}`);
        if (brace && target && !brace.aim) {
          brace.aim = {
            to: target.id,
            from: [target.pivot[0], target.pivot[1]],
            min: 0.7,
            max: 1.1,
          };
        }
      }
    }

    const assembled: RigSpec = {
      name: labels[key],
      source: `Assembled from ${baseName}`,
      component: key,
      W: Math.round(maxX),
      H: Math.round(maxY),
      nodes,
    };
    result[key] = key === 'yorick' ? normalizeYorickHierarchy(assembled) : assembled;
  }

  return result;
}
