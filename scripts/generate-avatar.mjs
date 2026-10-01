// Original OfficeAI asset. Regenerate with: node scripts/generate-avatar.mjs
import * as T from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mkdir, writeFile } from 'node:fs/promises';

// GLTFExporter needs the browser FileReader API for its binary buffer only.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  async readAsDataURL(blob) {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onloadend?.();
  }
};

const root = new T.Group(); root.name = 'OfficeAI_GenZ';
const bones = [], bindPositions = [], parts = [], groups = [];
const materials = [
  ['outfit', 0x507e87], ['skin', 0xdeaa83], ['hair', 0x25232b],
  ['trousers', 0x263148], ['sneakers', 0xe8e5dc], ['accent', 0xe8bc70],
  ['ink', 0x252a38], ['white', 0xf4eee5],
].map(([name, color]) => { const m = new T.MeshStandardMaterial({color, roughness: .85}); m.name = name; return m; });
function joint(name, parent, offset) {
  const bone = new T.Bone(); bone.name = name; bone.position.set(...offset);
  (parent ?? root).add(bone); root.updateMatrixWorld(true);
  bones.push(bone); bindPositions.push(bone.getWorldPosition(new T.Vector3())); return bone;
}
const hips = joint('Hips', null, [0,.8,0]);
const spine = joint('Spine', hips, [0,.34,0]);
const head = joint('Head', spine, [0,.37,0]);
const upper = [], lower = [], hands = [], thighs = [], knees = [], feet = [];
for (const [i, sign] of [-1,1].entries()) {
  const side = i === 0 ? 'L' : 'R';
  upper[i] = joint(`UpperArm${side}`, spine, [sign*.3,.16,0]);
  lower[i] = joint(`Forearm${side}`, upper[i], [0,-.25,0]);
  hands[i] = joint(`Hand${side}`, lower[i], [0,-.22,0]);
  thighs[i] = joint(`Thigh${side}`, hips, [sign*.13,0,0]);
  knees[i] = joint(`Knee${side}`, thighs[i], [0,-.31,0]);
  feet[i] = joint(`Foot${side}`, knees[i], [0,-.33,0]);
}
function roundedBox(w,h,d,r=.04) {
  const shape = new T.Shape();
  shape.moveTo(-w/2+r,-h/2); shape.lineTo(w/2-r,-h/2);
  shape.quadraticCurveTo(w/2,-h/2,w/2,-h/2+r); shape.lineTo(w/2,h/2-r);
  shape.quadraticCurveTo(w/2,h/2,w/2-r,h/2); shape.lineTo(-w/2+r,h/2);
  shape.quadraticCurveTo(-w/2,h/2,-w/2,h/2-r); shape.lineTo(-w/2,-h/2+r);
  shape.quadraticCurveTo(-w/2,-h/2,-w/2+r,-h/2);
  const g = new T.ExtrudeGeometry(shape,{depth:d, bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.012,bevelThickness:.012,curveSegments:3});
  g.translate(0,0,-d/2); return g;
}
function part(geometry, bone, position, mat, scale=[1,1,1]) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.scale(...scale); g.translate(...position); g.clearGroups();
  const count=g.getAttribute('position').count, index=bones.indexOf(bone);
  const indices=new Uint16Array(count*4),weights=new Float32Array(count*4);
  for(let i=0;i<count;i++){indices[i*4]=index;weights[i*4]=1;}
  g.setAttribute('skinIndex',new T.Uint16BufferAttribute(indices,4));
  g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
  parts.push(g); groups.push(mat);
}
const at = (bone, x=0,y=0,z=0) => bindPositions[bones.indexOf(bone)].clone().add(new T.Vector3(x,y,z)).toArray();
part(roundedBox(.52,.53,.33,.08), spine, at(spine,0,-.06,0),0);
part(roundedBox(.50,.05,.32,.015), spine, at(spine,0,-.325,0),3);
part(roundedBox(.31,.13,.015,.025),spine,at(spine,0,-.20,-.18),0);
part(new T.TorusGeometry(.14,.045,4,10),spine,at(spine,0,.21,.02),0,[1,.8,1]);
// Hood folded behind the neck; the face has actual eyes, ears, nose and brows.
part(new T.SphereGeometry(.185,8,6),head,at(head,0,-.15,.10),0,[1,.7,.8]);
part(new T.CylinderGeometry(.075,.08,.12,8),head,at(head,0,-.23,0),1);
part(new T.SphereGeometry(.235,12,8),head,at(head),1,[.90,1.08,.82]);
part(new T.SphereGeometry(.235,12,6,0,Math.PI*2,0,Math.PI*.53),head,at(head,0,.055,.012),2,[.95,1.02,.92]);
part(roundedBox(.15,.10,.065,.015),head,at(head,-.08,.17,-.135),2);
for(const sign of [-1,1]) {
  part(new T.SphereGeometry(.043,6,4),head,at(head,sign*.208,-.015,0),1,[.65,1,.9]);
  part(new T.SphereGeometry(.036,8,6),head,at(head,sign*.078,.015,-.176),7,[1,1.12,.36]);
  part(new T.SphereGeometry(.020,6,4),head,at(head,sign*.078,.012,-.188),6,[.8,1,.28]);
  part(roundedBox(.060,.015,.012,.003),head,at(head,sign*.078,.070,-.177),2);
  part(new T.CylinderGeometry(.009,.009,.17,4),spine,at(spine,sign*.053,.075,-.19),7);
}
part(new T.SphereGeometry(.032,6,4),head,at(head,0,-.03,-.185),1,[.7,1,1]);
part(roundedBox(.075,.012,.012,.003),head,at(head,0,-.105,-.171),6);
for(let i=0;i<2;i++) {
  part(new T.CapsuleGeometry(.085,.12,3,6),upper[i],at(upper[i],0,-.10,0),0);
  part(new T.CapsuleGeometry(.078,.11,3,6),lower[i],at(lower[i],0,-.10,0),0);
  part(new T.CylinderGeometry(.079,.079,.045,6),lower[i],at(lower[i],0,-.205,0),3);
  part(roundedBox(.085,.11,.075,.025),hands[i],at(hands[i],0,-.025,-.01),1);
  part(new T.CapsuleGeometry(.093,.16,3,8),thighs[i],at(thighs[i],0,-.15,0),3);
  part(new T.CapsuleGeometry(.078,.19,3,8),knees[i],at(knees[i],0,-.16,0),3);
  part(roundedBox(.105,.14,.04,.012),thighs[i],at(thighs[i],i===0?-.07:.07,-.12,.035),3);
  part(roundedBox(.19,.12,.30,.035),feet[i],at(feet[i],0,-.055,-.06),4);
  part(roundedBox(.20,.034,.31,.012),feet[i],at(feet[i],0,-.107,-.06),7);
  part(roundedBox(.12,.016,.075,.006),feet[i],at(feet[i],0,.011,-.085),5);
}
const materialIndices=materials.map((_,i)=>i).filter(i=>groups.includes(i));
const geometry=mergeVertices(mergeGeometries(materialIndices.map(i=>mergeGeometries(parts.filter((_,j)=>groups[j]===i))),true));
geometry.groups.forEach((g,i)=>g.materialIndex=materialIndices[i]);
const mesh=new T.SkinnedMesh(geometry,materials); mesh.name='GenZBody';
root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new T.Skeleton(bones));

