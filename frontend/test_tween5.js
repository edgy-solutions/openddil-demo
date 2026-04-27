import * as THREE from 'three';

const mesh = new THREE.Mesh();
mesh.position.set(-3.51, 0, -1);
mesh.rotation.set(0, -Math.PI / 2, 0);
mesh.updateMatrixWorld();

const targetPos = new THREE.Vector3();
mesh.getWorldPosition(targetPos);

const offset = new THREE.Vector3(0, 0, 5);
offset.applyQuaternion(mesh.quaternion);

const newCamPos = targetPos.clone().add(offset);
console.log("targetPos:", targetPos);
console.log("offset:", offset);
console.log("newCamPos:", newCamPos);
