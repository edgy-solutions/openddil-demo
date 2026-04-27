import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const camera = new THREE.PerspectiveCamera();
camera.position.set(15, 12, 20);
const renderer = { domElement: { addEventListener: () => {}, removeEventListener: () => {} } };
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enabled = false;

camera.position.set(0, 0, 15);
controls.update();
console.log("camera.position:", camera.position);
