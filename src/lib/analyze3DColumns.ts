/**
 * استخراج أحمال الأعمدة من التحليل ثلاثي الأبعاد (3D Frame Analysis)
 * لاستخدامها في التصميم بدلاً من الطريقة التقريبية (2D)
 * 
 * المحاور: للأعمدة الرأسية:
 *   - Local Y = Global X → momentY = Mx (عزم حول المحور العالمي X)
 *   - Local Z = Global Y → momentZ = My (عزم حول المحور العالمي Y)
 *   - nodeI = أسفل العمود (Bot), nodeJ = أعلى العمود (Top)
 */

import type { Beam, Column, Frame, MatProps, Story } from '@/lib/structuralEngine';
import { analyze3DFrame, type Node3D, type Element3D, type Model3D, type LoadCase3D } from '@/lib/solver3D';

export interface ColumnLoads3D {
  Pu: number;
  Mx: number;   // max |momentY| (global X moment)
  My: number;   // max |momentZ| (global Y moment)
  MxTop: number; // momentY at top
  MxBot: number; // momentY at bottom
  MyTop: number; // momentZ at top
  MyBot: number; // momentZ at bottom
  Vu: number;    // max shear
}

/**
 * Run 3D analysis with pattern loading and return column loads for design.
 */
export function getColumnLoads3D(
  frames: Frame[],
  beams: Beam[],
  columns: Column[],
  mat: MatProps,
): Map<string, ColumnLoads3D> {
  const beamsMap = new Map(beams.map(b => [b.id, b]));
  const E = 4700 * Math.sqrt(mat.fc) * 1000;
  const G = E / (2 * (1 + 0.2));

  // Build 3D model
  const nodesMap = new Map<string, Node3D>();
  const elements3d: Element3D[] = [];

  // Helper: get or create node by position (ensures multi-story connectivity)
  // Columns at the same (x,y) across stories share nodes at floor levels
  const getOrCreateNode = (x: number, y: number, z: number, restraints: [boolean, boolean, boolean, boolean, boolean, boolean]): string => {
    const key = `N_${x.toFixed(0)}_${y.toFixed(0)}_${z.toFixed(0)}`;
    if (!nodesMap.has(key)) {
      nodesMap.set(key, { id: key, x, y, z, restraints });
    }
    return key;
  };

  // First pass: determine ground level (minimum zBottom)
  let minZ = Infinity;
  for (const col of columns) {
    if (col.isRemoved) continue;
    const zBot = col.zBottom ?? 0;
    if (zBot < minZ) minZ = zBot;
  }

  // Column-to-node mapping for beam connectivity
  const colTopNodeMap = new Map<string, string>();
  const colBotNodeMap = new Map<string, string>();

  for (const col of columns) {
    if (col.isRemoved) continue;
    const zBot = col.zBottom ?? 0;
    const zTop = col.zTop ?? (zBot + col.L);
    const xMm = col.x * 1000;
    const yMm = col.y * 1000;

    // Ground level columns sit on foundations → apply support restraints
    const isGroundLevel = Math.abs(zBot - minZ) < 1; // mm tolerance
    let botRestraints: [boolean, boolean, boolean, boolean, boolean, boolean];
    if (isGroundLevel) {
      const isPinned = col.bottomEndCondition === 'P';
      botRestraints = isPinned
        ? [true, true, true, false, false, false]  // Pinned
        : [true, true, true, true, true, true];     // Fixed
    } else {
      // Upper floor column bottom → free node (connected to lower column top via shared node)
      botRestraints = [false, false, false, false, false, false];
    }

    const botId = getOrCreateNode(xMm, yMm, zBot, botRestraints);
    const topId = getOrCreateNode(xMm, yMm, zTop, [false, false, false, false, false, false]);

    colBotNodeMap.set(col.id, botId);
    colTopNodeMap.set(col.id, topId);

    elements3d.push({
      id: `col_${col.id}`, type: 'column',
      nodeI: botId, nodeJ: topId,
      b: col.b, h: col.h, E, G,
      // Column self-weight: along local X (which is vertical for columns)
      // w_sw = γ × A = 25 kN/m³ × (b×h) mm² × 1e-6 m²/mm² = kN/m
      // Factor 1.2 for dead load
      wLocal: { wx: -1.2 * mat.gamma * (col.b * col.h) / 1e6, wy: 0, wz: 0 },
      stiffnessModifier: 0.70,
    });
  }

  // Beam elements
  const beamDeadLoads = new Map<string, number>();
  const beamLiveLoads = new Map<string, number>();
  const beamElemIds: string[] = [];
  const processedBeams = new Set<string>();

  for (const frame of frames) {
    for (const beamId of frame.beamIds) {
      if (processedBeams.has(beamId)) continue;
      processedBeams.add(beamId);

      const beam = beamsMap.get(beamId);
      if (!beam) continue;

      const fromCol = columns.find(c => c.id === beam.fromCol);
      const toCol = columns.find(c => c.id === beam.toCol);
      if (!fromCol || !toCol) continue;

      const nodeIId = colTopNodeMap.get(fromCol.id);
      const nodeJId = colTopNodeMap.get(toCol.id);
      if (!nodeIId || !nodeJId) continue;
      if (!nodesMap.has(nodeIId) || !nodesMap.has(nodeJId)) continue;

      const elemId = `beam_${beamId}`;
      elements3d.push({
        id: elemId, type: 'beam',
        nodeI: nodeIId, nodeJ: nodeJId,
        b: beam.b, h: beam.h, E, G,
        wLocal: { wx: 0, wy: 0, wz: 0 },
        stiffnessModifier: 0.35,
      });

      beamDeadLoads.set(elemId, 1.2 * beam.deadLoad);
      beamLiveLoads.set(elemId, 1.6 * beam.liveLoad);
      beamElemIds.push(elemId);
    }
  }

  const model: Model3D = { nodes: Array.from(nodesMap.values()), elements: elements3d };

  if (model.elements.length === 0) {
    return new Map();
  }

  // Pattern loading cases (ACI 318-19 §6.4.3)
  const patternCases: LoadCase3D[] = [];

  // Keep the value with the larger absolute magnitude while preserving its sign.
  // This is critical for top/bottom end moments so curvature detection (single vs double)
  // remains consistent with ETABS-style end-force output.
  const pickSignedMaxAbs = (current: number, incoming: number) =>
    Math.abs(incoming) > Math.abs(current) ? incoming : current;

  // 1.4D
  patternCases.push({
    id: 'case_1.4D', name: '1.4D', type: 'dead',
    elementLoads: new Map(beamElemIds.map(eid => [
      eid, { wx: 0, wy: 0, wz: -(1.4 / 1.2) * beamDeadLoads.get(eid)! }
    ])),
  });

  // Full load
  patternCases.push({
    id: 'case_full', name: '1.2D+1.6L', type: 'dead',
    elementLoads: new Map(beamElemIds.map(eid => [
      eid, { wx: 0, wy: 0, wz: -(beamDeadLoads.get(eid)! + beamLiveLoads.get(eid)!) }
    ])),
  });

  // Even/odd patterns
  patternCases.push({
    id: 'case_even', name: 'Even LL', type: 'dead',
    elementLoads: new Map(beamElemIds.map((eid, i) => [
      eid, { wx: 0, wy: 0, wz: -(beamDeadLoads.get(eid)! + (i % 2 === 0 ? beamLiveLoads.get(eid)! : 0)) }
    ])),
  });
  patternCases.push({
    id: 'case_odd', name: 'Odd LL', type: 'dead',
    elementLoads: new Map(beamElemIds.map((eid, i) => [
      eid, { wx: 0, wy: 0, wz: -(beamDeadLoads.get(eid)! + (i % 2 === 1 ? beamLiveLoads.get(eid)! : 0)) }
    ])),
  });

  // Per-beam patterns
  if (beamElemIds.length > 2) {
    for (let target = 0; target < beamElemIds.length; target++) {
      const loads = new Map<string, { wx: number; wy: number; wz: number }>();
      for (let i = 0; i < beamElemIds.length; i++) {
        const eid = beamElemIds[i];
        const hasLL = (Math.abs(i - target) % 2 === 0);
        loads.set(eid, {
          wx: 0, wy: 0,
          wz: -(beamDeadLoads.get(eid)! + (hasLL ? beamLiveLoads.get(eid)! : 0)),
        });
      }
      patternCases.push({ id: `case_p${target}`, name: `Pattern ${target + 1}`, type: 'dead', elementLoads: loads });
    }
  }

  // Run all cases and build envelope for columns
  const colEnvelope = new Map<string, {
    axial: number;
    shearMax: number;
    momentYI: number; momentYJ: number; momentYmax: number;
    momentZI: number; momentZJ: number; momentZmax: number;
  }>();

  for (const lc of patternCases) {
    const result = analyze3DFrame(model, lc);
    for (const er of result.elements) {
      if (!er.elementId.startsWith('col_')) continue;

      const prev = colEnvelope.get(er.elementId);
      if (!prev) {
        colEnvelope.set(er.elementId, {
          axial: Math.abs(er.axial),
          shearMax: Math.max(Math.abs(er.shearY), Math.abs(er.shearZ)),
          momentYI: er.momentYI,  // Bot Mx - keep sign
          momentYJ: er.momentYJ,  // Top Mx - keep sign
          momentYmax: er.momentYmax,
          momentZI: er.momentZI,   // Bot My - keep sign
          momentZJ: er.momentZJ,   // Top My - keep sign
          momentZmax: er.momentZmax,
        });
      } else {
        prev.axial = Math.max(prev.axial, Math.abs(er.axial));
        prev.shearMax = Math.max(prev.shearMax, Math.abs(er.shearY), Math.abs(er.shearZ));
        prev.momentYI = pickSignedMaxAbs(prev.momentYI, er.momentYI);
        prev.momentYJ = pickSignedMaxAbs(prev.momentYJ, er.momentYJ);
        prev.momentYmax = Math.max(prev.momentYmax, er.momentYmax);
        prev.momentZI = pickSignedMaxAbs(prev.momentZI, er.momentZI);
        prev.momentZJ = pickSignedMaxAbs(prev.momentZJ, er.momentZJ);
        prev.momentZmax = Math.max(prev.momentZmax, er.momentZmax);
      }
    }
  }

  // Convert to design loads
  const result = new Map<string, ColumnLoads3D>();
  for (const col of columns) {
    if (col.isRemoved) continue;
    const env = colEnvelope.get(`col_${col.id}`);
    if (env) {
      result.set(col.id, {
        Pu: env.axial,
        Mx: env.momentYmax,      // Global X moment
        My: env.momentZmax,      // Global Y moment
        MxTop: env.momentYJ,     // nodeJ = top
        MxBot: env.momentYI,     // nodeI = bottom
        MyTop: env.momentZJ,
        MyBot: env.momentZI,
        Vu: env.shearMax,
      });
    } else {
      result.set(col.id, { Pu: 0, Mx: 0, My: 0, MxTop: 0, MxBot: 0, MyTop: 0, MyBot: 0, Vu: 0 });
    }
  }

  return result;
}
