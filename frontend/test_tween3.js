import * as TWEEN from '@tweenjs/tween.js';
const group = new TWEEN.Group();
const obj = { x: 0 };
try {
  const t = new TWEEN.Tween(obj, group);
  console.log("Constructor accepted group");
} catch (e) {
  console.log("Error:", e.message);
}
