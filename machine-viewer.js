import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import {
  MACHINE_MODELS,
  createMachineViewState,
  toggleDoor,
  toggleShellVisibility,
  selectComponent,
  switchMachineModel,
  findComponent,
  findMatchingDatabaseParts
} from './machine-viewer-core.mjs';

const STYLE_ID = 'machine3dStyles';
let activeViewer = null;

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .m3d-overlay{position:fixed;inset:0;z-index:1200;background:rgba(18,22,29,.72);display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;backdrop-filter:blur(3px)}
    .m3d-dialog{width:min(1180px,100%);height:min(760px,calc(100dvh - 28px));background:#f6f7f9;border-radius:16px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.34);display:grid;grid-template-rows:auto auto minmax(0,1fr);color:#20242a}
    .m3d-head{min-height:54px;display:flex;align-items:center;gap:12px;padding:9px 12px 9px 16px;background:#fff;border-bottom:1px solid #e4e7eb}
    .m3d-title{min-width:0;flex:1}.m3d-title strong{display:block;font-size:15px}.m3d-title span{display:block;margin-top:2px;color:#727984;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .m3d-model-select{height:36px;max-width:235px;border:1px solid #d6dae0;background:#fff;border-radius:9px;padding:0 30px 0 10px;font:600 12px system-ui,sans-serif;color:#292d33}
    .m3d-close{width:36px;height:36px;border:0;border-radius:9px;background:#f0f1f3;color:#34383e;font-size:19px;cursor:pointer}.m3d-close:hover{background:#e5e7ea}
    .m3d-tools{display:flex;align-items:center;gap:7px;padding:8px 12px;background:#fff;border-bottom:1px solid #e4e7eb;overflow-x:auto;scrollbar-width:thin}
    .m3d-tool{flex:0 0 auto;border:1px solid #d8dce2;border-radius:9px;background:#fff;color:#3b4048;padding:8px 11px;font:700 11px system-ui,sans-serif;cursor:pointer;white-space:nowrap}.m3d-tool:hover{border-color:#bdc3cc;background:#f8f9fa}.m3d-tool.active{border-color:#c9151e;color:#a80f17;background:#fff2f2}
    .m3d-status{margin-left:auto;color:#7b828d;font-size:10.5px;white-space:nowrap}
    .m3d-main{min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 330px}
    .m3d-stage{position:relative;min-width:0;min-height:320px;background:radial-gradient(circle at 50% 38%,#f7f9fb 0,#dce1e6 55%,#c8ced5 100%);overflow:hidden;touch-action:none}
    .m3d-stage canvas{display:block;width:100%;height:100%;outline:none}
    .m3d-stage-help{position:absolute;left:12px;bottom:10px;pointer-events:none;border-radius:8px;padding:6px 9px;background:rgba(24,29,36,.74);color:#fff;font-size:10px;line-height:1.35}
    .m3d-loading,.m3d-webgl-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:#4a515c;font-size:13px;line-height:1.6;background:rgba(245,247,249,.9)}
    .m3d-loading::before{content:'';width:20px;height:20px;border:3px solid #d2d6dc;border-top-color:#c9151e;border-radius:50%;margin-right:9px;animation:m3d-spin .8s linear infinite}@keyframes m3d-spin{to{transform:rotate(360deg)}}
    .m3d-info{min-width:0;background:#fff;border-left:1px solid #e2e5e9;display:flex;flex-direction:column;overflow:hidden}
    .m3d-info-head{padding:15px;border-bottom:1px solid #eceef1}.m3d-info-kicker{color:#a90f17;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.m3d-info-title{margin-top:5px;font-size:15px;font-weight:800;line-height:1.25}.m3d-info-sub{margin-top:5px;color:#747b85;font-size:10.5px;line-height:1.45}
    .m3d-part-list{padding:10px;overflow:auto;min-height:0}.m3d-empty{margin:10px 4px;padding:16px;border:1px dashed #d6dae0;border-radius:10px;background:#fafbfc;color:#6c737e;font-size:11px;line-height:1.55;text-align:center}
    .m3d-db-part{display:grid;grid-template-columns:58px minmax(0,1fr);gap:9px;padding:9px;margin-bottom:8px;border:1px solid #e2e5e9;border-radius:10px;background:#fff}.m3d-db-part img,.m3d-no-photo{width:58px;height:58px;border-radius:8px;object-fit:cover;background:#eceff2}.m3d-no-photo{display:flex;align-items:center;justify-content:center;color:#9aa0aa;font-size:20px}.m3d-db-copy{min-width:0}.m3d-db-code{font-size:10px;font-weight:800;color:#ae121a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.m3d-db-name{margin-top:3px;font-size:11.5px;font-weight:700;line-height:1.3;word-break:break-word}.m3d-db-pending{display:inline-block;margin-top:4px;border-radius:10px;padding:2px 6px;background:#fff1c7;color:#765700;font-size:9px;font-weight:700}
    .m3d-use-part{margin-top:7px;border:0;border-radius:7px;background:#343940;color:#fff;padding:6px 8px;font-size:10px;font-weight:700;cursor:pointer}.m3d-use-part:hover{background:#20242a}
    @media (max-width:720px){
      .m3d-overlay{padding:0;align-items:stretch}.m3d-dialog{height:100dvh;width:100%;border-radius:0;grid-template-rows:auto auto minmax(0,1fr)}
      .m3d-head{padding-left:12px}.m3d-title span{display:none}.m3d-model-select{max-width:155px;font-size:11px}.m3d-tools{padding:7px 9px}.m3d-status{display:none}
      .m3d-main{grid-template-columns:1fr;grid-template-rows:minmax(300px,56%) minmax(0,44%)}.m3d-info{border-left:0;border-top:1px solid #e2e5e9}.m3d-info-head{padding:10px 12px}.m3d-info-sub{display:none}.m3d-part-list{padding:8px}.m3d-stage-help{font-size:9px}
    }
    @media (prefers-reduced-motion:reduce){.m3d-loading::before{animation:none}}
  `;
  document.head.appendChild(style);
}

function staticShell() {
  const overlay = document.createElement('div');
  overlay.className = 'm3d-overlay';
  overlay.innerHTML = `
    <section class="m3d-dialog" role="dialog" aria-modal="true" aria-labelledby="m3dDialogTitle">
      <header class="m3d-head">
        <div class="m3d-title"><strong id="m3dDialogTitle">แผนผังเครื่อง 3D</strong><span>โมเดลอ้างอิงสำหรับค้นหาอะไหล่ · ไม่ใช้วัดระยะทางวิศวกรรม</span></div>
        <select class="m3d-model-select" aria-label="เลือกรุ่นเครื่อง">
          <option value="MXY6">Schmoll MXY-6</option>
          <option value="EXY6">Eagle EXY-6</option>
        </select>
        <button type="button" class="m3d-close" aria-label="ปิด">×</button>
      </header>
      <div class="m3d-tools" role="toolbar" aria-label="เครื่องมือดูโมเดล">
        <button type="button" class="m3d-tool m3d-door">เปิดฝาหน้า</button>
        <button type="button" class="m3d-tool m3d-shell">ซ่อนกรอบภายนอก</button>
        <button type="button" class="m3d-tool m3d-reset">จัดมุมมองใหม่</button>
        <span class="m3d-status">MXY-6 · 6 สถานี</span>
      </div>
      <div class="m3d-main">
        <div class="m3d-stage" tabindex="0" aria-label="โมเดลเครื่องจักรสามมิติ">
          <div class="m3d-loading">กำลังเตรียมโมเดล 3D…</div>
          <div class="m3d-stage-help">ลากเพื่อหมุน · เลื่อนสองนิ้ว/ล้อเมาส์เพื่อซูม · แตะชิ้นส่วนเพื่อดูข้อมูล</div>
        </div>
        <aside class="m3d-info" aria-live="polite">
          <div class="m3d-info-head">
            <div class="m3d-info-kicker">Interactive parts</div>
            <div class="m3d-info-title">เลือกชิ้นส่วนบนเครื่อง</div>
            <div class="m3d-info-sub">กดหัวเจาะ กล้อง โต๊ะ หรือ Tool magazine เพื่อค้นหารูปและอะไหล่จริงจากฐานข้อมูล</div>
          </div>
          <div class="m3d-part-list"><div class="m3d-empty">ยังไม่ได้เลือกชิ้นส่วน<br>ลองเปิดฝาหน้าแล้วกดหมายเลขสถานีหรือชุดหัวเจาะ</div></div>
        </aside>
      </div>
    </section>`;
  return overlay;
}

function firstImageUrl(row) {
  const raw = String((row && (row.ImageURL || row.ImageUrl || row.imageURL)) || '').trim();
  if (!raw) return '';
  return raw.split(/[\n,;|]+/).map((value) => value.trim()).find(Boolean) || '';
}

function makeMaterial(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.58,
    metalness: options.metalness ?? 0.16,
    transparent: Boolean(options.transparent),
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide
  });
}

class MachineViewer {
  constructor(options = {}) {
    this.options = options;
    this.state = createMachineViewState(options.modelId || 'MXY6');
    this.overlay = staticShell();
    this.stage = this.overlay.querySelector('.m3d-stage');
    this.infoTitle = this.overlay.querySelector('.m3d-info-title');
    this.infoSub = this.overlay.querySelector('.m3d-info-sub');
    this.partList = this.overlay.querySelector('.m3d-part-list');
    this.status = this.overlay.querySelector('.m3d-status');
    this.doorButton = this.overlay.querySelector('.m3d-door');
    this.shellButton = this.overlay.querySelector('.m3d-shell');
    this.modelSelect = this.overlay.querySelector('.m3d-model-select');
    this.machineRoot = null;
    this.shellMeshes = [];
    this.doorPivots = [];
    this.selectableMeshes = [];
    this.selectedMeshes = [];
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.previousFocus = document.activeElement;
    this.boundKeydown = (event) => { if (event.key === 'Escape') this.close(); };
  }

  open() {
    document.body.appendChild(this.overlay);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', this.boundKeydown);
    this.overlay.querySelector('.m3d-close').addEventListener('click', () => this.close());
    this.overlay.addEventListener('mousedown', (event) => { if (event.target === this.overlay) this.close(); });
    this.modelSelect.value = this.state.modelId;
    this.modelSelect.addEventListener('change', () => this.changeModel(this.modelSelect.value));
    this.doorButton.addEventListener('click', () => this.setDoorState());
    this.shellButton.addEventListener('click', () => this.setShellState());
    this.overlay.querySelector('.m3d-reset').addEventListener('click', () => this.resetCamera());
    this.overlay.querySelector('.m3d-close').focus();
    requestAnimationFrame(() => this.initThree());
  }

  initThree() {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (error) {
      this.showWebglError(error);
      return;
    }
    if (!this.renderer || !this.renderer.domElement) {
      this.showWebglError(new Error('WebGL is unavailable'));
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.stage.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 31;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.target.set(0, 2.6, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7c8793, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(-6, 11, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -12; key.shadow.camera.right = 12;
    key.shadow.camera.top = 10; key.shadow.camera.bottom = -6;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe5df, 1.2);
    fill.position.set(8, 5, -4);
    this.scene.add(fill);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(36, 24), makeMaterial(0xbfc5cb, { roughness: 0.92, metalness: 0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.buildMachine();
    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      this.pointerDown = { x:event.clientX, y:event.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', (event) => {
      const start = this.pointerDown;
      this.pointerDown = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) this.pick(event);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resize();
    this.resetCamera();
    this.stage.querySelector('.m3d-loading')?.remove();
    this.renderer.setAnimationLoop(() => this.render());
  }

  showWebglError(error) {
    const loading = this.stage.querySelector('.m3d-loading');
    if (loading) loading.remove();
    const message = document.createElement('div');
    message.className = 'm3d-webgl-error';
    message.textContent = 'อุปกรณ์นี้ไม่รองรับ WebGL หรือปิดการเร่งกราฟิกอยู่ จึงเปิดโมเดล 3D ไม่ได้ กรุณาลอง Chrome/Edge รุ่นใหม่หรือเปิด Hardware acceleration';
    message.title = String((error && error.message) || 'WebGL is unavailable');
    this.stage.appendChild(message);
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, this.stage.clientWidth);
    const height = Math.max(1, this.stage.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  makeBox(name, size, position, material, componentId = '') {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), componentId ? material.clone() : material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (componentId) {
      mesh.userData.componentId = componentId;
      mesh.userData.selectable = true;
      this.selectableMeshes.push(mesh);
    }
    return mesh;
  }

  makeStationLabel(number, x) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = '#c9151e'; context.beginPath(); context.arc(64, 64, 52, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#ffffff'; context.font = '700 64px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(number), 64, 67);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.position.set(x, 4.7, 1.62);
    sprite.scale.set(.52, .52, .52);
    sprite.renderOrder = 4;
    sprite.userData.componentId = `station-${number}-spindle`;
    sprite.userData.selectable = true;
    this.selectableMeshes.push(sprite);
    return sprite;
  }

  buildMachine() {
    if (this.machineRoot) {
      this.scene.remove(this.machineRoot);
      this.disposeObject(this.machineRoot);
    }
    const model = MACHINE_MODELS[this.state.modelId];
    const theme = model.theme;
    this.machineRoot = new THREE.Group();
    this.machineRoot.name = model.name;
    this.machineRoot.position.y = 0.08;
    this.scene.add(this.machineRoot);
    this.shellMeshes = [];
    this.doorPivots = [];
    this.selectableMeshes = [];
    this.selectedMeshes = [];

    const shellMat = makeMaterial(theme.shell, { roughness: .7, metalness: .08 });
    const frameMat = makeMaterial(theme.frame, { roughness: .45, metalness: .42 });
    const accentMat = makeMaterial(theme.accent, { roughness: .42, metalness: .18 });
    const steelMat = makeMaterial(0x9aa2aa, { roughness: .3, metalness: .72 });
    const darkMat = makeMaterial(0x242a31, { roughness: .48, metalness: .32 });
    const glassMat = makeMaterial(theme.glass, { roughness: .15, metalness: .05, transparent: true, opacity: .28, side: THREE.DoubleSide });
    glassMat.depthWrite = false;

    const base = this.makeBox('granite-base', [13.4, 1.28, 4.2], [0, .7, 0], frameMat);
    this.machineRoot.add(base);
    const plinth = this.makeBox('lower-shell', [13.1, 1.38, 3.9], [0, 1.55, 0], shellMat);
    this.machineRoot.add(plinth);
    const accent = this.makeBox('brand-accent', [13.18, .19, .16], [0, 2.18, 2.02], accentMat);
    this.machineRoot.add(accent);

    const frameBars = [
      [[13.1,.22,.25],[0,2.35,1.92]], [[13.1,.22,.25],[0,6.32,1.92]],
      [[.24,4.1,.25],[-6.44,4.3,1.92]], [[.24,4.1,.25],[6.44,4.3,1.92]],
      [[13.1,.22,.25],[0,2.35,-1.92]], [[13.1,.22,.25],[0,6.32,-1.92]]
    ];
    frameBars.forEach((entry, index) => this.machineRoot.add(this.makeBox(`frame-${index}`, entry[0], entry[1], frameMat)));

    const leftPanel = this.makeBox('left-shell', [.24, 3.8, 3.65], [-6.43, 4.35, 0], shellMat);
    const rightPanel = this.makeBox('right-shell', [.24, 3.8, 3.65], [6.43, 4.35, 0], shellMat);
    const roof = this.makeBox('roof-shell', [13.0, .22, 3.65], [0, 6.34, 0], shellMat);
    const back = this.makeBox('back-shell', [13.0, 3.8, .2], [0, 4.35, -1.88], shellMat);
    this.shellMeshes.push(leftPanel, rightPanel, roof, back);
    this.machineRoot.add(leftPanel, rightPanel, roof, back);

    const bayWidth = 1.78;
    for (let station = 1; station <= 6; station += 1) {
      const x = (station - 3.5) * 2.02;
      const tableId = `station-${station}-table`;
      const spindleId = `station-${station}-spindle`;
      const ccdId = `station-${station}-ccd`;
      const toolId = `station-${station}-tool-magazine`;

      const table = this.makeBox(`station-${station}-xy-table`, [bayWidth, .18, 2.4], [x, 2.58, .08], steelMat, tableId);
      this.machineRoot.add(table);
      const railA = this.makeBox(`station-${station}-rail-a`, [bayWidth, .08, .12], [x, 2.73, -.82], darkMat, tableId);
      const railB = this.makeBox(`station-${station}-rail-b`, [bayWidth, .08, .12], [x, 2.73, .82], darkMat, tableId);
      this.machineRoot.add(railA, railB);

      const column = this.makeBox(`station-${station}-z-column`, [.34, 2.35, .35], [x, 4.48, -.78], darkMat, spindleId);
      this.machineRoot.add(column);
      const head = this.makeBox(`station-${station}-head`, [1.18, .42, .78], [x, 4.88, .05], accentMat, spindleId);
      this.machineRoot.add(head);
      const spindle = new THREE.Mesh(new THREE.CylinderGeometry(.16, .23, 1.7, 20), steelMat.clone());
      spindle.name = `station-${station}-spindle`;
      spindle.position.set(x, 4.02, .2);
      spindle.userData.componentId = spindleId;
      spindle.userData.selectable = true;
      spindle.castShadow = true;
      this.selectableMeshes.push(spindle);
      this.machineRoot.add(spindle);

      const ccd = this.makeBox(`station-${station}-ccd`, [.46, .34, .5], [x + .55, 4.65, .36], darkMat, ccdId);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, .18, 16), makeMaterial(0x3a79a8, { roughness: .12, metalness: .18 }));
      lens.rotation.x = Math.PI / 2;
      lens.position.set(x + .55, 4.65, .67);
      lens.userData.componentId = ccdId;
      lens.userData.selectable = true;
      this.selectableMeshes.push(lens);
      this.machineRoot.add(ccd, lens);

      const toolRack = this.makeBox(`station-${station}-tools`, [1.2, .26, .42], [x, 2.74, -1.33], darkMat, toolId);
      this.machineRoot.add(toolRack);
      for (let tool = 0; tool < 7; tool += 1) {
        const bit = new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, .34, 8), steelMat.clone());
        bit.position.set(x - .43 + tool * .143, 3.02, -1.33);
        bit.userData.componentId = toolId;
        bit.userData.selectable = true;
        this.selectableMeshes.push(bit);
        this.machineRoot.add(bit);
      }
      this.machineRoot.add(this.makeStationLabel(station, x));
    }

    const vacuum = this.makeBox('vacuum-manifold', [11.5, .28, .34], [0, 5.75, -1.3], darkMat, 'vacuum-system');
    this.machineRoot.add(vacuum);
    for (let station = 1; station <= 6; station += 1) {
      const x = (station - 3.5) * 2.02;
      const hoseCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 5.72, -1.15),
        new THREE.Vector3(x + .22, 5.45, -.62),
        new THREE.Vector3(x, 4.9, .05)
      ]);
      const hose = new THREE.Mesh(new THREE.TubeGeometry(hoseCurve, 14, .055, 7, false), makeMaterial(0x535b64, { roughness: .8, metalness: 0 }));
      hose.userData.componentId = 'vacuum-system';
      hose.userData.selectable = true;
      this.selectableMeshes.push(hose);
      this.machineRoot.add(hose);
    }

    this.buildDoor('left', -6.38, shellMat, frameMat, glassMat);
    this.buildDoor('right', 6.38, shellMat, frameMat, glassMat);

    const consoleArm = this.makeBox('console-arm', [.18, 2.2, .18], [-7.22, 4.05, .6], frameMat);
    consoleArm.rotation.z = -.2;
    const consoleBody = this.makeBox('control-console', [1.55, 1.08, .32], [-7.65, 5.15, 1.02], darkMat);
    consoleBody.rotation.y = .18;
    const screen = this.makeBox('control-screen', [1.25, .76, .04], [-7.61, 5.18, 1.2], makeMaterial(0x284b5e, { roughness: .12, metalness: .04 }));
    screen.rotation.y = .18;
    const emergency = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, .11, 16), accentMat);
    emergency.rotation.x = Math.PI / 2;
    emergency.position.set(-7.13, 4.77, 1.25);
    this.machineRoot.add(consoleArm, consoleBody, screen, emergency);

    this.status.textContent = `${model.name} · ${model.stationCount} สถานี`;
    this.applyStateToScene(true);
  }

  buildDoor(side, hingeX, shellMat, frameMat, glassMat) {
    const direction = side === 'left' ? 1 : -1;
    const pivot = new THREE.Group();
    pivot.name = `${side}-door-pivot`;
    pivot.position.set(hingeX, 4.42, 1.96);
    pivot.userData.closedRotation = 0;
    pivot.userData.openRotation = direction * 1.16;
    const centerX = direction * 2.98;
    const top = this.makeBox(`${side}-door-top`, [5.95, .44, .15], [centerX, 1.63, 0], shellMat, 'front-safety-door');
    const bottom = this.makeBox(`${side}-door-bottom`, [5.95, .62, .15], [centerX, -1.54, 0], shellMat, 'front-safety-door');
    const outer = this.makeBox(`${side}-door-outer`, [.34, 2.75, .16], [centerX + direction * 2.8, .18, 0], frameMat, 'front-safety-door');
    const inner = this.makeBox(`${side}-door-inner`, [.34, 2.75, .16], [centerX - direction * 2.8, .18, 0], frameMat, 'front-safety-door');
    const glass = this.makeBox(`${side}-window-glass`, [4.95, 2.37, .05], [direction * 2.98, .18, .11], glassMat, 'front-safety-door');
    pivot.add(top, bottom, outer, inner, glass);
    this.machineRoot.add(pivot);
    this.doorPivots.push(pivot);
  }

  applyStateToScene(immediate = false) {
    this.shellMeshes.forEach((mesh) => { mesh.visible = this.state.shellVisible; });
    this.shellButton.classList.toggle('active', !this.state.shellVisible);
    this.shellButton.textContent = this.state.shellVisible ? 'ซ่อนกรอบภายนอก' : 'แสดงกรอบทั้งหมด';
    this.doorButton.classList.toggle('active', this.state.doorsOpen);
    this.doorButton.textContent = this.state.doorsOpen ? 'ปิดฝาหน้า' : 'เปิดฝาหน้า';
    if (immediate || this.reducedMotion) {
      this.doorPivots.forEach((pivot) => {
        pivot.rotation.y = this.state.doorsOpen ? pivot.userData.openRotation : pivot.userData.closedRotation;
        pivot.visible = this.state.shellVisible;
      });
    }
  }

  setDoorState() {
    if (!this.state.shellVisible) this.state = toggleShellVisibility(this.state);
    this.state = toggleDoor(this.state);
    this.applyStateToScene();
  }

  setShellState() {
    this.state = toggleShellVisibility(this.state);
    this.applyStateToScene(true);
    this.doorPivots.forEach((pivot) => { pivot.visible = this.state.shellVisible; });
  }

  changeModel(modelId) {
    this.state = switchMachineModel(this.state, modelId);
    this.buildMachine();
    this.resetCamera();
    this.renderEmptyInfo();
  }

  resetCamera() {
    if (!this.camera || !this.controls) return;
    this.camera.position.set(14.5, 8.2, 15.5);
    this.controls.target.set(0, 3.25, 0);
    this.controls.update();
  }

  pick(event) {
    if (!this.renderer || !this.camera) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.selectableMeshes, false).find((entry) => entry.object.visible);
    if (!hit) return;
    const componentId = hit.object.userData.componentId;
    if (!componentId) return;
    if (componentId === 'front-safety-door') this.setDoorState();
    this.select(componentId);
  }

  select(componentId) {
    this.state = selectComponent(this.state, componentId);
    this.selectedMeshes.forEach((mesh) => {
      if (mesh.material && mesh.material.emissive) mesh.material.emissive.setHex(mesh.userData.originalEmissive || 0x000000);
    });
    this.selectedMeshes = this.selectableMeshes.filter((mesh) => mesh.userData.componentId === componentId);
    this.selectedMeshes.forEach((mesh) => {
      if (!mesh.material || !mesh.material.emissive) return;
      mesh.userData.originalEmissive = mesh.material.emissive.getHex();
      mesh.material.emissive.setHex(0x7a180d);
    });
    this.renderComponentInfo(componentId);
  }

  currentParts() {
    try {
      if (typeof this.options.getParts === 'function') return this.options.getParts() || [];
      return Array.isArray(this.options.parts) ? this.options.parts : [];
    } catch (_error) {
      return [];
    }
  }

  renderEmptyInfo() {
    this.infoTitle.textContent = 'เลือกชิ้นส่วนบนเครื่อง';
    this.infoSub.textContent = 'กดหัวเจาะ กล้อง โต๊ะ หรือ Tool magazine เพื่อค้นหารูปและอะไหล่จริงจากฐานข้อมูล';
    this.partList.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'm3d-empty';
    empty.textContent = 'ยังไม่ได้เลือกชิ้นส่วน · ลองเปิดฝาหน้าแล้วกดชิ้นส่วนด้านใน';
    this.partList.appendChild(empty);
  }

  renderComponentInfo(componentId) {
    const component = findComponent(this.state.modelId, componentId);
    if (!component) return;
    this.infoTitle.textContent = component.labelTh;
    this.infoSub.textContent = `คำค้นหา: ${component.keywords.join(' · ')}`;
    const matches = findMatchingDatabaseParts(this.currentParts(), component.keywords, 20);
    this.partList.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'm3d-empty';
      empty.textContent = 'ยังไม่พบอะไหล่ที่ตรงกับหมวดนี้ในฐานข้อมูล สามารถเพิ่มข้อมูลหรือรูปภายหลังได้ โดยไม่ต้องแก้โมเดล 3D';
      this.partList.appendChild(empty);
      return;
    }
    matches.forEach((row) => this.partList.appendChild(this.makeDatabasePartCard(row)));
  }

  makeDatabasePartCard(row) {
    const card = document.createElement('article');
    card.className = 'm3d-db-part';
    const imageUrl = firstImageUrl(row);
    if (imageUrl) {
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = String(row.Description || row.PartName || 'รูปอะไหล่');
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.onerror = () => image.replaceWith(this.noPhoto());
      card.appendChild(image);
    } else {
      card.appendChild(this.noPhoto());
    }
    const copy = document.createElement('div');
    copy.className = 'm3d-db-copy';
    const code = document.createElement('div');
    code.className = 'm3d-db-code';
    code.textContent = String(row.ArticleNo || 'รอเข้า DB · ยังไม่มี Article No.');
    const name = document.createElement('div');
    name.className = 'm3d-db-name';
    name.textContent = String(row.Description || row.PartName || 'ไม่ระบุชื่ออะไหล่');
    copy.append(code, name);
    if (!row.ArticleNo) {
      const pending = document.createElement('span');
      pending.className = 'm3d-db-pending';
      pending.textContent = 'รอเข้า DB';
      copy.appendChild(pending);
    }
    if (typeof this.options.onChoosePart === 'function') {
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'm3d-use-part';
      use.textContent = '＋ เพิ่มลงใบเบิก';
      use.addEventListener('click', () => this.options.onChoosePart(row));
      copy.appendChild(use);
    }
    card.appendChild(copy);
    return card;
  }

  noPhoto() {
    const placeholder = document.createElement('div');
    placeholder.className = 'm3d-no-photo';
    placeholder.textContent = '📷';
    return placeholder;
  }

  render() {
    if (!this.renderer || !this.scene || !this.camera) return;
    this.controls.update();
    this.doorPivots.forEach((pivot) => {
      const target = this.state.doorsOpen ? pivot.userData.openRotation : pivot.userData.closedRotation;
      pivot.rotation.y += (target - pivot.rotation.y) * .13;
    });
    this.renderer.render(this.scene, this.camera);
  }

  disposeObject(root) {
    root.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (material.map) material.map.dispose();
          material.dispose();
        });
      }
    });
  }

  close() {
    if (activeViewer !== this) return;
    document.removeEventListener('keydown', this.boundKeydown);
    this.resizeObserver?.disconnect();
    this.renderer?.setAnimationLoop(null);
    this.controls?.dispose();
    if (this.machineRoot) this.disposeObject(this.machineRoot);
    this.renderer?.dispose();
    this.overlay.remove();
    document.body.style.overflow = '';
    if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
    activeViewer = null;
  }
}

export function openMachineViewer(options = {}) {
  installStyles();
  if (activeViewer) {
    activeViewer.overlay.querySelector('.m3d-close')?.focus();
    return activeViewer;
  }
  activeViewer = new MachineViewer(options);
  activeViewer.open();
  return activeViewer;
}