function accessory(name, bone) {const g=new T.Group();g.name=name;bone.add(g);return g;}
function deco(parent,g,m,pos,rot=[0,0,0]){const x=new T.Mesh(g,materials[m]);x.position.set(...pos);x.rotation.set(...rot);parent.add(x);return x;}
const cap=accessory('Cap',head);
deco(cap,new T.SphereGeometry(.241,10,5,0,Math.PI*2,0,Math.PI*.5),0,[0,.08,0]);
deco(cap,roundedBox(.29,.025,.19,.04),0,[0,.11,-.18]);
const beanie=accessory('Beanie',head);
deco(beanie,new T.SphereGeometry(.24,10,6,0,Math.PI*2,0,Math.PI*.55),5,[0,.085,0]);
deco(beanie,new T.TorusGeometry(.22,.03,4,12),5,[0,.09,0],[Math.PI/2,0,0]);
const phones=accessory('Headphones',head);
deco(phones,new T.TorusGeometry(.242,.025,4,12,Math.PI),6,[0,.07,0]);
for(const sign of [-1,1])deco(phones,roundedBox(.065,.14,.12,.02),5,[sign*.23,.005,0]);
const glasses=accessory('Glasses',head);
for(const sign of [-1,1])deco(glasses,new T.TorusGeometry(.063,.009,4,12),6,[sign*.077,.019,-.19]);
deco(glasses,roundedBox(.05,.014,.02,.003),6,[0,.024,-.19]);
const cig=accessory('Cigarette',hands[1]);
deco(cig,new T.CylinderGeometry(.012,.012,.17,6),7,[0,-.055,-.055],[Math.PI/2,0,0]);
deco(cig,new T.CylinderGeometry(.013,.013,.022,6),5,[0,-.055,-.145],[Math.PI/2,0,0]);
const wrench=accessory('Wrench',hands[1]);
deco(wrench,roundedBox(.035,.27,.028,.01),4,[0,-.095,-.01]);
deco(wrench,new T.TorusGeometry(.045,.014,4,8,Math.PI*1.5),4,[0,-.25,-.01]);

