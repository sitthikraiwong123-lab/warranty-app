const COMPONENT_TYPES = Object.freeze({
  spindle: {
    labelTh: 'ชุด Spindle',
    labelEn: 'Spindle assembly',
    keywords: ['spindle', 'สปินเดิล', 'หัวเจาะ', 'collet']
  },
  ccd: {
    labelTh: 'กล้อง CCD',
    labelEn: 'CCD camera',
    keywords: ['ccd', 'camera', 'กล้อง']
  },
  table: {
    labelTh: 'โต๊ะและระบบแกน',
    labelEn: 'Table and axis system',
    keywords: ['table', 'axis', 'linear', 'โต๊ะ', 'แกน', 'motor', 'มอเตอร์']
  },
  toolMagazine: {
    labelTh: 'ชุดเก็บและเปลี่ยน Tool',
    labelEn: 'Tool magazine',
    keywords: ['tool', 'magazine', 'drill bit', 'ดอก', 'เครื่องมือ']
  },
  vacuum: {
    labelTh: 'ระบบ Vacuum',
    labelEn: 'Vacuum system',
    keywords: ['vacuum', 'suction', 'ดูด', 'ท่อ']
  },
  safety: {
    labelTh: 'ฝาและระบบ Safety',
    labelEn: 'Door and safety system',
    keywords: ['door', 'cover', 'safety', 'switch', 'ฝา', 'ประตู', 'เซฟตี้']
  }
});

function buildStationComponents() {
  const parts = [];
  for (let station = 1; station <= 6; station += 1) {
    for (const kind of ['spindle', 'ccd', 'table', 'toolMagazine']) {
      const type = COMPONENT_TYPES[kind];
      parts.push(Object.freeze({
        id: `station-${station}-${kind === 'toolMagazine' ? 'tool-magazine' : kind}`,
        station,
        kind,
        labelTh: `${type.labelTh} · สถานี ${station}`,
        labelEn: `${type.labelEn} · Station ${station}`,
        keywords: type.keywords
      }));
    }
  }
  parts.push(Object.freeze({
    id: 'vacuum-system', station: 0, kind: 'vacuum',
    labelTh: COMPONENT_TYPES.vacuum.labelTh,
    labelEn: COMPONENT_TYPES.vacuum.labelEn,
    keywords: COMPONENT_TYPES.vacuum.keywords
  }));
  parts.push(Object.freeze({
    id: 'front-safety-door', station: 0, kind: 'safety',
    labelTh: COMPONENT_TYPES.safety.labelTh,
    labelEn: COMPONENT_TYPES.safety.labelEn,
    keywords: COMPONENT_TYPES.safety.keywords
  }));
  return Object.freeze(parts);
}
const SHARED_COMPONENTS = buildStationComponents();

export const MACHINE_MODELS = Object.freeze({
  MXY6: Object.freeze({
    id: 'MXY6',
    name: 'Schmoll MXY-6',
    note: 'Reference model · S50 generation · 6 independent stations',
    stationCount: 6,
    visual: Object.freeze({
      profile: 'photo-reference-v1', referencePhotoCount: 5,
      frontDoorCount: 3, hasServiceBay: true, bodyAspect: 3.1
    }),
    theme: Object.freeze({ shell: 0xe9eaec, frame: 0x30343a, accent: 0xc9151e, glass: 0x1f3545 }),
    components: SHARED_COMPONENTS
  }),
  EXY6: Object.freeze({
    id: 'EXY6',
    name: 'Schmoll Eagle EXY-6',
    note: 'Reference model · Eagle series · 6 independent stations',
    stationCount: 6,
    visual: Object.freeze({ profile: 'procedural-reference' }),
    theme: Object.freeze({ shell: 0xf5f5f2, frame: 0x27292d, accent: 0x9d0b19, glass: 0x243b4c }),
    components: SHARED_COMPONENTS
  })
});

export function createMachineViewState(modelId = 'MXY6') {
  const resolvedModelId = MACHINE_MODELS[modelId] ? modelId : 'MXY6';
  return Object.freeze({
    modelId: resolvedModelId,
    doorsOpen: false,
    shellVisible: true,
    selectedComponentId: ''
  });
}

export function toggleDoor(state) {
  return Object.freeze({ ...state, doorsOpen: !state.doorsOpen });
}

export function toggleShellVisibility(state) {
  return Object.freeze({ ...state, shellVisible: !state.shellVisible });
}

export function selectComponent(state, componentId = '') {
  return Object.freeze({ ...state, selectedComponentId: String(componentId || '') });
}

export function switchMachineModel(state, modelId) {
  return createMachineViewState(MACHINE_MODELS[modelId] ? modelId : state.modelId);
}

export function findComponent(modelId, componentId) {
  const model = MACHINE_MODELS[modelId] || MACHINE_MODELS.MXY6;
  return model.components.find((part) => part.id === componentId) || null;
}

function searchablePartText(row) {
  return [
    row && row.ArticleNo,
    row && (row.Description || row.PartName),
    row && (row.PredictWords || row.SearchWords),
    row && row.Category
  ].filter(Boolean).join(' ').toLocaleLowerCase('th-TH');
}

export function findMatchingDatabaseParts(rows, keywords, limit = 12) {
  if (!Array.isArray(rows) || !Array.isArray(keywords)) return [];
  const needles = keywords
    .map((value) => String(value || '').trim().toLocaleLowerCase('th-TH'))
    .filter(Boolean);
  if (!needles.length) return [];
  return rows
    .filter((row) => {
      const haystack = searchablePartText(row);
      return haystack && needles.some((needle) => haystack.includes(needle));
    })
    .slice(0, Math.max(0, Number(limit) || 0));
}
