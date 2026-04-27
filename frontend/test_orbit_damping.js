import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const camera = new THREE.PerspectiveCamera();
camera.position.set(15, 12, 20);
const renderer = { domElement: { addEventListener: () => {}, removeEventListener: () => {} } };
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.update();

// Simulate transition
controls.enabled = false;
controls.enableDamping = false;

camera.position.set(5, 5, 5);
controls.target.set(1, 1, 1);
controls.update();

console.log("camera.position after manual set and update:", camera.position);