const times=[0,.25,.5,.75,1];
function rotationTrack(bone, poses) {
  return new T.QuaternionKeyframeTrack(`${bone.name}.quaternion`,times,poses.flatMap(p=>new T.Quaternion().setFromEuler(new T.Euler(...p)).toArray()));
}
function clip(name, rotations={}, height=.8) {
  const tracks=[new T.VectorKeyframeTrack('Hips.position',times,times.flatMap(()=>[0,height,0]))];
  for(const [name, poses] of Object.entries(rotations))tracks.push(rotationTrack(bones.find(b=>b.name===name),poses));
  // Every joint is keyed so crossfades do not retain the previous pose.
  for(const b of bones)if(!rotations[b.name])tracks.push(rotationTrack(b,times.map(()=>[0,0,0])));
  return new T.AnimationClip(name,1,tracks);
}
const steady=p=>times.map(()=>p), swing=(a,phase=0)=>times.map(t=>[Math.sin(t*Math.PI*2+phase)*a,0,0]);
const sit={ThighL:steady([1.45,0,0]),ThighR:steady([1.45,0,0]),KneeL:steady([-1.45,0,0]),KneeR:steady([-1.45,0,0])};
root.animations=[
  clip('idle',{Spine:swing(.022),Head:times.map(t=>[0,Math.sin(t*Math.PI*2)*.035,0]),UpperArmL:steady([0,0,-.08]),UpperArmR:steady([0,0,.08])}),
  clip('walk',{ThighL:swing(.52),ThighR:swing(.52,Math.PI),KneeL:times.map(t=>[-Math.max(0,Math.sin(t*Math.PI*2))*.65,0,0]),KneeR:times.map(t=>[-Math.max(0,-Math.sin(t*Math.PI*2))*.65,0,0]),UpperArmL:swing(.33,Math.PI),UpperArmR:swing(.33)}),
  clip('sit',sit,.62),
  clip('work',{...sit,Spine:steady([-.08,0,0]),UpperArmL:steady([.8,0,-.12]),UpperArmR:steady([.8,0,.12]),ForearmL:times.map(t=>[.35+Math.sin(t*Math.PI*4)*.04,0,0]),ForearmR:times.map(t=>[.35-Math.sin(t*Math.PI*4)*.04,0,0])},.62),
  clip('smoke',{UpperArmR:steady([1.75,0,.05]),ForearmR:steady([1.00,0,-.28]),Head:steady([-.05,0,.06])}),
  clip('repair',{Spine:steady([-.55,0,0]),ThighL:steady([.2,0,0]),ThighR:steady([.2,0,0]),KneeL:steady([-.3,0,0]),KneeR:steady([-.3,0,0]),UpperArmL:steady([.65,0,-.1]),UpperArmR:times.map(t=>[.65+Math.sin(t*Math.PI*2)*.16,0,.12]),ForearmR:steady([.2,0,0])},.72),
];
const buffer=await new GLTFExporter().parseAsync(root,{binary:true,onlyVisible:false,animations:root.animations});
const path=new URL('../src/lib/renderer/assets/gen-z-avatar.glb',import.meta.url);
await mkdir(new URL('../src/lib/renderer/assets/',import.meta.url),{recursive:true});
await writeFile(path,Buffer.from(buffer));
console.log(`Generated original rigged avatar: ${buffer.byteLength} bytes, ${geometry.index.count/3} body triangles, ${bones.length} joints, ${root.animations.length} clips.`);
